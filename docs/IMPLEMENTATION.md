# Implementation plan

Each stage has a local verification gate. Update this checklist as the gates pass.

- [x] Foundation: IDSS and plugin contracts, validation, lifecycle and dependency negotiation.
- [x] Intent execution: preview, approval, compare-and-swap storage, rollback and deterministic dispatch.
- [x] Hosts: offline natural-language compiler, workflows, Node CLI and responsive React workspace.
- [x] Portability: Node/Bun checks, native SwiftUI, pinned protocol subsets with contract tests.
- [x] Evolution: missing-capability proposals, isolated plugin runner, staged approval and teardown.
- [x] Release preparation: license, integration docs, CI and package archives.

The Docker integration gate runs in Linux CI. The local checks cover Node, Bun, browser persistence, macOS Swift tests and iOS SDK type checking.

Dependencies flow from host adapters into contracts and core. Core orchestrates plugin capabilities. Standard plugins implement IDSS validation, state, composition and execution. IDSS carries JSON only; the host supplies identities, grants and policy. Untrusted executable plugins never enter the host process.

References: [Zod JSON Schema](https://zod.dev/json-schema), [pnpm workspace packaging](https://pnpm.io/workspaces/), [Semantic Versioning](https://semver.org/), [MCP tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools), [A2UI v0.9](https://github.com/a2ui-project/a2ui/blob/main/specification/v0_9/docs/a2ui_protocol.md), [AG-UI events](https://docs.ag-ui.com/concepts/events).
