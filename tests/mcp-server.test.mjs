import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const script = fileURLToPath(new URL('../examples/node-agent/mcp.mjs', import.meta.url));

async function session({ mode, writes }, run) {
  const directory = await mkdtemp(join(tmpdir(), 'idas-mcp-'));
  const client = new Client({ name: 'idas-test', version: '1.0.0' }, { versionNegotiation: { mode } });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [script], env: { IDAS_DATA: directory, IDAS_MCP_ALLOW_WRITES: writes ? '1' : '0' },
  });
  try {
    await client.connect(transport);
    await run(client);
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test('MCP 2025 client discovers resources and read-only tools over real stdio', async () => {
  await session({ mode: 'legacy', writes: false }, async client => {
    assert.equal(client.getNegotiatedProtocolVersion(), '2025-11-25');
    assert.equal(client.getServerVersion().name, 'idas-workspace');
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), [
      'idas_preview_intent', 'idas_recommend_layout', 'idas_suggest_capability',
    ]);
    const resources = (await client.listResources()).resources;
    assert.deepEqual(resources.map(resource => resource.uri).sort(), ['idas://schemas/idss', 'idas://workspace/snapshot']);
    const schema = await client.readResource({ uri: 'idas://schemas/idss' });
    assert.equal(JSON.parse(schema.contents[0].text).properties.metadata.type, 'object');
    const preview = await client.callTool({ name: 'idas_preview_intent', arguments: { intent: 'dark mode' } });
    assert.equal(preview.structuredContent.token, null);
    assert.equal(preview.structuredContent.change.spec.ui.theme, 'dark');
    const snapshot = await client.readResource({ uri: 'idas://workspace/snapshot' });
    assert.equal(JSON.parse(snapshot.contents[0].text), null);
  });
});

test('MCP 2026 client previews, applies once, then dispatches idempotently over real stdio', async () => {
  await session({ mode: { pin: '2026-07-28' }, writes: true }, async client => {
    assert.equal(client.getNegotiatedProtocolVersion(), '2026-07-28');
    const call = (name, args) => client.callTool({ name, arguments: args });
    const tools = (await client.listTools()).tools;
    assert.equal(tools.length, 5);
    assert.ok(tools.find(item => item.name === 'idas_apply_preview').annotations.destructiveHint);
    const create = await call('idas_preview_intent', { intent: 'workflow echo "MCP"' });
    const stale = await call('idas_preview_intent', { intent: 'dark mode' });
    const token = create.structuredContent.token;
    const applied = await call('idas_apply_preview', { token });
    assert.equal(applied.structuredContent.snapshot.revision, 1);
    assert.equal((await call('idas_apply_preview', { token })).isError, true);
    assert.equal((await call('idas_apply_preview', { token: stale.structuredContent.token })).structuredContent.code, 'CONFLICT');
    const request = { event: 'run', eventId: 'release-1' };
    const dispatched = await call('idas_dispatch_event', request);
    assert.equal(dispatched.structuredContent.snapshot.data.result, 'MCP');
    assert.equal((await call('idas_dispatch_event', request)).structuredContent.snapshot.revision, 2);
    assert.equal((await call('idas_dispatch_event', { ...request, eventId: 'forged', scope: 'other' })).isError, true);
    const snapshot = await client.readResource({ uri: 'idas://workspace/snapshot' });
    assert.equal(JSON.parse(snapshot.contents[0].text).revision, 2);

    const workbench = await call('idas_preview_intent', { intent: 'Create a developer workbench' });
    const installed = await call('idas_apply_preview', { token: workbench.structuredContent.token });
    assert.equal(installed.structuredContent.snapshot.spec.ui.presentation.compactMode, 'stack');
    const suggestion = await call('idas_recommend_layout', { device: 'phone', task: 'review' });
    assert.match(suggestion.structuredContent.recommendation.reason, /phone/);
    assert.equal(suggestion.structuredContent.recommendation.change.spec.ui.presentation.compactMode, 'pages');
  });
});
