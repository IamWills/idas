import { readFile } from 'node:fs/promises';
import { Engine, Registry } from '../../packages/core/dist/index.js';
import { standard } from '../../packages/standard/dist/index.js';
import { MissingCapabilityError } from '../../packages/contracts/dist/index.js';
import { sandboxCatalog } from '../../packages/node/dist/index.js';

try {
  const [command, configPath, signature, event] = process.argv.slice(2);
  if (!configPath || !['suggest', 'activate'].includes(command) || (command === 'activate' && !signature)) {
    throw new Error('Usage: node examples/node-agent/extension.mjs suggest <host-config.json> | activate <host-config.json> <signature> [event]');
  }
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  if (!config.publisherScopes) throw new Error('Host configuration must constrain publisher namespaces');
  const scope = config.spec.intent.scope;
  const catalog = sandboxCatalog({
    environment: 'node',
    trustedKeys: config.trustedKeys,
    publisherScopes: config.publisherScopes,
    load: async () => config.entries,
  });
  let approvedPlugin;
  const registry = new Registry('node', (permission, plugin, workspace) =>
    plugin === approvedPlugin && workspace === scope && config.grants?.includes(permission) === true);
  await registry.load(() => standard({ resolve: registry.inspect.bind(registry), tool: registry.invoke.bind(registry) }));
  await registry.load(catalog.evolutionPlugin);
  const engine = new Engine(registry);
  let requirement;
  try {
    await engine.previewSpec(scope, config.spec);
    throw new Error('The specification has no missing capability to resolve');
  } catch (error) {
    if (!(error instanceof MissingCapabilityError)) throw error;
    requirement = error.requirement;
  }
  const proposal = await engine.suggest(scope, requirement);
  if (command === 'suggest') {
    console.log(JSON.stringify(proposal, null, 2));
  } else {
    const candidate = proposal.candidates.find(entry => entry.signature === signature);
    if (!candidate) throw new Error('The selected signature is absent from the current verified candidates');
    const plugin = await catalog.approve(requirement, candidate, { probes: config.probes, approve: () => true });
    approvedPlugin = plugin.manifest.id;
    await registry.load(() => plugin);
    const preview = await engine.previewSpec(scope, config.spec);
    const applied = await engine.apply(preview);
    const result = event ? await engine.dispatch(scope, event, null, 'demo-' + crypto.randomUUID()) : applied;
    console.log(JSON.stringify(result, null, 2));
  }
} catch (error) {
  console.error(error.code ?? 'ERROR', error.message);
  process.exitCode = 1;
}
