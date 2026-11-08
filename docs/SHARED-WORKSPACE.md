# Shared workspace example

The React and SwiftUI examples can connect to the same Node host on a development machine. The host binds to `127.0.0.1:4178` and owns one workspace. It registers the existing compiler, adaptation, workflow, state and claim capabilities. Both clients render the committed IDSS and submit events to that engine.

Build with Node.js 22.18+ and use one token for the host and both clients.

```sh
pnpm install --frozen-lockfile
pnpm build
export IDAS_SHARED_TOKEN="$(openssl rand -hex 24)"
pnpm shared:serve &
pnpm web
```

Open the URL printed by Vite with `?shared=1` and enter the token. Preview and apply **A · Create workbench**. In a terminal with the same token in its environment, run:

```sh
swift run --package-path packages/sdk-swift IDASDemo --shared
```

Narrow the native window below 640 points and choose **Suggest a review layout**. The explanation appears before any change is made. Apply it, then refresh the browser to see the new revision. Save an edit in either client and refresh the other to see its committed state. **Restore previous workspace** creates a new revision from the prior snapshot. If another client has written since the suggestion was applied, restore rejects the stale revision.

The example uses explicit refresh across clients. Requests carry the bearer token in a header and the server fixes the workspace scope. Preview tokens expire after five minutes and are consumed on apply. The example uses demo tools and a local store under `.idas-shared`; set `IDAS_DATA` to choose another directory. A deployed multi-user host would need authenticated identities, authorization by workspace, HTTPS, and shared transactional storage.

The Swift package supports iOS SDK builds. The runnable SwiftPM window is macOS, and the integration tests exercise its Swift client on macOS.

## Scenario E: extend the workspace with a signed tool

The browser can explain a missing capability even without a catalog. To exercise activation, build the repository's Docker fixture and generate a private host config. The fixture reports whether its sandbox has a read-only root, no external network interface and no host test secret. It receives no workspace files.

```sh
image="$(docker build -q tests/sandbox)"
config_dir="$(mktemp -d)"
node examples/node-agent/inspection-config.mjs "$image" "$config_dir/extensions.json"
IDAS_SHARED_EXTENSIONS="$config_dir/extensions.json" pnpm shared:serve
```

Start the shared host with the same `IDAS_SHARED_TOKEN` and connect the browser as above. After creating the workbench, select **E · Find an inspection plugin** and click **Preview change**. Review the missing capability and the candidate's publisher, permissions and digest. **Verify and activate** runs the host's probes on the already provisioned image. Then review and apply the new preview separately. Select **Inspect workspace** in the Agent panel to run the workflow.

The host config restricts the publisher's plugin and capability namespaces. Each activation rule lists an exact descriptor signature, the permissions granted by the host and the isolation probes to run. Browser activation can add one new capability and rejects attempts to replace a registered provider. Candidate and workflow application are separate operations. Activated plugins live in the current host process. Use a disposable `IDAS_DATA` directory for the demo. Restart recovery for activated extensions remains a roadmap item.
