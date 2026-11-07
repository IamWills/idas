import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';
import { canonical } from '../packages/contracts/dist/index.js';
import { Engine, Registry } from '../packages/core/dist/index.js';
import { sandboxCatalog } from '../packages/node/dist/index.js';

const requirement = { id: 'text.normalize', range: '^1.0.0' };
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const trustedKeys = { acme: publicKey.export({ type: 'spki', format: 'pem' }) };

function candidate(version, environment = 'node', expiresAt = Date.now() + 60_000) {
  const descriptor = {
    format: 'idas.sandbox.v1', keyId: 'acme', expiresAt,
    image: 'example.test/plugins/normalize@sha256:' + '1'.repeat(64),
    manifest: {
      id: 'acme.normalize', version, environments: [environment], requires: [],
      permissions: ['sandbox.use'], provides: [{ id: requirement.id, version }],
    },
  };
  return { descriptor, signature: sign(null, Buffer.from(canonical(descriptor)), privateKey).toString('base64url') };
}

test('engine suggests only compatible signed catalog releases without registering them', async () => {
  const releases = [candidate('1.0.0'), candidate('1.2.0'), candidate('2.0.0'), candidate('1.3.0', 'bun')];
  const catalog = sandboxCatalog({
    environment: 'node', trustedKeys,
    async load(query, signal) {
      assert.deepEqual(query, requirement);
      assert.equal(signal.aborted, false);
      return releases;
    },
  });
  const registry = new Registry('node');
  await registry.load(catalog.evolutionPlugin);
  const suggestion = await new Engine(registry).suggest('desk', requirement);
  assert.equal(suggestion.status, 'proposal');
  assert.deepEqual(suggestion.candidates.map(entry => entry.descriptor.manifest.version), ['1.2.0', '1.0.0']);
  assert.throws(() => registry.inspect(requirement, 'desk'), { code: 'MISSING' });
});

test('catalog rejects tampered images and permissions, unknown keys and expired signatures before activation', async () => {
  const valid = candidate('1.0.0');
  const tamperedImage = structuredClone(valid);
  tamperedImage.descriptor.image = 'sha256:' + '2'.repeat(64);
  const tamperedPermissions = structuredClone(valid);
  tamperedPermissions.descriptor.manifest.permissions.push('admin');
  const expired = candidate('1.0.0', 'node', Date.now() - 1000);
  let response = [];
  const catalog = sandboxCatalog({ environment: 'node', trustedKeys, load: async () => response });
  for (const entry of [tamperedImage, tamperedPermissions, expired]) {
    response = [entry];
    await assert.rejects(catalog.discover(requirement), { code: 'DENIED' });
    await assert.rejects(catalog.approve(requirement, entry, {
      probes: [], approve: () => assert.fail('Unverified descriptor reached host approval'),
    }), { code: 'DENIED' });
  }
  const unknownPublisher = sandboxCatalog({ environment: 'node', trustedKeys: {}, load: async () => [valid] });
  await assert.rejects(unknownPublisher.discover(requirement), { code: 'DENIED' });
  await assert.rejects(catalog.approve({ ...requirement, range: '^2' }, valid, {
    probes: [], approve: () => assert.fail('Incompatible descriptor reached host approval'),
  }), { code: 'MISSING' });
  await assert.rejects(catalog.approve(requirement, valid, {
    probes: [], approve: () => assert.fail('Missing probes bypassed the sandbox'),
  }), { code: 'INVALID' });
});
