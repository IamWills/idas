# Product roadmap

IDAS makes natural language a way to define and continuously change software. Every release must let a user express a UI, interaction or behavior change that the preceding version could not handle. Registry, policy, isolation and storage work supports those scenarios. Version numbers below are proposed milestones.

## v0.2 — Change a working application with intent · P0

**Product goal.** Create a workbench from intent, then change its placement and behavior without rewriting the host.

**Modules and architecture.** Extend IDSS contracts, the standard compiler and semantic validator, and the React and SwiftUI renderers. Reuse Engine preview and revisions, the Registry, and the existing interaction and workflow plugins. The current slice adds wide panel rows, compact pages, multiline input, controls visible by mode, and bindings from state to tasks. The workbench host uses those same contracts for code review and conditional release.

**Runnable scenes.** A–D run together in the React example with deterministic local tools. SwiftUI reads the same presentation shape. The model plugin receives the committed specification and can retry once with a validation diagnostic. The Node HTTP model example sends an opt-in request with IDSS Schema and host-authorized capability context. The browser preview explains concrete changes through paths and before/after values. The local MCP server exposes the same preview, adaptation and event paths through a workspace-scoped adapter. Real-model prompt evaluation remains the P0 release gate. The schema supports recursive layouts and exact-version native component capabilities with validated state bindings. Typed forms now validate text, numbers, booleans and declared choices in the state machine. Nested state paths can feed form defaults, native components and workflow tasks. Optional view routes control navigation when the renderer shows one view at a time.

**Exit tests.** The A–D acceptance suite runs English and Chinese prompt sequences over successive revisions. The deterministic HTTP fixture runs in CI. Run `pnpm test:model` with `IDAS_MODEL_URL` to verify an actual configured model before release. The suite checks desktop placement, compact page projection, invalid IDSS rejection, a stale preview, denied capability use, commit gating and both release branches. The existing IDSS/1 fixtures cover backward compatibility.

**Safety and compatibility.** Candidate output is data. Validate schema, state and event references, capabilities, and grants before applying a preview. The host enforces write and release authorization independently of model-defined UI and transitions. Keep newly added IDSS/1 fields optional. Define migration or capability negotiation before shipping incompatible schema changes.

## v0.3 — Adapt a workspace to the user's current task · P1

**Product goal.** When a developer switches from editing to reviewing on a phone, suggest a focused review page that the user can inspect, apply, retain and undo.

**Modules and architecture.** A bounded host context contract and a registered recommendation plugin now run in the React workbench. The recommendation goes through the existing compiler and Engine preview. React and the native SwiftUI example now connect to the same authenticated loopback host, which accepts only allowlisted device and task fields. Keep device-local layout selection in the renderers.

**Runnable scene and exit tests.** The local acceptance path runs extended D from React and native Swift using the same persisted workspace. The suggestion cites the changed device or task signal. Declining leaves the current revision intact, accepting persists it, and rollback restores the prior layout. The HTTP integration test covers repeated signals, stale suggestions, invalid context and scope isolation. A deployed host and physical iOS-device validation remain future work.

**Safety and compatibility.** Send only host-approved context fields to model providers. Context signals can propose revisions. Existing preview and authorization rules govern changes. Preserve host access controls and existing compiler integrations.

## v0.4 — Extend a workflow when a tool is missing · P1

**Product goal.** Ask for a new behavior, see why an installed capability cannot satisfy it, and resume the workflow after an approved extension.

**Modules and architecture.** Use the existing structured missing requirement, evolution plugin, signed catalog and Docker sandbox. The Node example now verifies publisher namespaces and exposes an explained proposal with a development checklist or a list of signed candidates. The CLI requires an explicit signature selection for activation. The shared React host now reviews signed candidates, invokes the host activation policy and recompiles the original intent against the registered capability. Revalidate and restore approved activations on host restart as a follow-up.

**Runnable scene and exit tests.** E starts with a request the current registry cannot fulfill. The host lists verified compatible candidates or explains what to implement. Test wrong publisher namespace, tampering, expiry, version mismatch, failed sandbox probes, rejected approval and runtime grant revocation. A separately authorized registration enables the revised behavior.

**Safety and compatibility.** The host controls transport, keys, image provisioning, probes and installation. Verify signatures and isolation before activation and apply runtime grants on every invocation. Keep artifact generation separate from execution and use the existing Registry and Engine contracts.

## Reliability gate for real effects · P1

**Product goal.** Run the C release workflow against a real authorized target with observable, recoverable execution. This gate precedes real external effects or multi-instance deployment.

**Modules and architecture.** A workspace claim capability now serializes cooperating Node processes on the same local filesystem before they execute tools or commit revisions. Add a transactional store adapter for shared database deployments and crash recovery. Commit state and effect records together, deliver from an outbox, use stable effect idempotency keys, and expose explicit compensations. Keep the current store interface usable for single-instance demonstrations.

**Runnable scene and exit tests.** Send the same release event to two processes, interrupt a worker after delivery, and resume it. Verify a single committed result, safe replay by an idempotent receiver, and reporting for pending and failed compensation. Test rejected grants after retry and successful recovery under database restart.

**Safety and compatibility.** The host owns tool allowlists, credentials and release authorization. External systems participate in deduplication. Rollback of a workspace revision and compensation of an external effect have separate contracts.
