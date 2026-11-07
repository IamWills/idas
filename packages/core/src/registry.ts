import { clone, IdasError, pluginManifest } from '@intent-driven/contracts';
import type { Json, Plugin, PluginManifest, Requirement, Trace } from '@intent-driven/contracts';
import semver from 'semver';

type Entry = { manifest: PluginManifest; plugin: Plugin };
type Binding = { entry: Entry; version: string };
export type Authorization = (permission: string, plugin: string, scope: string) => boolean;
export const checkAbort = (signal: AbortSignal) => {
  if (signal.aborted) throw signal.reason instanceof IdasError ? signal.reason : new IdasError('CANCELLED', 'Operation cancelled');
};
const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const pluginError = (message: string, cause: unknown) => cause instanceof IdasError ? cause : new IdasError('PLUGIN', message, { cause });

export class Registry {
  #entries = new Map<string, Entry>();
  #active = 0;
  #mutating = false;
  constructor(readonly environment: string, private readonly authorize: Authorization = () => false,
    private readonly observer: (event: Trace) => void = () => {}) {}
  trace(event: Trace): void { try { this.observer(event); } catch { /* instrumentation is best effort */ } }
  manifests(): PluginManifest[] { return [...this.#entries.values()].map(e => pluginManifest.parse(clone(e.manifest))); }
  async load(factory: () => Plugin | Promise<Plugin>): Promise<void> {
    if (this.#active || this.#mutating) throw new IdasError('CONFLICT', 'Registry is in use');
    this.#mutating = true;
    try {
      const plugin = await factory();
      const manifest = pluginManifest.parse(clone(plugin.manifest));
      if (this.#entries.has(manifest.id)) throw new IdasError('CONFLICT', 'Plugin is already registered');
      if (!semver.valid(manifest.version) || manifest.provides.some(x => !semver.valid(x.version)) ||
          manifest.requires.some(x => !semver.validRange(x.range)) ||
          new Set(manifest.provides.map(x => x.id)).size !== manifest.provides.length) throw new IdasError('INVALID', 'Invalid plugin versions or capabilities');
      if (!manifest.environments.includes('any') && !manifest.environments.includes(this.environment)) throw new IdasError('INVALID', 'Incompatible environment');
      try { await plugin.start?.(); } catch (e) {
        try { await plugin.stop?.(); } catch { this.trace({ type: 'cleanup-failed', plugin: manifest.id }); }
        throw e;
      }
      this.#entries.set(manifest.id, { manifest, plugin });
      this.trace({ type: 'loaded', plugin: manifest.id });
    } catch (e) { throw pluginError('Plugin failed to load', e); }
    finally { this.#mutating = false; }
  }
  async unload(id: string): Promise<void> {
    if (this.#active || this.#mutating) throw new IdasError('CONFLICT', 'Registry is in use');
    const entry = this.#entries.get(id);
    if (!entry) throw new IdasError('MISSING', 'Plugin not found');
    this.#mutating = true;
    this.#entries.delete(id);
    try { await entry.plugin.stop?.(); }
    catch (e) { throw pluginError('Plugin stopped with an error', e); }
    finally { this.#mutating = false; this.trace({ type: 'unloaded', plugin: id }); }
  }
  #resolve(requirement: Requirement, scope: string, path: string[] = [], budget = { remaining: 2000 }): Binding {
    if (--budget.remaining < 0 || path.length > 32) throw new IdasError('INVALID', 'Capability dependency search exceeded limits');
    if (!semver.validRange(requirement.range)) throw new IdasError('INVALID', 'Invalid version range for ' + requirement.id);
    const candidates = [...this.#entries.values()].flatMap(entry => entry.manifest.provides
      .filter(p => p.id === requirement.id && semver.satisfies(p.version, requirement.range))
      .map(p => ({ entry, version: p.version })));
    candidates.sort((a, b) => semver.rcompare(a.version, b.version) || order(a.entry.manifest.id, b.entry.manifest.id));
    let failure: IdasError | undefined;
    for (const candidate of candidates) {
      const m = candidate.entry.manifest;
      if (path.includes(m.id)) { failure ??= new IdasError('INVALID', 'Cyclic dependency: ' + [...path, m.id].join(' → ')); continue; }
      if (m.permissions.some(p => !this.authorize(p, m.id, scope))) {
        failure = new IdasError('DENIED', 'Host grants do not allow ' + m.id + ' in ' + scope); continue;
      }
      try { for (const d of m.requires) this.#resolve(d, scope, [...path, m.id], budget); return candidate; }
      catch (e) { if (!(e instanceof IdasError)) throw e; failure ??= e; }
    }
    throw failure ?? new IdasError('MISSING', 'No compatible provider for ' + requirement.id + '@' + requirement.range);
  }
  inspect(requirement: Requirement, scope: string): { plugin: string; version: string } {
    const b = this.#resolve(requirement, scope);
    return { plugin: b.entry.manifest.id, version: b.version };
  }
  async withLease<T>(run: () => Promise<T>): Promise<T> {
    if (this.#mutating) throw new IdasError('CONFLICT', 'Registry is changing');
    ++this.#active;
    try { return await run(); } finally { --this.#active; }
  }
  async invoke(req: Requirement, input: Json, scope: string, signal: AbortSignal, operation: string): Promise<Json> {
    return this.withLease(() => this.#invoke(req, input, scope, signal, operation, []));
  }
  async #invoke(req: Requirement, input: Json, scope: string, signal: AbortSignal, operation: string, path: string[]): Promise<Json> {
    checkAbort(signal);
    const { entry } = this.#resolve(req, scope, path);
    const m = entry.manifest;
    const start = Date.now();
    let live = true;
    const pending: Promise<Json>[] = [];
    try {
      const output = await entry.plugin.invoke(req.id, clone(input), {
        signal, operation,
        call: (dep, data) => {
          if (!live) throw new IdasError('CANCELLED', 'Invocation has ended');
          const declared = m.requires.find(d => d.id === dep.id && d.range === dep.range);
          if (!declared) throw new IdasError('DENIED', 'Undeclared dependency ' + dep.id);
          if (pending.length >= 100) throw new IdasError('DENIED', 'Plugin dependency call limit exceeded');
          const call = this.#invoke(declared, data, scope, signal, operation, [...path, m.id]);
          void call.catch(() => {}); pending.push(call); return call;
        },
      });
      checkAbort(signal);
      return clone(output);
    } catch (cause) {
      const e = pluginError('Plugin invocation failed: ' + m.id, cause);
      this.trace({ type: 'error', operation, capability: req.id, plugin: m.id, code: e.code });
      throw e;
    } finally {
      live = false;
      await Promise.allSettled(pending);
      this.trace({ type: 'invoked', operation, capability: req.id, plugin: m.id, durationMs: Date.now() - start });
    }
  }
}
