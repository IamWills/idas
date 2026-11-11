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

## Register a native UI component

Use `uiComponentPlugin` from `@intent-driven/contracts` to register a portable property contract. The host separately binds trusted renderer code to the exact `capability@version` key. One IDSS node can select a React component in the browser and a SwiftUI view in a native host.

```ts
const contract = {
  properties: { value: { kind: 'string', required: true } },
  emitsEvent: true,
} as const;

await registry.load(() => uiComponentPlugin(
  { id: 'example.status', version: '1.0.0', environments: ['any'], permissions: [] },
  { id: 'ui.example.status', version: '1.0.0', contract },
));
```

Add `{ "id": "ui.example.status", "range": "1.0.0" }` to IDSS capabilities. Put a node like this in a view or inside the children of a layout.

```json
{
  "id": "status-badge",
  "kind": "plugin",
  "label": "Status",
  "capability": "ui.example.status",
  "version": "1.0.0",
  "bindings": { "value": "status" },
  "event": "acknowledge-status"
}
```

`kind: "layout"` nodes accept ordered `children` and a `layout` of `stack`, `row`, or `grid`. Grids accept one to four columns. A view can contain up to 100 nodes and twelve levels. Node IDs are unique within the whole view.

Use `props` for literal values and `bindings` to read top-level committed state by key. The same property cannot have both. Property contracts accept string, number, boolean and JSON values, and can mark individual properties required. The standard composer validates the declared initial values during preview. Standard state storage validates resolved values again before committing. Renderers also check their own native contract before calling the implementation.

For React, pass a map of `ReactComponentRegistration` objects to `Workspace`. For SwiftUI, pass a dictionary of `NativeComponent` objects with the same property contract. The renderer can emit a payload through the callback for the event declared on the node. Engine policy and state-machine rules govern that event. Hosts without a native registration show an unavailable message. IDSS carries only data, and component capabilities cannot run as workflow tools.

Try the workbench's **Add a status badge** intent. Apply the preview, then acknowledge the badge to see the bound state update. The same capability is registered by the shared host and rendered natively by both example clients.

## Add a typed form

A `kind: "form"` node declares up to 20 fields and one event. React and SwiftUI render text and number inputs, booleans and enumerated choices. Set `required` to require a field in the submitted object. A required boolean can be false. Text fields accept `minLength` and `maxLength`. Number fields accept `min` and `max`. A choice field must list its allowed options.

Each transition for the form's event uses `input: { "kind": "form", "id": "<form-id>" }`. The interaction plugin rejects unexpected keys and invalid values before it captures data or starts a workflow. Form IDs are unique across the specification.

A state binding accepts either a top-level key or `{ "state": "releaseSettings", "path": ["channel"] }`. Paths can address object keys and array indices, such as `["0", "title"]`. Forms use bindings as defaults. Native component properties and workflow inputs can use the same paths. A missing workflow input fails before that tool runs.

Optional `ui.navigation` declares an `initial` view and directed `routes` as `{ "from": "editor", "to": "agent" }` pairs. Each view must be reachable from the initial view. The renderer uses the routes for single-view navigation. Wide panels and compact stacks retain their declared layout. Routes control presentation. The engine still checks state and policy when it receives an event.

To try the example, create a developer workbench and select **Add a release settings form**. The form appears in the Agent panel. In the shared workspace, submit it on either platform and refresh the other to see the saved values.
