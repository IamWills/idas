import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { canonical } from '../packages/contracts/dist/index.js';
import { createSharedWorkspace } from '../examples/node-agent/shared.mjs';

async function withWorkspace(extensions, exercise) {
  const directory = await mkdtemp(join(tmpdir(), 'idas-shared-test-'));
  const token = randomBytes(32).toString('base64url');
  const server = await createSharedWorkspace({ directory, token, extensions });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const endpoint = 'http://127.0.0.1:' + server.address().port + '/api/idas';
    const client = credentials => async (action, fields = {}) => {
      const response = await fetch(endpoint, {
        method: 'POST', headers: { authorization: 'Bearer ' + credentials, 'content-type': 'application/json' },
        body: JSON.stringify({ action, ...fields }),
      });
      return { status: response.status, body: await response.json() };
    };
    await exercise(client(token), client('wrong'), client(token));
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}

test('authenticated shared clients see one revision and cannot apply stale suggestions or rollback over edits', async () => {
  await withWorkspace(undefined, async (desktop, stranger, phone) => {
    assert.equal((await stranger('snapshot')).status, 401);
    assert.equal((await desktop('snapshot', { scope: 'other' })).status, 400);

    const { body: { preview: initial } } = await desktop('preview', { intent: 'Create a developer workbench' });
    const { body: { snapshot: seeded } } = await desktop('apply', { token: initial.token });
    assert.equal(seeded.revision, 1);
    assert.equal((await phone('snapshot')).body.snapshot.revision, 1);
    assert.equal((await phone('recommend', { context: { device: 'phone', task: 'review', secret: 'no' } })).status, 400);
    assert.equal((await desktop('recommend', { context: { device: 'desktop', task: 'review' } })).body.preview, null);

    const recommend = async () => (await phone('recommend', { context: { device: 'phone', task: 'review' } })).body.preview;
    const stale = await recommend();
    assert.match(stale.reason, /phone/);
    assert.equal((await desktop('snapshot')).body.snapshot.revision, 1);
    const edit = { event: 'edit', input: 'export const ready = false;', eventId: 'edit-1' };
    assert.equal((await desktop('dispatch', edit)).body.snapshot.revision, 2);
    assert.equal((await phone('apply', { token: stale.token })).status, 409);
    const fresh = await recommend();
    const { body: { snapshot: applied } } = await phone('apply', { token: fresh.token });
    assert.equal(applied.spec.ui.presentation.compactMode, 'pages');
    assert.equal((await desktop('snapshot')).body.snapshot.data.committed, edit.input);
    assert.equal((await phone('apply', { token: fresh.token })).status, 400);
    assert.equal(await recommend(), null);
    const { body: { snapshot: restored } } = await desktop('rollback', { revision: 2, expectedRevision: applied.revision });
    assert.equal(restored.spec.ui.presentation.compactMode, 'stack');
    assert.equal(restored.data.committed, edit.input);
    assert.equal((await phone('rollback', { revision: 1, expectedRevision: applied.revision })).status, 409);
  });
});

const intent = 'Add an action to inspect the workspace';
const expected = { readOnly: true, noNetwork: true, noSecret: true };
const capability = 'workbench.inspect';
function extensionConfig(image, grants) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const descriptor = {
    format: 'idas.sandbox.v1', keyId: 'test', expiresAt: Date.now() + 120_000, image,
    manifest: {
      id: 'workbench.inspection-sandbox', version: '1.0.0', environments: ['node'], requires: [],
      permissions: [capability], provides: [{ id: capability, version: '1.0.0' }],
    },
  };
  const signature = sign(null, Buffer.from(canonical(descriptor)), privateKey).toString('base64url');
  return {
    trustedKeys: { test: publicKey.export({ type: 'spki', format: 'pem' }) },
    publisherScopes: { test: { plugins: ['workbench.inspection-sandbox'], capabilities: [capability] } },
    entries: [{ descriptor, signature }],
    activations: [{ signature, grants, probes: [{ capability, input: null, expected }] }],
  };
}

async function seed(client) {
  const { body: { preview } } = await client('preview', { intent: 'Create a developer workbench' });
  assert.equal((await client('apply', { token: preview.token })).body.snapshot.revision, 1);
}

test('a signed suggestion with insufficient host grants cannot be activated', async () => {
  const config = extensionConfig('sha256:' + '1'.repeat(64), []);
  await withWorkspace(config, async (client, stranger) => {
    await seed(client);
    const { body: { proposal } } = await client('suggestExtension', { intent });
    const [candidate] = proposal.candidates;
    assert.equal(proposal.requirement.id, capability);
    assert.equal(candidate.canActivate, false);
    const selection = { intent, signature: candidate.signature };
    assert.equal((await stranger('activateExtension', selection)).status, 401);
    assert.equal((await client('activateExtension', { intent, signature: 'a'.repeat(86) })).status, 403);
    assert.equal((await client('activateExtension', selection)).status, 403);
    assert.equal((await client('preview', { intent })).body.requirement.id, capability);
    assert.equal((await client('snapshot')).body.snapshot.revision, 1);
  });
});

const dockerTest = process.env.IDAS_SANDBOX_IMAGE ? test : test.skip;
dockerTest('a reviewed extension passes isolation probes and the original intent can be applied and run', async () => {
  await withWorkspace(extensionConfig(process.env.IDAS_SANDBOX_IMAGE, [capability]), async client => {
    await seed(client);
    const { body: { proposal } } = await client('suggestExtension', { intent });
    const [candidate] = proposal.candidates;
    assert.equal(candidate.canActivate, true);
    assert.equal((await client('activateExtension', { intent, signature: candidate.signature })).status, 200);
    assert.equal((await client('snapshot')).body.snapshot.revision, 1);
    const { body: { preview } } = await client('preview', { intent });
    assert.equal(preview.change.bindings.find(binding => binding.capability === capability).plugin, 'workbench.inspection-sandbox');
    await client('apply', { token: preview.token });
    const { body: { snapshot } } = await client('dispatch', { event: 'inspect', eventId: 'inspection-1' });
    assert.deepEqual(snapshot.data.inspection, expected);
  });
});

dockerTest('a failed contract probe leaves the extension unregistered', async () => {
  const config = extensionConfig(process.env.IDAS_SANDBOX_IMAGE, [capability]);
  config.activations[0].probes[0].expected = { readOnly: false };
  await withWorkspace(config, async client => {
    await seed(client);
    const signature = config.entries[0].signature;
    const failed = await client('activateExtension', { intent, signature });
    assert.equal(failed.status, 400);
    assert.match(failed.body.message, /probe failed/);
    assert.equal((await client('preview', { intent })).body.requirement.id, capability);
    assert.equal((await client('snapshot')).body.snapshot.revision, 1);
  });
});
