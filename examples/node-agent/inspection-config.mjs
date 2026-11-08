import { generateKeyPairSync, sign } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { canonical, sandboxDescriptor } from '../../packages/contracts/dist/index.js';

const [image, output] = process.argv.slice(2);
if (!image || !output) throw new Error('Usage: node examples/node-agent/inspection-config.mjs <immutable-image> <new-config.json>');
const capability = 'workbench.inspect';
const descriptor = sandboxDescriptor.parse({
  format: 'idas.sandbox.v1', keyId: 'demo', expiresAt: Date.now() + 86_400_000, image,
  manifest: {
    id: 'workbench.inspection-sandbox', version: '1.0.0', environments: ['node'], requires: [],
    permissions: [capability], provides: [{ id: capability, version: '1.0.0' }],
  },
});
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const signature = sign(null, Buffer.from(canonical(descriptor)), privateKey).toString('base64url');
const config = {
  trustedKeys: { demo: publicKey.export({ type: 'spki', format: 'pem' }) },
  publisherScopes: { demo: { plugins: ['workbench.inspection-sandbox'], capabilities: [capability] } },
  entries: [{ descriptor, signature }],
  activations: [{
    signature, grants: [capability],
    probes: [{ capability, input: null, expected: { readOnly: true, noNetwork: true, noSecret: true } }],
  }],
};
await writeFile(output, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
