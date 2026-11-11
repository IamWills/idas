import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MissingCapabilityError, services } from '../packages/contracts/dist/index.js';
import { Engine, Registry } from '../packages/core/dist/index.js';
import { modelCompiler, standard } from '../packages/standard/dist/index.js';
import { httpModel } from '../examples/node-agent/http-model.mjs';
import { compileWorkbench, workbenchCompiler, workbenchTools } from '../examples/web/workbench.ts';

const intents = {
  A: '将当前应用改造成开发工作台，左侧显示文件、中间显示编辑器、右侧显示 Agent 状态。',
  B: '修改代码前先显示 Diff，需要我确认后才能提交。',
  C: '每次发布前先测试，成功后构建并上传，失败则停止并报告。',
  D: '把右侧 Agent 面板改到底部，并且在手机上改成独立页面。',
};

async function setup({ tools = workbenchTools(), authorize } = {}) {
  const registry = new Registry('node', authorize);
  await registry.load(() => standard({
    resolve: registry.inspect.bind(registry), tool: registry.invoke.bind(registry),
  }));
  await registry.load(workbenchCompiler);
  if (tools) await registry.load(() => tools);
  return { engine: new Engine(registry), registry };
}
const scope = 'desk';
const apply = async (engine, text) => engine.apply(await engine.preview(scope, text));

const promptVariants = [
  {
    A: 'Make a coding desk with the file list, source editor, and assistant status side by side, in that order. Stack them on narrow screens. Save edits immediately for now.',
    B: 'Stage each source edit and show me what changed. Only save it once I approve the diff. Reject empty edits.',
    C: 'When I request a release, run the tests on saved code first. If they fail, show a failure report and stop. Otherwise package the saved code and send the resulting artifact to the demo target.',
    D: 'Keep files beside the editor and put assistant status in a row underneath. On a phone, make each panel a separate page, starting with the editor. Keep the existing behavior and data.',
  },
  {
    A: '搭一个写代码的界面，桌面上从左到右是文件、源码编辑器和助手状态，窄屏上先纵向排列。暂时直接保存编辑。',
    B: '以后不要直接保存。编辑后先展示新旧代码的差异，等我同意后再保存。空内容不接受。',
    C: '发版时先检测已保存的源码，通过了才打包并把产物送往演示目标。检测不过就显示失败报告并结束。',
    D: '文件和编辑器继续并排，把助手状态挪到下一行。窄屏时三块内容各用一页，默认打开编辑器，现有行为和数据都保留。',
  },
];

const modelContext = {
  host: 'In-memory workbench acceptance workspace. Use the request scope and return a complete IDSS specification.',
  interface: 'Use view IDs files, editor, agent. Use event IDs edit (source text), confirm and release (null payloads). Use modes ready and review. Use state keys draft, committed, diff and report for the corresponding values. Start with "export const ready = true;" as the draft and committed source.',
  tools: {
    'workbench.commit': 'Takes source text and returns the saved text.',
    'workbench.diff': 'Takes {before: committed source, after: draft source} and returns a unified diff string.',
    'workbench.test': 'Takes committed source text and returns a boolean.',
    'workbench.report': 'Takes a message containing "Tests failed" and returns it for display.',
    'workbench.build': 'Takes committed source text and returns an artifact string.',
    'workbench.upload': 'Takes the artifact string and returns an upload report.',
  },
};

async function checkWorkbench(prompts, provider) {
  const calls = [];
  const inputs = [];
  const tools = workbenchTools();
  let allowTools = true;
  const { engine, registry } = await setup({
    authorize: (permission, plugin, workspace) => workspace === scope && (
      (permission === 'model.http' && plugin === 'example.http-model') ||
      (permission === 'workbench.demo' && plugin === tools.manifest.id && allowTools)
    ),
    tools: {
      ...tools,
      manifest: { ...tools.manifest, permissions: ['workbench.demo'] },
      invoke(id, input, ctx) {
        calls.push(id);
        inputs.push(input);
        return tools.invoke(id, input, ctx);
      },
    },
  });
  if (provider) {
    await registry.load(() => provider);
    await registry.load(() => modelCompiler(undefined, { repair: true, available: registry.available.bind(registry) }));
  }
  const previewTurn = async turn => {
    try { return await engine.preview(scope, prompts[turn], provider ? modelContext : null); }
    catch (cause) { throw new Error('Preview failed in scenario ' + turn, { cause }); }
  };
  const preview = await previewTurn('A');
  assert.ok(preview.sections.includes('ui'));
  assert.ok(preview.bindings.some(binding => binding.capability === 'workbench.commit'));
  assert.equal(await engine.snapshot(scope), null);
  const first = await engine.apply(preview);
  await assert.rejects(engine.apply(preview), { code: 'CONFLICT' });
  assert.deepEqual((await engine.view(scope)).presentation.wide, [['files', 'editor', 'agent']]);
  assert.equal(first.spec.ui.presentation.compactMode, 'stack');
  const changed = 'export const ready = false;';
  assert.equal((await engine.dispatch(scope, 'edit', changed, 'initial-edit')).data.committed, changed);
  await engine.dispatch(scope, 'edit', first.data.committed, 'restore-source');
  calls.length = 0;
  const review = await engine.apply(await previewTurn('B'));
  const editor = review.spec.ui.views.find(view => view.id === 'editor');
  const visibleIn = (nodes, mode, match) => nodes.some(node =>
    (!node.modes || node.modes.includes(mode)) &&
    (node.kind === 'layout' ? visibleIn(node.children, mode, match) : match(node)));
  const confirm = node => node.kind === 'button' && node.event === 'confirm';
  assert.ok(visibleIn(editor.components, 'review', confirm));
  assert.ok(!visibleIn(editor.components, 'ready', confirm));
  assert.ok(visibleIn(editor.components, 'review', node => node.kind === 'value' && node.state === 'diff'));
  await assert.rejects(engine.dispatch(scope, 'confirm', null, 'early'), { code: 'INVALID' });
  await assert.rejects(engine.dispatch(scope, 'edit', '', 'empty'), { code: 'INVALID' });
  assert.deepEqual(calls, []);
  const pending = await engine.dispatch(scope, 'edit', changed, 'edit1');
  assert.equal(pending.mode, 'review');
  assert.equal(pending.data.committed, first.data.committed);
  assert.match(pending.data.diff, /-export const ready = true;\n\+export const ready = false;/);
  assert.deepEqual(calls, ['workbench.diff']);
  const accepted = await engine.dispatch(scope, 'confirm', null, 'confirmed');
  assert.equal(accepted.mode, 'ready');
  assert.equal(accepted.data.committed, changed);

  const release = await previewTurn('C');
  allowTools = false;
  await assert.rejects(engine.previewSpec(scope, release.spec), { code: 'DENIED' });
  allowTools = true;
  const beforeRelease = await engine.apply(release);
  calls.length = 0;
  inputs.length = 0;
  allowTools = false;
  await assert.rejects(engine.dispatch(scope, 'release', null, 'denied-release'), { code: 'DENIED' });
  assert.deepEqual(calls, []);
  assert.deepEqual(await engine.snapshot(scope), beforeRelease);
  allowTools = true;
  const failed = await engine.dispatch(scope, 'release', null, 'release1');
  assert.match(failed.data.report, /Tests failed/);
  assert.deepEqual(calls, ['workbench.test', 'workbench.report']);
  assert.equal(inputs[0], changed);
  await engine.dispatch(scope, 'edit', first.data.committed, 'edit2');
  await engine.dispatch(scope, 'confirm', null, 'confirmed2');
  calls.length = 0;
  inputs.length = 0;
  const released = await engine.dispatch(scope, 'release', null, 'release2');
  assert.match(released.data.report, /Uploaded to demo target/);
  assert.deepEqual(calls, ['workbench.test', 'workbench.build', 'workbench.upload']);
  assert.deepEqual(inputs, [first.data.committed, first.data.committed, 'demo-artifact:' + first.data.committed.length]);

  const move = await previewTurn('D');
  assert.ok(move.sections.includes('ui'));
  assert.ok(move.sections.every(section => ['intent', 'metadata', 'ui'].includes(section)));
  const adapted = await engine.apply(move);
  const { presentation, navigation } = await engine.view(scope);
  assert.deepEqual(presentation.wide, [['files', 'editor'], ['agent']]);
  assert.equal(presentation.compactMode, 'pages');
  assert.equal(presentation.compact[0], 'editor');
  assert.equal(navigation?.initial ?? presentation.compact[0], 'editor');
  assert.deepEqual(new Set(presentation.compact), new Set(['editor', 'files', 'agent']));
  assert.deepEqual(adapted.data, released.data);
  const invalid = structuredClone(adapted.spec);
  invalid.ui.presentation.compact = ['editor', 'editor', 'agent'];
  await assert.rejects(engine.previewSpec(scope, invalid), { code: 'INVALID' });
  assert.deepEqual(await engine.snapshot(scope), adapted);
  assert.equal((await engine.rollback(scope, released.revision)).spec.ui.presentation.wide[0].length, 3);
}

test('A–D: intent creates a workbench, gates commits and releases, then adapts the existing workspace', () => {
  return checkWorkbench(intents);
});

for (const [index, prompts] of promptVariants.entries()) {
  const language = index === 0 ? 'English' : 'Chinese';
  test('model fixture A–D (' + language + ')', async () => {
    let previous;
    const turns = [];
    const provider = httpModel('https://example.test/compile', undefined, async (_url, init) => {
      const request = JSON.parse(init.body);
      const turn = Object.keys(prompts).find(key => prompts[key] === request.text);
      assert.ok(turn, 'Model must receive the paraphrased intent');
      assert.deepEqual(request.context, modelContext);
      assert.deepEqual(request.previous, previous ?? null);
      assert.ok(request.schema.properties.ui);
      assert.ok(request.available.some(item => item.id === 'workbench.commit'));
      turns.push(turn);
      previous = compileWorkbench({ ...request, text: intents[turn] });
      return Response.json(previous);
    });
    await checkWorkbench(prompts, provider);
    assert.deepEqual(turns, ['A', 'B', 'C', 'D']);
  });

  if (process.env.IDAS_MODEL_EVAL === '1') {
    test('live model A–D (' + language + ')', async () => {
      assert.ok(process.env.IDAS_MODEL_URL, 'Set IDAS_MODEL_URL to a configured IDSS model endpoint');
      await checkWorkbench(prompts, httpModel(process.env.IDAS_MODEL_URL, process.env.IDAS_MODEL_TOKEN));
    });
  }
}

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
