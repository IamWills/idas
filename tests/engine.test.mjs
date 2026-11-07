import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine, Registry } from '../packages/core/dist/index.js';
import { echoPlugin, memoryStore, standard } from '../packages/standard/dist/index.js';

const make = async ({ store = memoryStore(), options, grant, plugin, compiler } = {}) => {
  const registry = new Registry('test', grant);
  await registry.load(() => standard({ store, compiler, resolve: registry.inspect.bind(registry), tool: registry.invoke.bind(registry) }));
  if (plugin !== false) await registry.load(plugin ?? echoPlugin);
  return new Engine(registry, options);
};
test('natural language changes layout and workflow; state is recovered, deduplicated and rolled back', async () => {
  const store = memoryStore();
  const a = await make({ store });
  const first = await a.apply(await a.preview('desk', '单列布局'));
  const preview = await a.preview('desk', '两列，改成 2 列深色，状态改成“完成”，工作流回显“你好”');
  assert.ok(preview.sections.includes('workflows'));
  const changed = await a.apply(preview);
  assert.equal(changed.spec.ui.columns, 2);
  const ran = await a.dispatch('desk', 'run', null, 'event1');
  assert.deepEqual(ran.data, { status: '完成', note: '', result: '你好' });
  const b = await make({ store });
  assert.deepEqual(await b.snapshot('desk'), ran);
  assert.equal((await b.dispatch('desk', 'run', null, 'event1')).revision, ran.revision);
  await assert.rejects(b.dispatch('desk', 'run', 'different', 'event1'), { code: 'CONFLICT' });
  const rolled = await b.rollback('desk', first.revision);
  assert.equal(rolled.spec.ui.columns, 1);
  assert.equal(rolled.data.result, '');
});
test('missing tools, stale previews, denied approval and unsafe references cannot commit', async () => {
  let allow = true;
  const a = await make({ plugin: false, options: { approve: () => allow } });
  const first = await a.apply(await a.preview('desk', 'stack'));
  await assert.rejects(a.preview('desk', 'workflow echo "missing"'), { code: 'MISSING' });
  const stale = await a.preview('desk', 'dark');
  const next = await a.preview('desk', '2 columns');
  allow = false;
  await assert.rejects(a.apply(next), { code: 'DENIED' });
  assert.deepEqual(await a.snapshot('desk'), first);
  allow = true;
  await a.apply(next);
  await assert.rejects(a.apply(stale), { code: 'CONFLICT' });
  const spec = structuredClone(first.spec);
  spec.interaction.rules[0].to = 'nope';
  await assert.rejects(a.previewSpec('desk', spec), { code: 'INVALID' });
});
test('cancelled or failed workflows leave existing state and return classified errors', async () => {
  const a = await make({ plugin: () => ({
    ...echoPlugin(), async invoke(_id, _input, ctx) {
      await new Promise((resolve, reject) => ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason), { once: true }));
    },
  }) });
  const initial = await a.apply(await a.preview('desk', 'workflow echo "slow"'));
  const running = a.dispatch('desk', 'run', null, 'slow', { timeoutMs: 20 });
  await assert.rejects(a.dispatch('desk', 'run', null, 'concurrent'), { code: 'CONFLICT' });
  await assert.rejects(running, { code: 'TIMEOUT' });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(await a.snapshot('desk'), initial);
});
test('a model compiler cannot elevate privileges or escape its declared capability dependency', async () => {
  const { compileOffline, modelCompiler } = await import('../packages/standard/dist/index.js');
  const registry = new Registry('test', permission => permission === 'model.use');
  await registry.load(() => standard({ resolve: registry.inspect.bind(registry), tool: registry.invoke.bind(registry) }));
  await registry.load(modelCompiler);
  let calls = 0;
  await registry.load(() => ({
    manifest: { id: 'test.model', version: '1.0.0', permissions: ['model.use'], environments: ['any'], requires: [],
      provides: [{ id: 'idas.model', version: '1.0.0' }] },
    invoke(_capability, input) {
      calls++;
      return compileOffline({ ...input, text: 'workflow echo "private"' });
    },
  }));
  await registry.load(() => ({
    ...echoPlugin(), manifest: { ...echoPlugin().manifest, permissions: ['secrets.read'] },
    invoke: () => assert.fail('Unauthorized tool executed'),
  }));
  const engine = new Engine(registry);
  await assert.rejects(engine.preview('test', 'a free-form instruction'), { code: 'DENIED' });
  assert.equal(calls, 1);
  assert.equal(await engine.snapshot('test'), null);
  const proposal = await engine.suggest('test', { id: 'other.tool', range: '^1' });
  assert.equal(proposal.status, 'proposal');
  assert.throws(() => registry.inspect({ id: 'other.tool', range: '^1' }, 'test'), { code: 'MISSING' });
});
