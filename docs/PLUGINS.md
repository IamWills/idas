# Plugins

Plugins declare a SemVer manifest, supported environments, provided capability versions, required capability ranges and requested permissions. A plugin may provide several capabilities; prefer a capability contract over a dependency on a plugin name.

```ts
import type { Plugin } from '@intent-driven/contracts';

const normalize: Plugin = {
  manifest: {
    id: 'acme.normalize', version: '1.0.0', environments: ['any'],
    requires: [], permissions: [],
    provides: [{ id: 'text.normalize', version: '1.0.0' }],
  },
  invoke(_capability, input, ctx) {
    ctx.signal.throwIfAborted();
    if (typeof input !== 'string') throw new TypeError('Expected text');
    return input.trim().normalize('NFC');
  },
};
await registry.load(() => normalize);
```

Reference it with `{"id":"text.normalize","range":"^1.0.0"}` in IDSS capabilities and `"capability":"text.normalize"` in a workflow task. Validate inputs and outputs in the adapter, honor cancellation, and use `ctx.operation` as the external deduplication key for effects. Use `ctx.call` only for declared requirements. Avoid effects in lifecycle and UI composition hooks; lifecycle owns resource setup and teardown.

The trusted standard plugin provides composable IDSS services. A compatible provider can override a service by offering a higher compatible capability version. Core verifies resolver bindings against the registry's authorized execution plan. A host can curate which providers enter the registry and inspect candidate manifests before activation.

For an LLM, register an `idas.model` provider and load `modelCompiler()`. The model capability receives JSON with `text`, `scope`, `context` and `previous` and returns a candidate IDSS JSON object. Give the provider the schema via `jsonSchema()`, apply your own disclosure policy to context, and keep provider credentials outside IDSS. The compiler validates model output and Core resolves actual capabilities and policy before application. The offline compiler is suitable for reproducible demos and tests; an LLM plugin is required for free-form intent beyond its command vocabulary.

For untrusted extensions, use the [sandbox flow](SECURITY.md). Never dynamically import an untrusted package into a trusted registry factory.

## Discover signed sandbox plugins

A Node host can use `sandboxCatalog()` from `@intent-driven/node` to offer extensions for a missing capability. Configure it with a host-owned `load(requirement, signal)` function and Ed25519 public keys pinned by the host. The transport can read a local catalog or fetch an HTTPS endpoint configured by the host. It receives only the capability ID and version range. Apply response size and request time limits in the transport before parsing.

```ts
import { sandboxCatalog } from '@intent-driven/node';

const catalog = sandboxCatalog({
  environment: 'node',
  trustedKeys: { acme: publisherPublicKeyPem },
  load: loadFromHostCatalog,
});

await registry.load(catalog.evolutionPlugin);
const requirement = { id: 'text.normalize', range: '^1.0.0' };
const proposal = await engine.suggest('desk', requirement);
const candidates = await catalog.discover(requirement);
```

Review the candidates and provision the selected immutable image into the host's Docker daemon. Pass the selected entry, host-authored probes, and an approval callback to `catalog.approve(requirement, entry, { probes, approve })`. It rechecks the signature, expiry and compatibility, then runs the existing sandbox approval flow. Register the returned plugin with `registry.load(() => plugin)` after approval. Registry permission checks still govern invocation.

Publishers create a JSON envelope containing `descriptor` and `signature`. The descriptor contains `format: 'idas.sandbox.v1'`, `keyId`, `expiresAt` in Unix milliseconds, `image` pinned by SHA-256, and the full plugin `manifest`. With Node's Ed25519 private key, calculate the signature as `sign(null, Buffer.from(canonical(descriptor), 'utf8'), privateKey).toString('base64url')`. Import `canonical` from `@intent-driven/contracts`. Catalog discovery rejects malformed or unverifiable entries and returns compatible releases ordered by capability version.

### Configure the structured model request

Pass `{ available: registry.available.bind(registry), repair: true }` to `modelCompiler()` to send a validated `ModelRequest` to the model plugin. The request contains intent text, scope, the host context, the previous IDSS, JSON Schema and authorized tool versions. On a schema or semantic failure, the compiler retries once with a bounded diagnostic. Providers that use the original request shape can omit the option. Scope and capability checks still run in Engine before a preview can be applied.

### Run the extension example

Create a private host configuration JSON object with `spec`, `trustedKeys`, `publisherScopes`, `entries`, `probes` and `grants`. The spec must reference the missing capability. Each signer in `publisherScopes` has `plugins` and `capabilities` arrays of dot-delimited namespaces. Entries are signed descriptor envelopes. Probes are the same host-authored `{ capability, input, expected }` entries accepted by the sandbox, and grants are explicit permission strings for the selected plugin.

```sh
node examples/node-agent/extension.mjs suggest ./host-config.json
node examples/node-agent/extension.mjs activate ./host-config.json SIGNATURE run
```

The first command returns the matching signed candidates or a development checklist. Review the exact candidate and provision its immutable image before running the second command. The signature selects a reviewed descriptor. Activation verifies it again, runs the sandbox probes, and registers the plugin for that invocation. The optional final argument dispatches an event after applying the specification.
