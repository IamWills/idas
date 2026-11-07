# Security and compatibility

Treat natural language, remote tool results and candidate IDSS as data. IDSS cannot execute code, install plugins, request host credentials, change the authenticated scope, or grant new permissions. The registry denies all requested permissions by default. Hosts derive scope and grants from authenticated identity and should use the policy plugin and approval callback for sensitive changes. Plugin manifests describe requested grants; they do not constrain code already trusted in the host process.

### Signed catalog entries

The optional Node catalog verifies an Ed25519 signature over the immutable image reference, manifest, expiry and key ID. Configure trusted public keys and the catalog transport in the host. A trusted key can sign any standalone tool capability, so pin only publishers authorized to propose extensions. Discovery grants no permissions and pulls no images. Expiry gates approval of new activations. To revoke an active extension, revoke its grants and unload it. Recreate the catalog with a revised key set to remove a publisher from future discovery and approval.

### Untrusted executable extensions

1. Curate an immutable local OCI image ID or repository digest. Do not build untrusted Dockerfiles on a trusted workstation. Use a dedicated build environment.
2. Call `approveSandbox` with the manifest, host-authored contract probes and approval callback. Each exported tool must pass its probe in Docker before the callback runs.
3. Register the returned proxy only after approval. A separate host grant is still required for any requested permission. To revoke, revoke the grant and unload the proxy when idle.
4. The runner uses a non-root user, a read-only root, no network, no host bind mounts, no inherited host environment variables, dropped capabilities and CPU/memory/PID limits. JSON travels through stdin/stdout. It never pulls images or mounts the Docker socket. Use a dedicated, patched Docker daemon or VM for adversarial code; the Docker daemon and container kernel are part of the trusted computing base.

External effects cannot be undone by snapshot rollback. Hosts must use idempotent tools or compensation for external writes. State commits use revision compare-and-swap, not a distributed lock over side effects; run one writer per scope for non-idempotent tools. The last 100 committed event receipts are kept; retries outside that window can execute again. File history keeps up to 20 revisions under a size cap. A crash can leave a lock directory: verify no writer is alive before removing it. Built-in local stores are examples and are not multi-tenant databases.

Trace records carry lifecycle, timing and classified error information. Do not put credentials in specifications, context, state, operation identifiers or tool inputs. Configure provider deadlines and privacy requirements in the host.

| Surface | Supported scope |
| --- | --- |
| Node.js 22/24 | TypeScript SDK, file store, CLI; Docker isolation on a compatible daemon |
| Bun | TypeScript and Node-compatible tests; Docker integration is verified on Node |
| Modern Web | Responsive React; example persistence needs localStorage and Web Locks on a secure origin |
| macOS 13+, iOS 16+ | Native SwiftUI presentation and host callbacks; workflow execution remains in the host engine |
| [MCP 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) | Paginated tools/list and allowlisted tools/call plus fixed-URI resources/read over an injected negotiated SDK transport; auth and session management remain with the client |
| [A2UI v0.9](https://github.com/a2ui-project/a2ui/blob/main/specification/v0_9/docs/a2ui_protocol.md) | Read-only Basic Catalog Column/Text surface projection; transport and interactive actions are out of scope |
| [AG-UI events](https://docs.ag-ui.com/concepts/events) | Run lifecycle and state snapshot subset; transport, deltas and tool streaming are out of scope |
