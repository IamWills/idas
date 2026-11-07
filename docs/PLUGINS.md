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
