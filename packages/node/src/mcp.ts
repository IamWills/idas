import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/server';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { adaptationContext, canonical, clone, id, IdasError, json, jsonSchema, MissingCapabilityError } from '@intent-driven/contracts';
import type { Json, Requirement } from '@intent-driven/contracts';
import type { Change, Engine } from '@intent-driven/core';

export type McpWorkspaceMutation =
  | { action: 'apply'; scope: string; change: Readonly<Change> }
  | { action: 'dispatch'; scope: string; event: string; eventId: string; input: Json };

export interface WorkspaceMcpOptions {
  engine: Engine;
  scope: string;
  /** Enable when the host has registered an adaptation plugin. */
  recommendations?: boolean;
  /** Host authorization for this connection. Omit to expose a read-only surface. */
  authorize?: (request: McpWorkspaceMutation, signal: AbortSignal) => boolean | Promise<boolean>;
}

function result(payload: Record<string, Json>): CallToolResult {
  return { structuredContent: payload, content: [{ type: 'text', text: canonical(payload) }] };
}

async function tool(work: () => Promise<Record<string, Json>>): Promise<CallToolResult> {
  try { return result(await work()); }
  catch (error) {
    const code = error instanceof IdasError ? error.code : 'PLUGIN';
    const message = error instanceof IdasError ? error.message.slice(0, 1000) : 'Workspace operation failed';
    const payload: Record<string, Json> = { code, message };
    if (error instanceof MissingCapabilityError) payload.requirement = error.requirement;
    return { ...result(payload), isError: true };
  }
}

export function createWorkspaceMcpServer(options: WorkspaceMcpOptions): McpServer {
  const { engine, scope, authorize } = options;
  if (!id.safeParse(scope).success) throw new IdasError('INVALID', 'Invalid MCP workspace scope');
  const server = new McpServer({ name: 'idas-workspace', version: '0.1.0' });
  const pending = new Map<string, { change: Change; expiresAt: number }>();
  const schemaUri = 'idas://schemas/idss';
  const snapshotUri = 'idas://workspace/snapshot';
  function previewResult(change: Change): Record<string, Json> {
    let token: string | null = null;
    if (authorize) {
      const now = Date.now();
      for (const [key, item] of pending) if (item.expiresAt <= now) pending.delete(key);
      if (pending.size >= 16) pending.delete(pending.keys().next().value!);
      token = randomUUID();
      pending.set(token, { change, expiresAt: now + 300_000 });
    }
    return { token, change: clone(change) };
  }

  server.registerResource('idss-schema', schemaUri, { mimeType: 'application/json', description: 'IDSS JSON Schema' }, uri => ({
    contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(jsonSchema()) }],
  }));
  server.registerResource('workspace-snapshot', snapshotUri, {
    mimeType: 'application/json', description: 'Committed state of the workspace bound to this connection',
  }, async (uri, ctx) => ({
    contents: [{ uri: uri.href, mimeType: 'application/json', text: canonical(await engine.snapshot(scope, { signal: ctx.mcpReq.signal })) }],
  }));

  server.registerTool('idas_preview_intent', {
    description: 'Preview a natural-language change to the bound workspace. Review the resulting specification before applying.',
    inputSchema: z.strictObject({ intent: z.string().trim().min(1).max(4000) }),
    outputSchema: z.strictObject({ token: z.uuid().nullable(), change: json }),
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, ({ intent }, ctx) => tool(async () =>
    previewResult(await engine.preview(scope, intent, null, { signal: ctx.mcpReq.signal }))));

  if (options.recommendations) {
    server.registerTool('idas_recommend_layout', {
      description: 'Ask the workspace adaptation plugin for an explained layout preview based on device and task.',
      inputSchema: adaptationContext,
      outputSchema: z.strictObject({ recommendation: json }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    }, (context, ctx) => tool(async () => {
      const proposal = await engine.recommend(scope, context, { signal: ctx.mcpReq.signal });
      return { recommendation: proposal ? { reason: proposal.reason, ...previewResult(proposal.change) } : null };
    }));
  }

  server.registerTool('idas_suggest_capability', {
    description: 'Explain the next steps for a missing capability. This only returns extension suggestions.',
    inputSchema: z.strictObject({ id, range: z.string().min(1).max(128) }),
    outputSchema: z.strictObject({ suggestion: json }),
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, (requirement: Requirement, ctx) => tool(async () => ({
    suggestion: await engine.suggest(scope, requirement, { signal: ctx.mcpReq.signal }),
  })));

  if (authorize) {
    server.registerTool('idas_apply_preview', {
      description: 'Apply a reviewed intent preview using its single-use token. Host authorization is required.',
      inputSchema: z.strictObject({ token: z.uuid() }),
      outputSchema: z.strictObject({ snapshot: json }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    }, ({ token }, ctx) => tool(async () => {
      const preview = pending.get(token);
      pending.delete(token);
      if (!preview || preview.expiresAt <= Date.now()) throw new IdasError('INVALID', 'Preview token is unknown, used, or expired');
      if (!await authorize({ action: 'apply', scope, change: structuredClone(preview.change) }, ctx.mcpReq.signal)) {
        throw new IdasError('DENIED', 'Host rejected the MCP change');
      }
      return { snapshot: clone(await engine.apply(preview.change, { signal: ctx.mcpReq.signal })) };
    }));

    server.registerTool('idas_dispatch_event', {
      description: 'Dispatch an event defined by the committed IDSS. Reuse the same event ID when retrying.',
      inputSchema: z.strictObject({ event: id, eventId: id, input: json.optional() }),
      outputSchema: z.strictObject({ snapshot: json }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    }, ({ event, eventId, input }, ctx) => tool(async () => {
      const value = input ?? null;
      if (!await authorize({ action: 'dispatch', scope, event, eventId, input: structuredClone(value) }, ctx.mcpReq.signal)) {
        throw new IdasError('DENIED', 'Host rejected the MCP event');
      }
      return { snapshot: clone(await engine.dispatch(scope, event, value, eventId, { signal: ctx.mcpReq.signal })) };
    }));
  }
  return server;
}

/** The SDK negotiates the protocol era and pins one server to the stdio connection. */
export function serveWorkspaceMcpStdio(options: WorkspaceMcpOptions) {
  return serveStdio(() => createWorkspaceMcpServer(options));
}
