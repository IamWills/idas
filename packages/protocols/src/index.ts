import { z } from 'zod';
import { assertJson, clone, IdasError, id, json, services } from '@intent-driven/contracts';
import type { Json, Plugin, Snapshot, Specification } from '@intent-driven/contracts';

export const protocolVersions = { mcp: '2025-11-25', a2ui: 'v0.9', agui: 'event subset' } as const;
type MCPClient = {
  protocolVersion: string;
  request(method: 'tools/list' | 'tools/call', params: Record<string, Json>, signal: AbortSignal): Promise<unknown>;
};
type Mapping = { capability: string; tool: string; version: string };
const toolName = z.string().regex(/^[a-zA-Z0-9_.-]{1,128}$/);
const list = z.object({ tools: z.array(z.object({ name: toolName })).max(1000), nextCursor: z.string().max(1000).optional() });
const result = z.object({ content: z.array(json).max(1000), structuredContent: z.record(z.string(), json).optional(), isError: z.boolean().optional() });

/** Bind a negotiated MCP client/SDK transport. Discovery is advisory; only host-mapped tools become capabilities. */
export function mcpTools(client: MCPClient, allowed: Mapping[], pluginId = 'idas.mcp'): Plugin {
  if (client.protocolVersion !== protocolVersions.mcp) throw new IdasError('INVALID', 'Unsupported MCP protocol version');
  const mappings = new Map(allowed.map(m => [id.parse(m.capability), { ...m, tool: toolName.parse(m.tool) }]));
  if (mappings.size !== allowed.length || allowed.some(m => m.capability.startsWith('idas.'))) throw new IdasError('INVALID', 'Invalid MCP mapping');
  return {
    manifest: { id: pluginId, version: '1.0.0', requires: [], permissions: ['mcp.call'], environments: ['any'],
      provides: [...mappings.values()].map(m => ({ id: m.capability, version: m.version })) },
    async invoke(capability, input, ctx) {
      const target = mappings.get(capability);
      if (!target) throw new IdasError('DENIED', 'MCP capability not mapped');
      if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new IdasError('INVALID', 'MCP tool requires an object input');
      const response = result.safeParse(clone(await client.request('tools/call', { name: target.tool, arguments: input }, ctx.signal)));
      if (!response.success || response.data.isError) throw new IdasError('PLUGIN', 'MCP tool returned an error or invalid response');
      return response.data.structuredContent ?? response.data.content;
    },
  };
}
export async function discoverMcp(client: MCPClient, signal: AbortSignal): Promise<string[]> {
  if (client.protocolVersion !== protocolVersions.mcp) throw new IdasError('INVALID', 'Unsupported MCP protocol version');
  const found = new Set<string>();
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    signal.throwIfAborted();
    const page = list.safeParse(clone(await client.request('tools/list', cursor ? { cursor } : {}, signal)));
    if (!page.success) throw new IdasError('INVALID', 'Invalid MCP tool list');
    for (const tool of page.data.tools) found.add(tool.name);
    cursor = page.data.nextCursor;
    if (cursor && (seen.has(cursor) || seen.size >= 20)) throw new IdasError('INVALID', 'Invalid MCP pagination');
    if (cursor) seen.add(cursor);
  } while (cursor);
  return [...found].sort();
}

/** Read-only projection for a client that negotiated the v0.9 Basic Catalog. */
export function a2uiSurface(view: Specification['ui']['views'][number], surfaceId: string, catalogId: string, data: Snapshot['data']): Json {
  const items = [{ id: 'title', component: 'Text', text: view.title },
    ...view.components.map((c, i) => ({
      id: 'item-' + i, component: 'Text',
      text: c.kind === 'value' ? c.label + ': ' + (typeof data[c.state!] === 'string' ? data[c.state!] : JSON.stringify(data[c.state!] ?? null)) : c.label,
    }))];
  return [
    { version: 'v0.9', createSurface: { surfaceId, catalogId } },
    { version: 'v0.9', updateComponents: { surfaceId, components: [{ id: 'root', component: 'Column', children: items.map(i => i.id) }, ...items] } },
  ];
}
const agEvents = z.discriminatedUnion('type', [
  z.object({ type: z.literal('RUN_STARTED'), threadId: z.string().min(1), runId: z.string().min(1) }),
  z.object({ type: z.literal('STATE_SNAPSHOT'), snapshot: json }),
  z.object({ type: z.literal('RUN_FINISHED'), threadId: z.string().min(1), runId: z.string().min(1) }),
  z.object({ type: z.literal('RUN_ERROR'), message: z.string(), code: z.string().optional() }),
]);
export function readAguiEvent(input: unknown) {
  assertJson(input);
  const r = agEvents.safeParse(input);
  if (!r.success) throw new IdasError('INVALID', 'Unsupported or malformed AG-UI event');
  return r.data;
}
export function aguiSnapshot(threadId: string, runId: string, state: Snapshot['data']): Json[] {
  return [
    { type: 'RUN_STARTED', threadId, runId },
    { type: 'STATE_SNAPSHOT', snapshot: clone(state) },
    { type: 'RUN_FINISHED', threadId, runId },
  ].map(e => clone(readAguiEvent(e)));
}
export function protocolProjection(catalogId: string): Plugin {
  const a2ui = services.protocol + '.a2ui';
  const agui = services.protocol + '.agui';
  return {
    manifest: { id: 'idas.protocol.projection', version: '1.0.0', requires: [], permissions: [], environments: ['any'],
      provides: [{ id: a2ui, version: '1.0.0' }, { id: agui, version: '1.0.0' }] },
    invoke(capability, input) {
      if (capability === a2ui) {
        const { view, surfaceId, data } = input as unknown as { view: Specification['ui']['views'][number]; surfaceId: string; data: Snapshot['data'] };
        return a2uiSurface(view, id.parse(surfaceId), catalogId, data);
      }
      if (capability === agui) {
        const { threadId, runId, data } = input as unknown as { threadId: string; runId: string; data: Snapshot['data'] };
        return aguiSnapshot(threadId, runId, data);
      }
      throw new IdasError('MISSING', 'Unsupported protocol projection');
    },
  };
}

type ResourceClient = {
  protocolVersion: string;
  request(method: 'resources/read', params: { uri: string }, signal: AbortSignal): Promise<unknown>;
};
const resourceResult = z.object({
  contents: z.array(z.union([
    z.object({ uri: z.string(), mimeType: z.string().optional(), text: z.string() }),
    z.object({ uri: z.string(), mimeType: z.string().optional(), blob: z.string() }),
  ])).max(100),
});
/** The URI is chosen by the host. Untrusted input cannot redirect the MCP resource read. */
export function mcpResources(client: ResourceClient, mappings: { capability: string; uri: string; version: string }[], pluginId = 'idas.mcp.resources'): Plugin {
  if (client.protocolVersion !== protocolVersions.mcp) throw new IdasError('INVALID', 'Unsupported MCP protocol version');
  const resources = new Map(mappings.map(m => [id.parse(m.capability), { ...m, uri: z.url().max(2048).parse(m.uri) }]));
  if (resources.size !== mappings.length || mappings.some(m => m.capability.startsWith('idas.'))) throw new IdasError('INVALID', 'Invalid MCP resource mapping');
  return {
    manifest: { id: pluginId, version: '1.0.0', requires: [], permissions: ['mcp.read'], environments: ['any'],
      provides: [...resources.values()].map(m => ({ id: m.capability, version: m.version })) },
    async invoke(capability, input, ctx) {
      const resource = resources.get(capability);
      if (!resource) throw new IdasError('DENIED', 'MCP resource not mapped');
      if (input !== null) throw new IdasError('INVALID', 'MCP resource capability takes null input');
      const response = resourceResult.safeParse(clone(await client.request('resources/read', { uri: resource.uri }, ctx.signal)));
      if (!response.success || response.data.contents.some(content => content.uri !== resource.uri)) {
        throw new IdasError('PLUGIN', 'MCP resource returned an invalid response');
      }
      return clone(response.data.contents);
    },
  };
}
