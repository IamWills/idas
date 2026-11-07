import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine, Registry } from '../packages/core/dist/index.js';
import { approveSandbox, fileStore } from '../packages/node/dist/index.js';
import { compileOffline, standard } from '../packages/standard/dist/index.js';
import { a2uiSurface, aguiSnapshot, discoverMcp, mcpResources, mcpTools, readAguiEvent } from '../packages/protocols/dist/index.js';

test('Node file store restores a workspace and rejects competing writers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'idas-test-'));
  try {
    const store = fileStore(dir);
    const registry = new Registry('node');
    await registry.load(() => standard({ store, resolve: registry.inspect.bind(registry), tool: registry.invoke.bind(registry) }));
    const engine = new Engine(registry);
    const s = await engine.apply(await engine.preview('test', '2 columns'));
    const outcomes = await Promise.all([
      store.compareAndSwap('test', 1, { ...s, revision: 2 }),
      fileStore(dir).compareAndSwap('test', 1, { ...s, revision: 2 }),
    ]);
    assert.equal(outcomes.filter(Boolean).length, 1);
    assert.equal((await fileStore(dir).read('test')).revision, 2);
    await assert.rejects(store.read('../secret'), { code: 'INVALID' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('MCP discovery never grants remote tools; mapped tools require host authorization', async () => {
  const client = {
    protocolVersion: '2025-11-25',
    async request(method, params) {
      if (method === 'tools/list') return params.cursor ? { tools: [{ name: 'write' }] } : { tools: [{ name: 'read' }], nextCursor: 'page2' };
      assert.equal(params.name, 'read');
      return { content: [], structuredContent: { ok: true } };
    },
  };
  const signal = new AbortController().signal;
  assert.deepEqual(await discoverMcp(client, signal), ['read', 'write']);
  assert.throws(() => mcpTools({ ...client, protocolVersion: 'other' }, []), { code: 'INVALID' });
  let allowed = false;
  const registry = new Registry('node', p => allowed && p === 'mcp.call');
  await registry.load(() => mcpTools(client, [{ capability: 'remote.read', tool: 'read', version: '1.0.0' }]));
  await assert.rejects(registry.invoke({ id: 'remote.read', range: '^1' }, {}, 'test', signal, 'read'), { code: 'DENIED' });
  allowed = true;
  assert.deepEqual(await registry.invoke({ id: 'remote.read', range: '^1' }, {}, 'test', signal, 'read'), { ok: true });
  assert.throws(() => registry.inspect({ id: 'remote.write', range: '^1' }, 'test'), { code: 'MISSING' });
});
test('MCP resource mapping is fixed by the host', async () => {
  const uri = 'file:///allowed.md';
  const registry = new Registry('node', p => p === 'mcp.read');
  await registry.load(() => mcpResources({ protocolVersion: '2025-11-25', async request(method, params) {
    assert.equal(method, 'resources/read');
    assert.equal(params.uri, uri);
    return { contents: [{ uri, text: 'allowed' }] };
  } }, [{ capability: 'remote.document', uri, version: '1.0.0' }]));
  const call = input => registry.invoke({ id: 'remote.document', range: '^1' }, input, 'test', new AbortController().signal, 'read');
  await assert.rejects(call({ uri: 'file:///private' }), { code: 'INVALID' });
  assert.deepEqual(await call(null), [{ uri, text: 'allowed' }]);
});
test('A2UI and AG-UI projections follow the supported wire shapes', () => {
  const s = compileOffline({ scope: 'test', text: '2 columns', context: null, previous: null });
  const [create, update] = a2uiSurface(s.ui.views[0], 'main', 'https://example.test/basic.json', s.state.initial);
  assert.equal(create.version, 'v0.9');
  assert.equal(create.createSurface.surfaceId, update.updateComponents.surfaceId);
  assert.equal(update.updateComponents.components[0].id, 'root');
  assert.deepEqual(aguiSnapshot('thread', 'run', { status: 'ready' }).map(e => e.type), ['RUN_STARTED', 'STATE_SNAPSHOT', 'RUN_FINISHED']);
  assert.throws(() => readAguiEvent({ type: 'RUN_FINISHED', runId: 'x' }), { code: 'INVALID' });
});
const manifest = { id: 'test.sandbox', version: '1.0.0', environments: ['node'], requires: [], permissions: ['sandbox.use'],
  provides: [{ id: 'test.sandbox.echo', version: '1.0.0' }] };
test('sandbox rejects mutable images and incomplete test coverage before approval', async () => {
  const options = { approve: () => assert.fail('Approval should not be reached'), probes: [] };
  await assert.rejects(approveSandbox({ image: 'example:latest', manifest }, options), { code: 'INVALID' });
  await assert.rejects(approveSandbox({ image: 'sha256:' + '0'.repeat(64), manifest }, options), { code: 'INVALID' });
});
const dockerTest = process.env.IDAS_SANDBOX_IMAGE ? test : test.skip;
dockerTest('real sandbox uses a read-only root, no network and no host secret, and remains grant gated', async () => {
    const candidate = { image: process.env.IDAS_SANDBOX_IMAGE, manifest };
    const expected = { readOnly: true, noNetwork: true, noSecret: true };
    const probes = [{ capability: 'test.sandbox.echo', input: null, expected }];
    await assert.rejects(approveSandbox(candidate, { probes, approve: () => false }), { code: 'DENIED' });
    const plugin = await approveSandbox(candidate, { probes, approve: () => true });
    let allowed = false;
    const registry = new Registry('node', permission => allowed && permission === 'sandbox.use');
    await registry.load(() => plugin);
    const call = () => registry.invoke({ id: 'test.sandbox.echo', range: '^1' }, null, 'test', new AbortController().signal, 'sandbox');
    await assert.rejects(call(), { code: 'DENIED' });
    allowed = true;
    assert.deepEqual(await call(), expected);
    await registry.unload(manifest.id);
    await assert.rejects(call(), { code: 'MISSING' });
  });
