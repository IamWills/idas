import { z } from 'zod';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export const id = z.string().regex(/^(?!(?:constructor|prototype)$)[a-zA-Z][a-zA-Z0-9._-]{0,95}$/);
const identifier = id;
export const json = z.json() as z.ZodType<Json>;
const obj = z.strictObject;
const short = z.string().max(1000);
export const capability = obj({ id: identifier, range: z.string().min(1).max(128) });
const component = obj({
  id: identifier, kind: z.enum(['text', 'button', 'input', 'value']), label: short,
  event: identifier.optional(), state: identifier.optional(),
});
const rule = obj({ event: identifier, from: identifier, to: identifier,
  set: z.array(obj({ key: identifier, value: json })).max(100).optional(),
  capture: identifier.optional(), workflow: identifier.optional() });
const task = obj({ id: identifier, capability: identifier, input: json, after: z.array(identifier).max(100).optional(),
  when: obj({ key: identifier, equals: json }).optional(), saveAs: identifier.optional() });
export const specification = obj({
  intent: obj({ goal: z.string().min(1).max(4000), constraints: z.array(short).max(100), context: json, scope: identifier }),
  ui: obj({ layout: z.enum(['stack', 'grid']), columns: z.number().int().min(1).max(4), collapseBelow: z.number().int().min(320).max(1600),
    theme: z.enum(['light', 'dark', 'system']), views: z.array(obj({ id: identifier, title: short, components: z.array(component).max(100) })).min(1).max(20) }),
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
export const jsonSchema = () => z.toJSONSchema(specification, { target: 'draft-2020-12' });

export class IdasError extends Error {
  constructor(readonly code: 'INVALID' | 'MISSING' | 'DENIED' | 'CONFLICT' | 'TIMEOUT' | 'CANCELLED' | 'PLUGIN', message: string, options?: ErrorOptions) {
    super(message, options); this.name = 'IdasError';
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
} as const;
