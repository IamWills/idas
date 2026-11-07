import { canonical, clone, IdasError, services, specification, id } from '@intent-driven/contracts';
import type { Json, Requirement, Snapshot, Specification } from '@intent-driven/contracts';
import { Registry, checkAbort } from './registry.js';
export { Registry } from './registry.js';
export type { Authorization } from './registry.js';

export interface Change {
  scope: string;
  base: number;
  spec: Specification;
  sections: (keyof Specification)[];
  bindings: { capability: string; plugin: string; version: string }[];
}
export interface Options { signal?: AbortSignal; timeoutMs?: number }
export interface EngineOptions {
  approve?: (change: Readonly<Change>, signal: AbortSignal) => boolean | Promise<boolean>;
  maxTimeoutMs?: number;
}
const req = (id: string): Requirement => ({ id, range: '^1.0.0' });
const decode = <T>(v: Json): T => v as T; // Internal service results are from host-trusted plugins.
const own = (object: object, key: string) => Object.hasOwn(object, key);

export class Engine {
  #busy = new Set<string>();
  #previews = new WeakMap<Change, string>();
  constructor(readonly registry: Registry, private readonly options: EngineOptions = {}) {}
  #run<T>(scope: string, options: Options, work: (signal: AbortSignal, expire: () => void) => Promise<T>): Promise<T> {
    if (!id.safeParse(scope).success) return Promise.reject(new IdasError('INVALID', 'Invalid scope'));
    if (this.#busy.has(scope)) return Promise.reject(new IdasError('CONFLICT', 'Another operation is active in ' + scope));
    this.#busy.add(scope);
    const controller = new AbortController();
    const abort = () => controller.abort(new IdasError('CANCELLED', 'Operation cancelled'));
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const max = Math.min(options.timeoutMs ?? Infinity, this.options.maxTimeoutMs ?? 30000, 120000);
    const expire = () => controller.abort(new IdasError('TIMEOUT', 'Operation timed out'));
    const timer = setTimeout(expire, Number.isFinite(max) && max > 0 ? max : 1);
    return new Promise<T>((resolve, reject) => {
      const cancelled = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', cancelled, { once: true });
      const finish = () => {
        clearTimeout(timer); this.#busy.delete(scope); options.signal?.removeEventListener('abort', abort);
        controller.signal.removeEventListener('abort', cancelled);
      };
      void this.registry.withLease(async () => {
        checkAbort(controller.signal);
        return work(controller.signal, expire);
      }).then(value => { finish(); resolve(value); }, error => { finish(); reject(error); });
    });
  }
  #call(service: string, input: unknown, scope: string, signal: AbortSignal, op = service): Promise<Json> {
    return this.registry.invoke(req(service), clone(input), scope, signal, canonical([scope, op]));
  }
  #read(scope: string, signal: AbortSignal) {
    return this.#call(services.state, { action: 'read', scope }, scope, signal).then(decode<Snapshot | null>);
  }
  async #inspect(candidate: unknown, scope: string, current: Snapshot | null, signal: AbortSignal): Promise<Change> {
    const validated = await this.#call(services.specification, candidate, scope, signal);
    const parsed = specification.safeParse(validated);
    if (!parsed.success) throw new IdasError('INVALID', parsed.error.message);
    const spec = parsed.data;
    if (spec.intent.scope !== scope) throw new IdasError('DENIED', 'Specification cannot change its scope');
    const resolved = await this.#call(services.resolver, { requirements: spec.capabilities, scope }, scope, signal);
    const bindings = spec.capabilities.map(r => ({ capability: r.id, ...this.registry.inspect(r, scope) }));
    if (canonical(resolved) !== canonical(bindings)) throw new IdasError('INVALID', 'Resolver returned bindings different from the authorized runtime');
    const previous = current?.spec;
    return { scope, base: current?.revision ?? 0, spec, bindings,
      sections: (Object.keys(spec) as (keyof Specification)[]).filter(k => !previous || canonical(previous[k]) !== canonical(spec[k])) };
  }
  preview(scope: string, text: string, context: Json = null, options: Options = {}): Promise<Change> {
    return this.#run(scope, options, async signal => {
      if (typeof text !== 'string' || !text.trim() || text.length > 4000) throw new IdasError('INVALID', 'Intent must contain 1–4000 characters');
      const current = await this.#read(scope, signal);
      const candidate = await this.#call(services.compiler, { text, context, scope, previous: current?.spec ?? null }, scope, signal);
      return this.#issue(await this.#inspect(candidate, scope, current, signal));
    });
  }
  previewSpec(scope: string, candidate: unknown, options: Options = {}): Promise<Change> {
    return this.#run(scope, options, async signal => this.#issue(await this.#inspect(candidate, scope, await this.#read(scope, signal), signal)));
  }
  #issue(change: Change): Change { this.#previews.set(change, canonical(change)); return change; }
  async #approve(change: Change, signal: AbortSignal): Promise<void> {
    const allowed = await this.#call(services.policy, change, change.scope, signal);
    if (allowed !== true) throw new IdasError('DENIED', 'Host policy rejected the change');
    if (this.options.approve || change.spec.policy.approval) {
      if (!await this.options.approve?.(structuredClone(change), signal)) throw new IdasError('DENIED', 'Change requires host approval');
    }
    checkAbort(signal);
  }
  async #write(scope: string, expected: number, next: Snapshot, signal: AbortSignal): Promise<Snapshot> {
    checkAbort(signal);
    const ok = await this.#call(services.state, { action: 'write', scope, expected, next }, scope, signal);
    if (ok !== true) throw new IdasError('CONFLICT', 'Workspace revision changed');
    return next;
  }
  apply(change: Change, options: Options = {}): Promise<Snapshot> {
    return this.#run(change.scope, options, async signal => {
      if (this.#previews.get(change) !== canonical(change)) throw new IdasError('INVALID', 'Use an unchanged preview from this engine');
      const current = await this.#read(change.scope, signal);
      if ((current?.revision ?? 0) !== change.base) throw new IdasError('CONFLICT', 'Preview is stale');
      const fresh = await this.#inspect(change.spec, change.scope, current, signal);
      if (canonical(fresh) !== canonical(change)) throw new IdasError('CONFLICT', 'Preview bindings changed');
      await this.#approve(fresh, signal);
      const { spec, scope, base } = fresh;
      await this.#call(services.composer, spec, scope, signal);
      const data = { ...spec.state.initial };
      if (current) {
        if (spec.state.version < current.spec.state.version) throw new IdasError('INVALID', 'Use rollback to downgrade state');
        const sameVersion = spec.state.version === current.spec.state.version;
        for (const key of Object.keys(data)) if (sameVersion && own(current.data, key)) data[key] = current.data[key]!;
        if (!sameVersion) for (const [from, to] of Object.entries(spec.state.rename ?? {})) {
          if (own(current.data, from) && own(data, to)) data[to] = current.data[from]!;
        }
      }
      const mode = current && spec.interaction.states.includes(current.mode) ? current.mode : spec.interaction.initial;
      return this.#write(scope, base, { revision: base + 1, spec, data, mode, receipts: current?.receipts ?? [] }, signal);
    });
  }
  snapshot(scope: string, options: Options = {}): Promise<Snapshot | null> { return this.#run(scope, options, signal => this.#read(scope, signal)); }
  view(scope: string, options: Options = {}): Promise<Json> {
    return this.#run(scope, options, async signal => {
      const current = await this.#read(scope, signal);
      if (!current) throw new IdasError('MISSING', 'Workspace has no specification');
      return this.#call(services.composer, current.spec, scope, signal);
    });
  }
  suggest(scope: string, requirement: Requirement, options: Options = {}): Promise<Json> {
    return this.#run(scope, options, signal => this.#call(services.evolution, requirement, scope, signal));
  }
  rollback(scope: string, revision: number, options: Options = {}): Promise<Snapshot> {
    return this.#run(scope, options, async signal => {
      const current = await this.#read(scope, signal);
      const history = decode<Snapshot[]>(await this.#call(services.state, { action: 'history', scope }, scope, signal));
      const target = history.find(x => x.revision === revision);
      if (!current || !target) throw new IdasError('MISSING', 'Revision unavailable');
      const change = await this.#inspect(target.spec, scope, current, signal);
      await this.#approve(change, signal);
      await this.#call(services.composer, change.spec, scope, signal);
      return this.#write(scope, current.revision, { ...target, spec: change.spec, revision: current.revision + 1, receipts: current.receipts }, signal);
    });
  }
  dispatch(scope: string, event: string, input: Json, eventId: string, options: Options = {}): Promise<Snapshot> {
    return this.#run(scope, options, async (signal, expire) => {
      if (!id.safeParse(event).success || !id.safeParse(eventId).success) throw new IdasError('INVALID', 'Invalid event or event ID');
      const current = await this.#read(scope, signal);
      if (!current) throw new IdasError('MISSING', 'Workspace has no specification');
      const fingerprint = canonical([event, input]);
      if (fingerprint.length > 4096) throw new IdasError('INVALID', 'Event payload exceeds size limit');
      const previous = current.receipts.find(x => x.id === eventId);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new IdasError('CONFLICT', 'Event ID already used for different input');
        return current;
      }
      const timeout = setTimeout(expire, current.spec.policy.timeoutMs);
      try {
        const auth = await this.#call(services.policy, { action: 'dispatch', scope, event, spec: current.spec }, scope, signal);
        if (auth !== true) throw new IdasError('DENIED', 'Host policy rejected the event');
        const next = decode<{ data: Snapshot['data']; mode: string; workflow?: string }>(
          await this.#call(services.interaction, { current, event, input }, scope, signal, eventId));
        const data = next.workflow ? decode<Snapshot['data']>(await this.#call(services.workflow,
          { workflow: next.workflow, spec: current.spec, data: next.data, scope }, scope, signal, eventId)) : next.data;
        return await this.#write(scope, current.revision, { ...current, data, mode: next.mode,
          revision: current.revision + 1, receipts: [...current.receipts.slice(-99), { id: eventId, fingerprint }] }, signal);
      } finally { clearTimeout(timeout); }
    });
  }
}
