# IDAS · Intent-Driven Adaptive System

IDAS lets users define and continuously change a software workspace through natural language. It compiles intent into a versioned JSON specification (IDSS) for UI, interaction, state and workflows. The host previews the change and authorizes it before applying a new revision. React and SwiftUI interpret the presentation, and deterministic runtime plugins handle interaction and execution.

## Try the developer workbench

Requires Node.js 22 or newer and pnpm 10.4.1.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm web
```

Open the address printed by Vite. Select each example intent, then click **Preview change** and **Apply change**.

1. **A · Create workbench** arranges Files, Editor and Agent Status side by side.
2. **B · Review edits** adds a Diff review and a confirmation step. Edit the demo source and click **Save** to see the proposed change before it becomes the committed code.
3. **C · Gate release** adds a workflow to the Agent panel. The demo check passes when the committed source is `export const ready = true;`. Change and confirm the value to `false` to exercise the stop-and-report path. Build and upload use local demo data.
4. **D · Adapt layout** moves Agent Status below the desktop panels. At narrow widths it appears as a separate navigable view. The saved state and existing behavior carry over.

The included workbench compiler recognizes the scenario instructions and falls back to the basic offline compiler. For open-ended input, a host can register a model provider with `modelCompiler()`. The Node example can call a host-configured model endpoint. The included model tests use a deterministic fixture. The React demo runs an engine with browser persistence. SwiftUI renders exported specifications and exposes callbacks for host event handling.

The CLI still supports the basic offline demo. Try `pnpm demo` or `pnpm demo export /tmp/idas-workspace.json`. To preview the workbench in native SwiftUI, run:

```sh
swift run --package-path packages/sdk-swift IDASDemo packages/sdk-swift/Tests/IDASTests/Fixtures/workbench.json
```

On a narrow screen, create the workbench and click **Suggest a review layout**. The registered adaptation plugin explains the recommendation. Inspect the before and after values, then dismiss or apply it. **Restore previous workspace** restores the revision that preceded the recommendation.

To try a model with the CLI, point `IDAS_MODEL_URL` at a host-owned HTTP service that translates an IDAS model request into a model call and returns a complete IDSS object. Use HTTPS or loopback HTTP. Set `IDAS_MODEL_TOKEN` if the service uses bearer authentication.

```sh
IDAS_MODEL_URL=http://127.0.0.1:8787/compile pnpm demo preview 'Give this workspace a dark review layout'
IDAS_MODEL_URL=http://127.0.0.1:8787/compile pnpm demo apply 'Give this workspace a dark review layout'
```

The request includes the committed specification, the IDSS JSON Schema, the workspace's authorized tool versions and an optional repair diagnostic. The offline compiler remains the default. See [model and extension integration](docs/PLUGINS.md).

See the [implementation audit](docs/IMPLEMENTATION.md) for actual coverage and the [product roadmap](docs/ROADMAP.md) for the remaining release gates.

## Share a local workspace across browser and SwiftUI

Use the authenticated Node example to let both hosts read and update the same workspace. See [shared workspace setup](docs/SHARED-WORKSPACE.md).

## Use from an MCP client

Run `pnpm build` and configure the client to launch the stdio example. It can read the workspace and schema, preview natural-language changes, and request adaptation suggestions. A host can authorize applying previews and dispatching events. See [MCP configuration and tools](docs/MCP.md).

## Integrate

```ts
import { Engine, Registry } from '@intent-driven/core';
import { standard, echoPlugin } from '@intent-driven/standard';

const registry = new Registry('node');
await registry.load(() => standard({
  resolve: registry.inspect.bind(registry),
  tool: registry.invoke.bind(registry),
}));
await registry.load(echoPlugin);
const engine = new Engine(registry);

const change = await engine.preview('desk', 'Use 2 columns and workflow echo "Hello"');
console.log(change.sections, change.bindings);
await engine.apply(change);
const workspace = await engine.dispatch('desk', 'run', null, 'event-1');
console.log(workspace.data.result); // Hello
```

This example uses the workspace packages. The GitHub release distributes npm tarballs; npm registry installation becomes available when the packages are published there. See the [publishing instructions](docs/RELEASING.md).

| Package | Responsibility |
| --- | --- |
| `@intent-driven/contracts` | IDSS schemas, canonical JSON, public plugin and store types |
| `@intent-driven/core` | Registry, version negotiation, preview/apply, dispatch and revision orchestration |
| `@intent-driven/standard` | Offline/model compiler, specification, policy, state, workflow and composition plugins |
| `@intent-driven/node` | File store, signed catalog and isolated Docker plugin adapter |
| `@intent-driven/react` | Responsive accessible components and render capability |
| `@intent-driven/protocols` | MCP tools, A2UI presentation and AG-UI snapshot adapters |
| [IDAS Swift package](packages/sdk-swift) | Native macOS/iOS presentation SDK |

Read the [architecture and API guide](docs/ARCHITECTURE.md), [plugin guide](docs/PLUGINS.md), [security model and compatibility matrix](docs/SECURITY.md), [implementation plan](docs/IMPLEMENTATION.md), and [roadmap](docs/ROADMAP.md). The [IDSS JSON Schema](docs/idss.schema.json) is generated from the TypeScript contract.

```sh
pnpm test
pnpm test:bun
swift test --package-path packages/sdk-swift
```
