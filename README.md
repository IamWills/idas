# IDAS · Intent-Driven Adaptive System

IDAS is an MIT-licensed SDK for changing a software workspace through natural language. The compiler proposes a versioned JSON specification (IDSS). The host reviews what would change, resolves and authorizes capabilities, and applies the change as a new workspace revision. Later events execute the saved state machine and workflows without calling a model.

## Try it

Requires Node.js 22 or newer and pnpm 10.4.1.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm demo
pnpm demo show
pnpm web
```

Open the address printed by Vite. Preview and apply the suggested change, then click **Run workflow** and open **Results**. Reload to see the saved workspace. The built-in compiler supports layout, theme, status text and the example echo workflow in English and Chinese. Try:

```sh
pnpm demo apply '单列布局，状态改成“已同步”，工作流回显“更新成功”'
pnpm demo run
pnpm demo export /tmp/idas-workspace.json
swift run --package-path packages/sdk-swift IDASDemo /tmp/idas-workspace.json
```

The CLI stores local revisions in `.idas-data` (override with `IDAS_DATA`). The web host uses browser storage and Web Locks. SwiftUI consumes the same exported JSON, renders native controls and emits events; a production Swift host forwards those events to a trusted engine.

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
| `@intent-driven/node` | File store and isolated Docker plugin adapter |
| `@intent-driven/react` | Responsive accessible components and render capability |
| `@intent-driven/protocols` | MCP tools, A2UI presentation and AG-UI snapshot adapters |
| [IDAS Swift package](packages/sdk-swift) | Native macOS/iOS presentation SDK |

Read the [architecture and API guide](docs/ARCHITECTURE.md), [plugin guide](docs/PLUGINS.md), [security model and compatibility matrix](docs/SECURITY.md), [implementation plan](docs/IMPLEMENTATION.md), and [roadmap](docs/ROADMAP.md). The [IDSS JSON Schema](docs/idss.schema.json) is generated from the TypeScript contract.

```sh
pnpm test
pnpm test:bun
swift test --package-path packages/sdk-swift
```
