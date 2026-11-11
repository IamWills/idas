import { bindingValue, canonical, clone, componentContract, componentProps, findForm, IdasError, jsonSchema, modelRequest, services, validateFormPayload } from '@intent-driven/contracts';
import type { Component, ComponentContract, Json, Plugin, Snapshot, Store, Specification, Requirement, Invocation, StateBinding } from '@intent-driven/contracts';
import { orderedTasks, validate } from './spec.js';
export { migrate, validate } from './spec.js';

const copy = <T>(value: T): T => clone(value) as T;
export const memoryStore = (): Store => {
  const all = new Map<string, Snapshot[]>();
  return {
    async read(scope) { return copy(all.get(scope)?.at(-1) ?? null); },
    async history(scope) { return copy(all.get(scope) ?? []); },
    async compareAndSwap(scope, expected, next, signal) {
      signal?.throwIfAborted();
      const items = all.get(scope) ?? [];
      if ((items.at(-1)?.revision ?? 0) !== expected) return false;
      all.set(scope, [...items.slice(-19), copy(next)]);
      return true;
    },
  };
};
export interface StandardOptions {
  store?: Store;
  resolve(requirement: Requirement, scope: string): { plugin: string; version: string };
  tool(requirement: Requirement, input: Json, scope: string, signal: AbortSignal, operation: string): Promise<Json>;
  policy?: (request: Json, signal: AbortSignal) => boolean | Promise<boolean>;
  compiler?: (input: CompileInput, invocation: Invocation) => unknown | Promise<unknown>;
}
export function standard(options: StandardOptions): Plugin {
  const store = options.store ?? memoryStore();
  const memory = memoryStore();
  const names = [services.specification, services.resolver, services.state, services.policy, services.composer,
    services.interaction, services.workflow, services.compiler, services.evolution];
  async function checkComponents(spec: Specification, data: Snapshot['data'], ctx: Invocation) {
    const contracts = new Map<string, ComponentContract>();
    async function visit(node: Component): Promise<void> {
      if (node.kind === 'layout') for (const child of node.children) await visit(child);
      if (node.kind !== 'plugin') return;
      const key = node.capability + '@' + node.version;
      let contract = contracts.get(key);
      if (!contract) {
        const description = await options.tool({ id: node.capability, range: node.version }, { action: 'describe' },
          spec.intent.scope, ctx.signal, ctx.operation);
        const parsed = componentContract.safeParse(description);
        if (!parsed.success) throw new IdasError('INVALID', 'Invalid component contract for ' + key);
        contract = parsed.data;
        contracts.set(key, contract);
      }
      componentProps(node, contract, data);
    }
    for (const view of spec.ui.views) for (const node of view.components) await visit(node);
  }
  return {
    manifest: { id: 'idas.standard', version: '1.0.0', environments: ['any'], requires: [], permissions: [],
      provides: names.map(id => ({ id, version: '1.0.0' })) },
    async invoke(id, input, ctx) {
      if (id === services.specification) return clone(validate(input));
      if (id === services.compiler) return clone(await (options.compiler ?? compileOffline)(input as unknown as CompileInput, ctx));
      if (id === services.resolver) {
        const { requirements, scope } = input as unknown as { requirements: Requirement[]; scope: string };
        return requirements.map(r => ({ capability: r.id, ...options.resolve(r, scope) }));
      }
      if (id === services.policy) return await options.policy?.(input, ctx.signal) ?? true;
      if (id === services.composer) {
        const spec = validate(input);
        await checkComponents(spec, spec.state.initial, ctx);
        return clone(spec.ui);
      }
      if (id === services.evolution) {
        const r = input as unknown as Requirement;
        return { requirement: clone(r), status: 'proposal', next: ['Find or implement a matching plugin', 'Run isolated contract tests', 'Request host approval'] };
      }
      if (id === services.state) {
        const request = input as unknown as { action: string; scope: string; expected: number; next: Snapshot };
        const { scope } = request;
        const durable = await store.read(scope);
        const volatile = await memory.read(scope);
        const current = volatile ?? durable;
        if (request.action === 'read') return clone(current);
        if (request.action === 'history') return clone(volatile ? await memory.history(scope) : await store.history(scope));
        if (request.action === 'write') {
          if ((current?.revision ?? 0) !== request.expected) return false;
          if (current && current.spec.state.persistent !== request.next.spec.state.persistent) {
            throw new IdasError('INVALID', 'Persistence mode cannot change for an existing workspace');
          }
          ctx.signal.throwIfAborted();
          await checkComponents(request.next.spec, request.next.data, ctx);
          return (request.next.spec.state.persistent ? store : memory).compareAndSwap(scope, request.expected, request.next, ctx.signal);
        }
      }
      if (id === services.interaction) {
        const { current, event, input: payload } = input as unknown as { current: Snapshot; event: string; input: Json };
        const rule = current.spec.interaction.rules.find(r => r.from === current.mode && r.event === event);
        if (!rule) throw new IdasError('INVALID', 'Event ' + event + ' is not available in ' + current.mode);
        if (rule.input?.kind === 'text' && (typeof payload !== 'string' || payload.length < rule.input.minLength || payload.length > rule.input.maxLength)) {
          throw new IdasError('INVALID', 'Event ' + event + ' requires text of length ' + rule.input.minLength + '–' + rule.input.maxLength);
        }
        if (rule.input?.kind === 'form') {
          const form = findForm(current.spec.ui, rule.input.id);
          if (!form) throw new IdasError('INVALID', 'Missing form contract');
          validateFormPayload(form, payload);
        }
        const data = { ...current.data };
        for (const write of rule.set ?? []) data[write.key] = write.value;
        if (rule.capture) data[rule.capture] = payload;
        return { data, mode: rule.to, ...(rule.workflow ? { workflow: rule.workflow } : {}) };
      }
      if (id === services.workflow) {
        const { workflow, spec, data, scope } = input as unknown as {
          workflow: string; spec: Specification; data: Snapshot['data']; scope: string;
        };
        const tasks = validate(spec).workflows.find(w => w.id === workflow)?.tasks;
        if (!tasks) throw new IdasError('INVALID', 'Unknown workflow: ' + workflow);
        const next = { ...data };
        const skipped = new Set<string>();
        for (const task of orderedTasks(tasks)) {
          ctx.signal.throwIfAborted();
          if (task.after?.some(d => skipped.has(d)) ||
            (task.when && canonical(next[task.when.key]) !== canonical(task.when.equals))) { skipped.add(task.id); continue; }
          const requirement = spec.capabilities.find(c => c.id === task.capability)!;
          let taskInput = task.input;
          const readBinding = (binding: StateBinding) => {
            const value = bindingValue(next, binding);
            if (value === undefined) throw new IdasError('INVALID', 'Missing input binding for task ' + task.id);
            return value;
          };
          if (task.inputFrom) taskInput = readBinding(task.inputFrom);
          if (task.inputBindings) {
            taskInput = Object.fromEntries(Object.entries(task.inputBindings).map(([key, binding]) => [key, readBinding(binding)]));
          }
          const output = await options.tool(requirement, taskInput, scope, ctx.signal, canonical([ctx.operation, workflow, task.id]));
          if (task.saveAs) next[task.saveAs] = output;
        }
        return next;
      }
      throw new IdasError('MISSING', 'Unknown standard capability: ' + id);
    },
  };
}

export interface CompileInput { text: string; scope: string; context: Json; previous: Specification | null }
export function compileOffline({ text, scope, context, previous }: CompileInput): Specification {
  const spec: Specification = previous ? copy(previous) : {
    intent: { goal: text, scope, context, constraints: [] },
    ui: { layout: 'stack', columns: 1, collapseBelow: 640, theme: 'system', views: [
      { id: 'workspace', title: 'Workspace', components: [
        { id: 'status', kind: 'value', label: 'Status', state: 'status' },
        { id: 'note', kind: 'input', label: 'Note', state: 'note', event: 'note' },
        { id: 'run', kind: 'button', label: 'Run workflow', event: 'run' },
      ] },
      { id: 'output', title: 'Results', components: [{ id: 'result', kind: 'value', label: 'Result', state: 'result' }] },
    ] },
    interaction: { initial: 'ready', states: ['ready'], rules: [
      { from: 'ready', to: 'ready', event: 'note', capture: 'note' },
      { from: 'ready', to: 'ready', event: 'run', set: [{ key: 'status', value: 'Done' }] },
    ] },
    workflows: [], capabilities: [], policy: { approval: false, timeoutMs: 5000 },
    state: { initial: { status: 'Ready', note: '', result: '' }, persistent: true, version: 1 },
    metadata: { schemaVersion: 1, source: 'offline', changes: [], compatibleWith: 'IDSS/1' },
  };
  let matched = false;
  const columns = text.match(/\b([1-4])\s*[- ]?columns?\b|([一二两三四1-4])\s*列/i);
  if (columns) {
    const n = columns[1] ?? columns[2]!;
    spec.ui.columns = Number(n) || '一二三四'.indexOf(n === '两' ? '二' : n) + 1;
    spec.ui.layout = spec.ui.columns === 1 ? 'stack' : 'grid'; matched = true;
  } else if (/\bstack(?:ed)?\b|单列|纵向/i.test(text)) {
    spec.ui.layout = 'stack'; spec.ui.columns = 1; matched = true;
  }
  if (/\bdark\b|深色|暗色/i.test(text)) { spec.ui.theme = 'dark'; matched = true; }
  else if (/\blight\b|浅色/i.test(text)) { spec.ui.theme = 'light'; matched = true; }
  const status = text.match(/(?:status\s+(?:to|as)|状态(?:设为|改成))\s*["“]([^"”]+)["”]/i);
  const echo = text.match(/(?:workflow\s+echo|工作流回显)\s*["“]([^"”]+)["”]/i);
  const run = spec.interaction.rules.find(r => r.event === 'run');
  if (status && run) { run.set = [{ key: 'status', value: status[1]! }]; matched = true; }
  if (echo && run) {
    spec.capabilities = spec.capabilities.filter(c => c.id !== 'example.echo').concat({ id: 'example.echo', range: '^1.0.0' });
    spec.workflows = spec.workflows.filter(w => w.id !== 'echo').concat({
      id: 'echo', tasks: [{ id: 'emit', capability: 'example.echo', input: echo[1]!, saveAs: 'result' }],
    });
    run.workflow = 'echo'; matched = true;
  }
  if (!matched) throw new IdasError('INVALID', 'Offline compiler: try "use 2 columns", "dark mode", "set status to \"Done\"" or "workflow echo \"hello\"".');
  spec.intent = { ...spec.intent, goal: text, context, scope };
  spec.metadata = { ...spec.metadata, source: 'offline', changes: [...spec.metadata.changes.slice(-19), text.slice(0, 1000)] };
  return spec;
}

export function echoPlugin(): Plugin {
  return { manifest: { id: 'example.echo', version: '1.0.0', environments: ['any'], requires: [], permissions: [],
    provides: [{ id: 'example.echo', version: '1.0.0' }] }, invoke: (_id, input) => input };
}

/** Model providers implement the declared JSON-in/JSON-out capability. No SDK or credentials enter Core. */
export function modelCompiler(model: Requirement = { id: services.model, range: '^1.0.0' }, options: {
  repair?: boolean;
  available?: (scope: string) => { id: string; version: string }[];
} = {}): Plugin {
  const repair = options.repair === true;
  const available = options.available;
  const schema = available ? jsonSchema() : null;
  return {
    manifest: { id: 'idas.compiler.model', version: '1.0.0', environments: ['any'], requires: [model], permissions: [],
      provides: [{ id: services.compiler, version: '1.1.0' }] },
    async invoke(_id, input, ctx) {
      let request = input;
      if (available) {
        const { scope } = input as unknown as CompileInput;
        const parsed = modelRequest.safeParse({ ...(input as object), schema, available: available(scope) });
        if (!parsed.success) throw new IdasError('INVALID', 'Invalid structured model request');
        request = clone(parsed.data);
      }
      const candidate = await ctx.call(model, request);
      try {
        return clone(validate(candidate));
      } catch (error) {
        if (!repair || !(error instanceof IdasError) || error.code !== 'INVALID') throw error;
        if (request === null || typeof request !== 'object' || Array.isArray(request)) throw error;
        const corrected = await ctx.call(model, { ...request, repair: { message: error.message.slice(0, 4000) } });
        return clone(validate(corrected));
      }
    },
  };
}

export { diffSpecification } from './diff.js';
