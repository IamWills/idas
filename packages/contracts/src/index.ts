import { z } from 'zod';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export const id = z.string().regex(/^(?!(?:constructor|prototype)$)[a-zA-Z][a-zA-Z0-9._-]{0,95}$/);
const identifier = id;
export const json = z.json() as z.ZodType<Json>;
const obj = z.strictObject;
const short = z.string().max(1000);
export const capability = obj({ id: identifier, range: z.string().min(1).max(128) });
const legacyComponent = obj({
  id: identifier, kind: z.enum(['text', 'button', 'input', 'value']), label: short,
  event: identifier.optional(), state: identifier.optional(),
  modes: z.array(identifier).min(1).max(100).optional(),
  multiline: z.boolean().optional(),
});
const componentCapability = identifier.refine(value => value.startsWith('ui.') && value.length > 3);
const componentVersion = z.string().max(128).regex(/^\d+\.\d+\.\d+$/);
const pathSegment = z.union([identifier, z.string().regex(/^(0|[1-9]\d{0,8})$/)]);
export const stateBinding = z.union([identifier, obj({ state: identifier, path: z.array(pathSegment).min(1).max(12) })]);
export type StateBinding = z.infer<typeof stateBinding>;
export const bindingRoot = (binding: StateBinding) => typeof binding === 'string' ? binding : binding.state;
export function bindingValue(data: Record<string, Json>, binding: StateBinding): Json | undefined {
  const root = bindingRoot(binding);
  let value = Object.hasOwn(data, root) ? data[root] : undefined;
  if (typeof binding === 'string') return value;
  for (const segment of binding.path) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, segment)) return undefined;
    if (Array.isArray(value)) {
      if (!/^(0|[1-9]\d{0,8})$/.test(segment)) return undefined;
      value = value[Number(segment)];
    } else value = value[segment];
  }
  return value;
}
const fieldBase = { id: identifier, label: short, required: z.boolean().optional(), binding: stateBinding.optional() };
const formField = z.discriminatedUnion('kind', [
  obj({ ...fieldBase, kind: z.literal('text'), minLength: z.number().int().min(0).max(1000).optional(),
    maxLength: z.number().int().min(1).max(1000).optional() }),
  obj({ ...fieldBase, kind: z.literal('number'), min: z.number().optional(), max: z.number().optional() }),
  obj({ ...fieldBase, kind: z.literal('boolean') }),
  obj({ ...fieldBase, kind: z.literal('choice'), options: z.array(obj({ value: identifier, label: short })).min(1).max(30) }),
]);
const formComponent = obj({
  id: identifier, label: short, kind: z.literal('form'), event: identifier,
  fields: z.array(formField).min(1).max(20), modes: z.array(identifier).min(1).max(100).optional(),
});
export type FormComponent = z.infer<typeof formComponent>;
export type FormField = z.infer<typeof formField>;
const pluginComponent = obj({
  id: identifier, label: short, kind: z.literal('plugin'),
  capability: componentCapability, version: componentVersion,
  props: z.record(identifier, json).optional(),
  bindings: z.record(identifier, stateBinding).optional(),
  event: identifier.optional(),
  modes: z.array(identifier).min(1).max(100).optional(),
});
export type PluginComponent = z.infer<typeof pluginComponent>;
export type Component = z.infer<typeof legacyComponent> | PluginComponent | FormComponent | {
  id: string; label: string; kind: 'layout'; layout: 'stack' | 'row' | 'grid';
  columns?: number | undefined; modes?: string[] | undefined; children: Component[];
};
const component: z.ZodType<Component> = z.lazy(() => z.union([
  legacyComponent, pluginComponent, formComponent, obj({
    id: identifier, label: short, kind: z.literal('layout'), layout: z.enum(['stack', 'row', 'grid']),
    columns: z.number().int().min(1).max(4).optional(),
    modes: z.array(identifier).min(1).max(100).optional(),
    children: z.array(component).max(100),
  }),
]));

export const componentContract = obj({
  properties: z.record(identifier, obj({
    kind: z.enum(['string', 'number', 'boolean', 'json']), required: z.boolean().optional(),
  })),
  emitsEvent: z.boolean().optional(),
});
export type ComponentContract = z.infer<typeof componentContract>;

/** Resolve a snapshot's bindings and check the complete property object. */
export function componentProps(node: PluginComponent, contract: ComponentContract, data: Record<string, Json>): Record<string, Json> {
  const props = { ...node.props };
  for (const [key, state] of Object.entries(node.bindings ?? {})) {
    const value = bindingValue(data, state);
    if (Object.hasOwn(props, key) || value === undefined) throw new IdasError('INVALID', 'Invalid binding for ' + node.id + '.' + key);
    props[key] = value;
  }
  if (node.event && !contract.emitsEvent) throw new IdasError('INVALID', 'Component cannot emit an event: ' + node.id);
  for (const [key, value] of Object.entries(props)) {
    const property = Object.hasOwn(contract.properties, key) ? contract.properties[key] : undefined;
    if (!property || (property.kind !== 'json' && typeof value !== property.kind)) {
      throw new IdasError('INVALID', 'Invalid property ' + node.id + '.' + key);
    }
  }
  for (const [key, property] of Object.entries(contract.properties)) {
    if (property.required && !Object.hasOwn(props, key)) throw new IdasError('INVALID', 'Missing property ' + node.id + '.' + key);
  }
  return clone(props) as Record<string, Json>;
}
const rule = obj({ event: identifier, from: identifier, to: identifier,
  set: z.array(obj({ key: identifier, value: json })).max(100).optional(),
  capture: identifier.optional(), workflow: identifier.optional(),
  input: z.discriminatedUnion('kind', [
    obj({ kind: z.literal('text'), minLength: z.number().int().min(0).max(1000), maxLength: z.number().int().min(1).max(1000) }),
    obj({ kind: z.literal('form'), id: identifier }),
  ]).optional() });
const task = obj({ id: identifier, capability: identifier, input: json, after: z.array(identifier).max(100).optional(),
  when: obj({ key: identifier, equals: json }).optional(), saveAs: identifier.optional(),
  inputFrom: stateBinding.optional(), inputBindings: z.record(identifier, stateBinding).optional() });
export const specification = obj({
  intent: obj({ goal: z.string().min(1).max(4000), constraints: z.array(short).max(100), context: json, scope: identifier }),
  ui: obj({ layout: z.enum(['stack', 'grid']), columns: z.number().int().min(1).max(4), collapseBelow: z.number().int().min(320).max(1600),
    theme: z.enum(['light', 'dark', 'system']), views: z.array(obj({ id: identifier, title: short, components: z.array(component).max(100) })).min(1).max(20),
    presentation: obj({
      wide: z.array(z.array(identifier).min(1).max(4)).min(1).max(20),
      compact: z.array(identifier).min(1).max(20),
      compactMode: z.enum(['stack', 'pages']).optional(),
    }).optional(),
    navigation: obj({
      initial: identifier,
      routes: z.array(obj({ from: identifier, to: identifier })).max(380),
    }).optional(),
  }),
  interaction: obj({ initial: identifier, states: z.array(identifier).min(1).max(100), rules: z.array(rule).max(200) }),
  workflows: z.array(obj({ id: identifier, tasks: z.array(task).max(100) })).max(30),
  capabilities: z.array(capability).max(100),
  policy: obj({ approval: z.boolean(), timeoutMs: z.number().int().min(10).max(120000) }),
  state: obj({ initial: z.record(identifier, json), persistent: z.boolean(), version: z.number().int().min(1),
    rename: z.record(identifier, identifier).optional() }),
  metadata: obj({ schemaVersion: z.literal(1), source: short, changes: z.array(short).max(100), compatibleWith: z.literal('IDSS/1').optional() }),
});
export type Specification = z.infer<typeof specification>;
export type Requirement = z.infer<typeof capability>;
export function workspaceNavigation(ui: Specification['ui'], active: string) {
  const order = ui.presentation?.compact ?? ui.views.map(view => view.id);
  const selected = order.includes(active) ? active : ui.navigation?.initial ?? order[0];
  const graph = ui.navigation;
  const reachable = graph ? order.filter(id => id === selected || graph.routes.some(edge => edge.from === selected && edge.to === id)) : order;
  return { selected, reachable };
}
export function findForm(ui: Specification['ui'], formId: string): FormComponent | undefined {
  function search(nodes: Component[]): FormComponent | undefined {
    for (const node of nodes) {
      if (node.kind === 'form' && node.id === formId) return node;
      if (node.kind === 'layout') {
        const found = search(node.children);
        if (found) return found;
      }
    }
  }
  for (const view of ui.views) {
    const found = search(view.components);
    if (found) return found;
  }
}

export function validateFormPayload(form: FormComponent, payload: Json): void {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload) ||
      Object.keys(payload).some(key => !form.fields.some(field => field.id === key))) {
    throw new IdasError('INVALID', 'Expected only the declared fields for ' + form.label);
  }
  for (const field of form.fields) {
    if (!Object.hasOwn(payload, field.id)) {
      if (field.required) throw new IdasError('INVALID', 'Required field: ' + field.label);
      continue;
    }
    const value = payload[field.id];
    const valid = field.kind === 'text' ? typeof value === 'string' && value.length >= (field.minLength ?? (field.required ? 1 : 0))
      && value.length <= (field.maxLength ?? 1000) && (!field.required || value.trim().length > 0)
      : field.kind === 'number' ? typeof value === 'number' && Number.isFinite(value) && value >= (field.min ?? -Infinity) && value <= (field.max ?? Infinity)
      : field.kind === 'boolean' ? typeof value === 'boolean'
      : field.options.some(option => option.value === value);
    if (!valid) throw new IdasError('INVALID', 'Invalid value for ' + field.label);
  }
}
export const jsonSchema = () => z.toJSONSchema(specification, { target: 'draft-2020-12' });

export const adaptationContext = obj({
  device: z.enum(['desktop', 'phone', 'tablet']),
  task: identifier,
});
export type AdaptationContext = z.infer<typeof adaptationContext>;
export const adaptationProposal = obj({
  intent: z.string().trim().min(1).max(4000),
  reason: z.string().trim().min(1).max(1000),
});
export const modelRequest = obj({
  text: z.string().min(1).max(4000), context: json, scope: identifier,
  previous: specification.nullable(),
  schema: json,
  available: z.array(obj({ id: identifier, version: short })).max(100),
  repair: obj({ message: z.string().max(4000) }).optional(),
});
export type ModelRequest = z.infer<typeof modelRequest>;

export class IdasError extends Error {
  constructor(readonly code: 'INVALID' | 'MISSING' | 'DENIED' | 'CONFLICT' | 'TIMEOUT' | 'CANCELLED' | 'PLUGIN', message: string, options?: ErrorOptions) {
    super(message, options); this.name = 'IdasError';
  }
}
export class MissingCapabilityError extends IdasError {
  readonly requirement: Requirement;
  constructor(requirement: Requirement) {
    super('MISSING', 'No compatible provider for ' + requirement.id + '@' + requirement.range);
    this.requirement = { ...requirement };
  }
}
export function assertJson(value: unknown): asserts value is Json {
  let nodes = 0, characters = 0;
  const visit = (v: unknown, depth: number): void => {
    if (++nodes > 50000 || depth > 40) throw new IdasError('INVALID', 'JSON exceeds size or depth limit');
    if (typeof v === 'string') characters += v.length;
    if (characters > 2_000_000) throw new IdasError('INVALID', 'JSON exceeds character limit');
    if (v === null || ['boolean', 'string'].includes(typeof v) || (typeof v === 'number' && Number.isFinite(v))) return;
    if (typeof v !== 'object' || !v || (!Array.isArray(v) && ![Object.prototype, null].includes(Object.getPrototypeOf(v)))) {
      throw new IdasError('INVALID', 'Expected plain JSON');
    }
    const keys = Reflect.ownKeys(v);
    if (Array.isArray(v) && keys.length !== v.length + 1) throw new IdasError('INVALID', 'Invalid JSON array');
    for (const k of keys) {
      if (Array.isArray(v) && k === 'length') continue;
      if (typeof k !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(k) ||
          (Array.isArray(v) && (!/^(0|[1-9]\d*)$/.test(k) || Number(k) >= v.length))) {
        throw new IdasError('INVALID', 'Unsafe JSON key');
      }
      characters += k.length;
      const d = Object.getOwnPropertyDescriptor(v, k);
      if (!d?.enumerable || !('value' in d)) throw new IdasError('INVALID', 'Invalid JSON property');
      visit(d.value, depth + 1);
    }
  };
  visit(value, 0);
}
export function canonical(value: unknown): string {
  assertJson(value);
  const emit = (v: Json): string => Array.isArray(v) ? '[' + v.map(emit).join(',') + ']' :
    v !== null && typeof v === 'object' ? '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + emit(v[k]!)).join(',') + '}' : JSON.stringify(v);
  return emit(value);
}
export const clone = (value: unknown): Json => JSON.parse(canonical(value)) as Json;

export const pluginManifest = obj({
  id: identifier, version: short, environments: z.array(identifier).min(1).max(20), requires: z.array(capability).max(100),
  permissions: z.array(identifier).max(100),
  provides: z.array(obj({ id: identifier, version: short })).min(1).max(100),
});
export type PluginManifest = z.infer<typeof pluginManifest>;
export const sandboxImage = z.string().regex(/^(?:[a-z0-9][a-z0-9./:_-]{0,240}@)?sha256:[a-f0-9]{64}$/);
export const sandboxDescriptor = obj({
  format: z.literal('idas.sandbox.v1'),
  keyId: identifier,
  expiresAt: z.number().int().positive(),
  image: sandboxImage,
  manifest: pluginManifest,
});
export const signedSandboxDescriptor = obj({
  descriptor: sandboxDescriptor,
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
});
export type SandboxDescriptor = z.infer<typeof sandboxDescriptor>;
export type SignedSandboxDescriptor = z.infer<typeof signedSandboxDescriptor>;
export interface Invocation {
  readonly signal: AbortSignal;
  /** Stable for retries of an event; external systems should deduplicate on this key. */
  readonly operation: string;
  call(requirement: Requirement, input: Json): Promise<Json>;
}
export interface Plugin {
  readonly manifest: PluginManifest;
  start?(): void | Promise<void>;
  stop?(): void | Promise<void>;
  invoke(capabilityId: string, input: Json, context: Invocation): Json | Promise<Json>;
}
/** Register the portable contract alongside the host's native renderer. */
export function uiComponentPlugin(
  manifest: Omit<PluginManifest, 'requires' | 'provides'>,
  declaration: { id: string; version: string; contract: ComponentContract },
): Plugin {
  const componentId = componentCapability.parse(declaration.id);
  const version = componentVersion.parse(declaration.version);
  const contract = componentContract.parse(clone(declaration.contract));
  return {
    manifest: { ...manifest, requires: [], provides: [{ id: componentId, version }] },
    invoke(capabilityId, input) {
      if (capabilityId !== componentId || canonical(input) !== '{"action":"describe"}') {
        throw new IdasError('DENIED', 'UI components only expose their property contract');
      }
      return clone(contract);
    },
  };
}
export interface Snapshot {
  revision: number;
  spec: Specification;
  data: Record<string, Json>;
  mode: string;
  receipts: { id: string; fingerprint: string }[];
}
export interface Store {
  read(scope: string): Promise<Snapshot | null>;
  history(scope: string): Promise<Snapshot[]>;
  compareAndSwap(scope: string, expected: number, next: Snapshot, signal?: AbortSignal): Promise<boolean>;
}
export interface Trace { type: string; operation?: string; capability?: string; plugin?: string; durationMs?: number; code?: string }
export const services = {
  compiler: 'idas.compiler', specification: 'idas.specification', resolver: 'idas.resolver', composer: 'idas.composer',
  renderer: 'idas.renderer', interaction: 'idas.interaction', workflow: 'idas.workflow', policy: 'idas.policy',
  state: 'idas.state', model: 'idas.model', protocol: 'idas.protocol', evolution: 'idas.evolution',
  adaptation: 'idas.adaptation', workspaceClaim: 'idas.workspace-claim',
} as const;
