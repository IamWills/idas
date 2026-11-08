import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MissingCapabilityError, services } from '../packages/contracts/dist/index.js';
import { Engine, Registry } from '../packages/core/dist/index.js';
import { modelCompiler, standard } from '../packages/standard/dist/index.js';
import { compileWorkbench, workbenchCompiler, workbenchTools } from '../examples/web/workbench.ts';

const intents = {
  A: '将当前应用改造成开发工作台，左侧显示文件、中间显示编辑器、右侧显示 Agent 状态。',
  B: '修改代码前先显示 Diff，需要我确认后才能提交。',
  C: '每次发布前先测试，成功后构建并上传，失败则停止并报告。',
  D: '把右侧 Agent 面板改到底部，并且在手机上改成独立页面。',
};

async function setup({ tools = workbenchTools() } = {}) {
  const registry = new Registry('node');
  await registry.load(() => standard({
    resolve: registry.inspect.bind(registry), tool: registry.invoke.bind(registry),
  }));
  await registry.load(workbenchCompiler);
  if (tools) await registry.load(() => tools);
  return { engine: new Engine(registry), registry };
}
const scope = 'desk';
const apply = async (engine, text) => engine.apply(await engine.preview(scope, text));

test('A–D: intent creates a workbench, gates commits and releases, then adapts the existing workspace', async () => {
  const calls = [];
  const tools = workbenchTools();
  const { engine } = await setup({ tools: { ...tools, invoke(id, input, ctx) {
    calls.push(id);
    return tools.invoke(id, input, ctx);
  } } });
  const preview = await engine.preview(scope, intents.A);
  assert.ok(preview.sections.includes('ui'));
  assert.ok(preview.bindings.some(binding => binding.capability === 'workbench.commit'));
  const first = await engine.apply(preview);
  assert.deepEqual((await engine.view(scope)).presentation.wide, [['files', 'editor', 'agent']]);
  assert.equal(first.spec.ui.presentation.compactMode, 'stack');
  await apply(engine, intents.B);
  await assert.rejects(engine.dispatch(scope, 'confirm', null, 'early'), { code: 'INVALID' });
  await assert.rejects(engine.dispatch(scope, 'edit', '', 'empty'), { code: 'INVALID' });
  assert.deepEqual(calls, []);
  const changed = 'export const ready = false;';
  const pending = await engine.dispatch(scope, 'edit', changed, 'edit1');
  assert.equal(pending.mode, 'review');
  assert.equal(pending.data.committed, first.data.committed);
  assert.match(pending.data.diff, /-export const ready = true;\n\+export const ready = false;/);
  assert.deepEqual(calls, ['workbench.diff']);
  const accepted = await engine.dispatch(scope, 'confirm', null, 'confirmed');
  assert.equal(accepted.mode, 'ready');
  assert.equal(accepted.data.committed, changed);

  await apply(engine, intents.C);
  calls.length = 0;
  const failed = await engine.dispatch(scope, 'release', null, 'release1');
  assert.match(failed.data.report, /Tests failed/);
  assert.deepEqual(calls, ['workbench.test', 'workbench.report']);
  await engine.dispatch(scope, 'edit', first.data.committed, 'edit2');
  await engine.dispatch(scope, 'confirm', null, 'confirmed2');
  calls.length = 0;
  const released = await engine.dispatch(scope, 'release', null, 'release2');
  assert.match(released.data.report, /Uploaded to demo target/);
  assert.deepEqual(calls, ['workbench.test', 'workbench.build', 'workbench.upload']);

  const move = await engine.preview(scope, intents.D);
  assert.deepEqual(new Set(move.sections), new Set(['intent', 'metadata', 'ui']));
  const adapted = await engine.apply(move);
  assert.deepEqual(adapted.spec.ui.presentation, { wide: [['files', 'editor'], ['agent']], compact: ['editor', 'files', 'agent'], compactMode: 'pages' });
  assert.deepEqual(adapted.data, released.data);
  const invalid = structuredClone(adapted.spec);
  invalid.ui.presentation.compact = ['editor', 'editor', 'agent'];
  await assert.rejects(engine.previewSpec(scope, invalid), { code: 'INVALID' });
  assert.equal((await engine.rollback(scope, released.revision)).spec.ui.presentation.wide[0].length, 3);
});

test('E: missing capability is structured and preview cannot change the workspace', async () => {
  const { engine } = await setup({ tools: null });
  let requirement;
  await assert.rejects(engine.preview(scope, intents.A), error => {
    assert.ok(error instanceof MissingCapabilityError);
    assert.deepEqual(error.requirement, { id: 'workbench.commit', range: '^1.0.0' });
    requirement = error.requirement;
    return true;
  });
  assert.equal((await engine.suggest(scope, requirement)).status, 'proposal');
  assert.equal(await engine.snapshot(scope), null);
});

test('a model provider can repair an invalid IDSS once and use the committed specification on the next turn', async () => {
  const { engine, registry } = await setup();
  const requests = [];
  await registry.load(() => ({
    manifest: { id: 'test.workbench.model', version: '1.0.0', environments: ['any'], requires: [], permissions: [],
      provides: [{ id: services.model, version: '1.0.0' }] },
    invoke(_id, input) {
      requests.push(input);
      if (requests.length === 1) return { shell: 'untrusted code' };
      return compileWorkbench({ ...input, text: input.previous ? intents.D : intents.A });
    },
  }));
  await registry.load(() => modelCompiler(undefined, { repair: true }));
  await apply(engine, 'Please set up an environment for reviewing software changes');
  assert.match(requests[1].repair.message, /shell/);
  await apply(engine, 'Give the agent its own screen on my phone');
  assert.deepEqual(requests[2].previous.ui.presentation.wide, [['files', 'editor', 'agent']]);
  assert.deepEqual((await engine.view(scope)).presentation.wide, [['files', 'editor'], ['agent']]);
  assert.equal(requests.length, 3);
});

test('a phone review recommendation is explained, revision-bound, dismissible and reversible', async () => {
  const { engine, registry } = await setup();
  const { workbenchAdaptation } = await import('../examples/web/workbench.ts');
  const { diffSpecification } = await import('../packages/standard/dist/index.js');
  await registry.load(workbenchAdaptation);
  const first = await apply(engine, intents.A);
  assert.equal(await engine.recommend(scope, { device: 'desktop', task: 'review' }), null);
  await assert.rejects(engine.recommend(scope, { device: 'phone', task: 'review', secret: true }), { code: 'INVALID' });
  const phone = { device: 'phone', task: 'review' };
  const dismissed = await engine.recommend(scope, phone);
  assert.match(dismissed.reason, /phone/);
  assert.equal((await engine.snapshot(scope)).revision, first.revision);
  assert.ok(diffSpecification(first.spec, dismissed.change.spec).entries.some(delta =>
    delta.path === '/ui/presentation/compactMode' && delta.before === 'stack' && delta.after === 'pages'));
  await apply(engine, intents.B);
  await assert.rejects(engine.apply(dismissed.change), { code: 'CONFLICT' });
  const accepted = await engine.recommend(scope, phone);
  const result = await engine.apply(accepted.change);
  assert.equal(result.spec.ui.presentation.compactMode, 'pages');
  assert.equal(await engine.recommend(scope, phone), null);
  assert.equal((await engine.rollback(scope, accepted.change.base)).spec.ui.presentation.compactMode, 'stack');
});

test('HTTP model adapter receives a schema and only capabilities granted in the current scope', async () => {
  const { httpModel } = await import('../examples/node-agent/http-model.mjs');
  const registry = new Registry('node', (permission, plugin, workspace) =>
    permission === 'model.http' && plugin === 'example.http-model' && workspace === scope);
  await registry.load(() => standard({ resolve: registry.inspect.bind(registry), tool: registry.invoke.bind(registry) }));
  await registry.load(workbenchTools);
  await registry.load(() => ({
    manifest: { id: 'test.private', version: '1.0.0', environments: ['any'], requires: [], permissions: ['secret'],
      provides: [{ id: 'private.read', version: '1.0.0' }] },
    invoke: () => assert.fail('Private capability should not run'),
  }));
  const requests = [];
  await registry.load(() => httpModel('https://example.test/model', 'fixture-token', async (url, init) => {
    assert.equal(url.origin, 'https://example.test');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.authorization, 'Bearer fixture-token');
    const request = JSON.parse(init.body);
    assert.ok(request.schema.properties.ui);
    assert.ok(request.available.some(item => item.id === 'workbench.commit'));
    assert.ok(!request.available.some(item => item.id === 'private.read' || item.id.startsWith('idas.')));
    requests.push(request);
    if (requests.length === 1) return Response.json({ invalid: true });
    return Response.json(compileWorkbench({ ...request, text: request.previous ? intents.D : intents.A }));
  }));
  await registry.load(() => modelCompiler(undefined, { repair: true, available: registry.available.bind(registry) }));
  const engine = new Engine(registry);
  await apply(engine, 'Build a desk for inspecting software changes');
  assert.ok(requests[1].repair.message);
  await apply(engine, 'On my phone the agent should be in a different view');
  assert.equal(requests[2].previous.ui.presentation.compactMode, 'stack');
  assert.equal((await engine.snapshot(scope)).spec.ui.presentation.compactMode, 'pages');
});
