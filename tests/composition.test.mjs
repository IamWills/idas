import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { Engine, Registry } from '../packages/core/dist/index.js';
import { Workspace } from '../packages/react/dist/index.js';
import { standard } from '../packages/standard/dist/index.js';
import { badgeContract, badgeId, badgeVersion, workbenchBadge, workbenchCompiler, workbenchTools } from '../examples/web/workbench.ts';

const requireWeb = createRequire(new URL('../examples/web/package.json', import.meta.url));
const { createElement } = requireWeb('react');
const { renderToStaticMarkup } = requireWeb('react-dom/server');

async function setup(withBadge = true) {
  const registry = new Registry('node');
  await registry.load(() => standard({ resolve: registry.inspect.bind(registry), tool: registry.invoke.bind(registry) }));
  await registry.load(workbenchCompiler);
  await registry.load(workbenchTools);
  if (withBadge) await registry.load(workbenchBadge);
  return new Engine(registry);
}
const scope = 'desk';
const intent = 'Create a developer workbench with a status badge';
const badge = spec => spec.ui.views.find(view => view.id === 'agent').components.find(node => node.id === 'status-layout').children[0].children[0];

test('a capability-backed nested component renders current state and validates updates before commit', async () => {
  const engine = await setup();
  const preview = await engine.preview(scope, intent);
  assert.deepEqual(preview.bindings.find(binding => binding.capability === badgeId),
    { capability: badgeId, plugin: 'workbench.status-badge', version: badgeVersion });
  const spec = structuredClone(preview.spec);
  spec.interaction.rules.push({ event: 'corrupt', from: 'ready', to: 'ready', set: [{ key: 'status', value: 42 }] });
  const initial = await engine.apply(await engine.previewSpec(scope, spec));
  const registrations = new Map([[badgeId + '@' + badgeVersion, {
    contract: badgeContract,
    render: ({ values }) => createElement('output', null, values.value),
  }]]);
  const render = (snapshot, components) => renderToStaticMarkup(createElement(Workspace, {
    ui: snapshot.spec.ui, data: snapshot.data, mode: snapshot.mode, activeView: 'agent',
    components, onNavigate() {}, onEvent() {},
  }));
  assert.match(render(initial, registrations), /<output>Ready<\/output>/);
  assert.match(render(initial, new Map()), /unavailable on this host/);
  const next = await engine.dispatch(scope, 'acknowledge-status', null, 'ack-1');
  assert.match(render(next, registrations), /<output>Acknowledged<\/output>/);
  await assert.rejects(engine.dispatch(scope, 'corrupt', null, 'bad-1'), { code: 'INVALID' });
  assert.deepEqual(await engine.snapshot(scope), next);
});

test('composition rejects unregistered capabilities, invalid attributes and unsafe layout references', async () => {
  await assert.rejects((await setup(false)).preview(scope, intent), { code: 'MISSING' });
  const engine = await setup();
  const { spec } = await engine.preview(scope, intent);
  for (const mutate of [
    copy => { badge(copy).props = { extra: 'unknown' }; },
    copy => { badge(copy).bindings.value = 'unknown-state'; },
    copy => { badge(copy).props = { value: 'overrides binding' }; },
    copy => { badge(copy).event = 'unknown-event'; },
    copy => { badge(copy).version = '2.0.0'; },
    copy => { copy.ui.views.find(view => view.id === 'agent').components.push({ id: 'status-badge', kind: 'text', label: 'Duplicate' }); },
  ]) {
    const candidate = structuredClone(spec);
    mutate(candidate);
    await assert.rejects(engine.previewSpec(scope, candidate), { code: 'INVALID' });
  }
  assert.equal(await engine.snapshot(scope), null);
});

test('one form contract validates direct events and binds nested input for rendering and tools', async () => {
  const engine = await setup();
  const { spec } = await engine.preview(scope, 'Create a developer workbench with a release settings form and status badge');
  badge(spec).bindings.value = { state: 'releaseSettings', path: ['title'] };
  await engine.registry.load(() => ({
    manifest: { id: 'test.record', version: '1.0.0', environments: ['any'], requires: [], permissions: [],
      provides: [{ id: 'test.record', version: '1.0.0' }] },
    invoke(_capability, input) { return input; },
  }));
  spec.capabilities.push({ id: 'test.record', range: '^1' });
  spec.workflows.push({ id: 'record', tasks: [{
    id: 'write', capability: 'test.record', input: null,
    inputFrom: { state: 'releaseSettings', path: ['channel'] }, saveAs: 'status',
  }] });
  spec.interaction.rules.find(rule => rule.event === 'save-release-settings').workflow = 'record';
  const initial = await engine.apply(await engine.previewSpec(scope, spec));
  const payload = { title: 'Production release', attempts: 3, notify: false, channel: 'stable' };
  for (const invalid of [
    { ...payload, title: '  ' }, { ...payload, attempts: '3' }, { ...payload, attempts: 10 },
    { ...payload, channel: 'unknown' }, { ...payload, notify: 1 }, { ...payload, extra: true },
  ]) {
    await assert.rejects(engine.dispatch(scope, 'save-release-settings', invalid, 'invalid'), { code: 'INVALID' });
  }
  assert.deepEqual(await engine.snapshot(scope), initial);
  const saved = await engine.dispatch(scope, 'save-release-settings', payload, 'valid');
  assert.deepEqual(saved.data.releaseSettings, payload);
  assert.equal(saved.data.status, 'stable');
  const registrations = new Map([[badgeId + '@' + badgeVersion, {
    contract: badgeContract, render: ({ values }) => createElement('output', null, values.value),
  }]]);
  const render = activeView => renderToStaticMarkup(createElement(Workspace, {
    ui: saved.spec.ui, data: saved.data, mode: saved.mode, activeView,
    components: registrations, onNavigate() {}, onEvent() {},
  }));
  assert.match(render('agent'), /<output>Production release<\/output>/);
  assert.match(render('agent'), /value="3"/);
  const nav = markup => markup.match(/<nav[^>]*>(.*?)<\/nav>/s)[1];
  assert.doesNotMatch(nav(render('agent')), />Files</);
  assert.match(nav(render('')), /aria-current="page">Editor/);
  const disconnected = structuredClone(spec);
  disconnected.ui.navigation.routes = [];
  await assert.rejects(engine.previewSpec(scope, disconnected), { code: 'INVALID' });
  const bypass = structuredClone(spec);
  delete bypass.interaction.rules.find(rule => rule.event === 'save-release-settings').input;
  await assert.rejects(engine.previewSpec(scope, bypass), { code: 'INVALID' });
});
