import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonical, jsonSchema } from '../packages/contracts/dist/index.js';
import { Registry } from '../packages/core/dist/index.js';
import { compileOffline, diffSpecification, validate } from '../packages/standard/dist/index.js';

const plugin = (id, version, requires = [], permissions = []) => ({
  manifest: { id, version, requires, permissions, environments: ['any'], provides: [{ id: 'demo.tool', version }] },
  invoke: () => id,
});

test('specification previews identify array edits and omit unchanged shifted items', () => {
  const before = compileOffline({ text: 'use 2 columns', scope: 'test', context: null, previous: null });
  const first = { id: 'first', kind: 'text', label: 'First' };
  const middle = { id: 'middle', kind: 'text', label: 'Middle' };
  const last = { id: 'last', kind: 'text', label: 'Last' };
  before.ui.views[0].components = [first, last];
  const after = structuredClone(before);
  after.ui.views[0].components.splice(1, 0, middle);
  const path = '/ui/views/0/components';
  assert.deepEqual(diffSpecification(before, after), {
    entries: [{ path: path + '/1', operation: 'add', after: middle }], truncated: false,
  });
  assert.deepEqual(diffSpecification(after, before), {
    entries: [{ path: path + '/1', operation: 'remove', before: middle }], truncated: false,
  });
  after.ui.views[0].components = [{ ...first, label: 'Renamed' }, last];
  assert.deepEqual(diffSpecification(before, after), {
    entries: [{ path: path + '/0/label', operation: 'replace', before: 'First', after: 'Renamed' }], truncated: false,
  });

  before.intent.context = [];
  after.intent.context = Array.from({ length: 101 }, (_, index) => index);
  after.ui = structuredClone(before.ui);
  const bounded = diffSpecification(before, after);
  assert.equal(bounded.entries.length, 100);
  assert.equal(bounded.truncated, true);
  assert.deepEqual(bounded.entries[99], { path: '/intent/context/99', operation: 'add', after: 99 });
  after.intent.context.pop();
  assert.equal(diffSpecification(before, after).truncated, false);
});
test('IDSS is strict, deterministic and migratable', () => {
  const s = compileOffline({ text: 'use 2 columns', scope: 'test', context: null, previous: null });
  assert.deepEqual(validate(s), s);
  assert.equal(canonical({ z: 1, a: [false] }), '{"a":[false],"z":1}');
  assert.equal(jsonSchema().additionalProperties, false);
  assert.throws(() => validate({ ...s, execute: 'shell' }), { code: 'INVALID' });
  assert.throws(() => canonical(JSON.parse('{"__proto__":{}}')), { code: 'INVALID' });
  const old = structuredClone(s);
  old.metadata.schemaVersion = 0;
  delete old.ui.theme;
  assert.equal(validate(old).ui.theme, 'system');
});
test('registry negotiates versions, ignores denied providers and manages lifecycle', async () => {
  const lifecycle = [];
  const registry = new Registry('test');
  await registry.load(() => ({ ...plugin('baseline', '1.0.0'), start: () => lifecycle.push('start'), stop: () => lifecycle.push('stop') }));
  await registry.load(() => plugin('restricted', '1.2.0', [], ['secret']));
  await registry.load(() => plugin('wrong-major', '2.0.0'));
  assert.equal(registry.inspect({ id: 'demo.tool', range: '^1' }, 'test').plugin, 'baseline');
  await registry.unload('baseline');
  assert.throws(() => registry.inspect({ id: 'demo.tool', range: '^1' }, 'test'), { code: 'DENIED' });
  assert.throws(() => registry.inspect({ id: 'demo.tool', range: '^3' }, 'test'), { code: 'MISSING' });
  assert.deepEqual(lifecycle, ['start', 'stop']);
});
