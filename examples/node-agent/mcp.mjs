import { Engine, Registry } from '../../packages/core/dist/index.js';
import { echoPlugin, modelCompiler, standard } from '../../packages/standard/dist/index.js';
import { fileStore, fileWorkspaceClaim } from '../../packages/node/dist/index.js';
import { serveWorkspaceMcpStdio } from '../../packages/node/dist/mcp.js';
import { workbenchAdaptation, workbenchCompiler, workbenchTools } from '../web/workbench.ts';
import { httpModel } from './http-model.mjs';

const directory = process.env.IDAS_DATA ?? '.idas-data';
const scope = 'workspace';
const modelUrl = process.env.IDAS_MODEL_URL;
const registry = new Registry('node', (permission, plugin, workspace) =>
  !!modelUrl && permission === 'model.http' && plugin === 'example.http-model' && workspace === scope);
await registry.load(() => standard({
  store: fileStore(directory), resolve: registry.inspect.bind(registry), tool: registry.invoke.bind(registry),
}));
await registry.load(echoPlugin);
await registry.load(workbenchTools);
await registry.load(workbenchCompiler);
await registry.load(workbenchAdaptation);
await registry.load(() => fileWorkspaceClaim(directory));
if (modelUrl) {
  await registry.load(() => httpModel(modelUrl, process.env.IDAS_MODEL_TOKEN));
  await registry.load(() => modelCompiler(undefined, { repair: true, available: registry.available.bind(registry) }));
}
const engine = new Engine(registry, { workspaceClaim: true });
serveWorkspaceMcpStdio({
  engine, scope, recommendations: true,
  // The example tools use local demo data. A host exposing real effects must supply its own authorizer.
  ...(process.env.IDAS_MCP_ALLOW_WRITES === '1' ? { authorize: () => true } : {}),
});
