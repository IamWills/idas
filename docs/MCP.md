# IDAS MCP server

The Node adapter exposes a workspace to local MCP clients over stdio. It uses the official MCP TypeScript SDK v2 and is tested with the 2026-07-28 protocol and the 2025-11-25 compatibility handshake. MCP transports requests into the existing Engine. Compiler, adaptation, workflow, policy and storage still run through the IDAS Registry.

## Start the example

Build the workspace with Node.js 22.18+.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm mcp:stdio
```

An MCP host normally launches the child process itself. Use an absolute path in its stdio configuration. This is a common client configuration shape.

```json
{
  "mcpServers": {
    "idas": {
      "command": "node",
      "args": ["/absolute/path/idas/examples/node-agent/mcp.mjs"],
      "env": {
        "IDAS_DATA": "/absolute/path/private-idas-data"
      }
    }
  }
}
```

Set `IDAS_MCP_ALLOW_WRITES=1` in the configuration of a trusted local demo client to enable writes. The example stores its workspace locally and its tools operate on demo data. Configure `IDAS_MODEL_URL` and, if necessary, `IDAS_MODEL_TOKEN` to connect the host-owned model bridge. Without a model endpoint the example uses the deterministic workbench and offline compiler.

| MCP surface | Behavior |
| --- | --- |
| Resource `idas://schemas/idss` | Read the IDSS JSON Schema. |
| Resource `idas://workspace/snapshot` | Read the committed workspace, or null before the first revision. |
| `idas_preview_intent` | Compile natural language, resolve capabilities and return a candidate. |
| `idas_recommend_layout` | Return a contextual preview and reason when the host registers an adaptation plugin. |
| `idas_suggest_capability` | Return extension suggestions via the registered evolution plugin. |
| `idas_apply_preview` | Apply an authorized, unexpired preview token once. |
| `idas_dispatch_event` | Dispatch an authorized event to the committed state machine and workflow. Reuse the event ID on retry. |

Try previewing “Create a developer workbench”. With writes enabled, review the candidate and apply its token. Then request a recommendation using `{ "device": "phone", "task": "review" }`. Read the snapshot resource to confirm which revision is active.

## Embed in a host

Import `createWorkspaceMcpServer` or `serveWorkspaceMcpStdio` from `@intent-driven/node/mcp`. Supply an Engine and a fixed workspace scope. The SDK owns negotiation, framing, discovery and cancellation. The adapter does not read model tokens from tool arguments or accept a client-selected workspace scope.

The server exposes writes only when the host provides an `authorize` callback. That callback checks each apply or dispatch request. Engine validation, revision checks, policy and capability grants still apply. Preview tokens are connection-local, expire after five minutes, and are consumed when presented. A token identifies a candidate. The host authorizer decides whether it may be applied.

This example serves a local stdio connection. A network service needs separate transport, per-request authentication and authorization, and a shared preview store. Keep workspace state and model credentials private.

[MCP 2026-07-28 specification](https://modelcontextprotocol.io/specification/2026-07-28) · [MCP stdio transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports) · [Official TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
