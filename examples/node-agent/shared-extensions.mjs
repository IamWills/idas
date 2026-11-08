import { clone, IdasError } from '../../packages/contracts/dist/index.js';
import { sandboxCatalog } from '../../packages/node/dist/index.js';

export function sharedExtensions(config) {
  const settings = clone(config);
  if (!settings?.trustedKeys || !settings.publisherScopes || !Array.isArray(settings.entries) || !Array.isArray(settings.activations)) {
    throw new IdasError('INVALID', 'Extension config requires publisher scopes, signed entries and activation rules');
  }
  const catalog = sandboxCatalog({
    environment: 'node', trustedKeys: settings.trustedKeys, publisherScopes: settings.publisherScopes,
    load: async () => settings.entries,
  });
  const activations = new Map(settings.activations.map(rule => [rule.signature, rule]));
  if (activations.size !== settings.activations.length || settings.activations.some(rule =>
    !settings.entries.some(entry => entry.signature === rule.signature) || !Array.isArray(rule.probes) ||
    !Array.isArray(rule.grants) || rule.grants.some(grant => typeof grant !== 'string'))) {
    throw new IdasError('INVALID', 'Invalid extension activation rules');
  }
  const granted = new Map();
  let activating = false;
  return {
    plugin: catalog.evolutionPlugin,
    authorize(permission, plugin) { return granted.get(plugin)?.has(permission) ?? false; },
    async activate(registry, requirement, signature, signal) {
      if (activating) throw new IdasError('CONFLICT', 'Another extension activation is in progress');
      const rule = activations.get(signature);
      if (!rule) throw new IdasError('DENIED', 'Host has not approved this exact signature for activation');
      activating = true;
      try {
        const candidates = await catalog.discover(requirement, signal);
        const entry = candidates.find(candidate => candidate.signature === signature);
        if (!entry) throw new IdasError('MISSING', 'Selected plugin no longer matches the missing capability');
        if (entry.descriptor.manifest.provides.length !== 1 ||
            registry.manifests().some(manifest => manifest.provides.some(item => item.id === requirement.id))) {
          throw new IdasError('DENIED', 'Browser activation must add one new capability without replacing a provider');
        }
        if (entry.descriptor.manifest.permissions.some(permission => !rule.grants.includes(permission))) {
          throw new IdasError('DENIED', 'Host grants do not cover the requested permissions');
        }
        const plugin = await catalog.approve(requirement, entry, { probes: rule.probes, approve: () => true }, signal);
        signal.throwIfAborted();
        await registry.load(() => plugin);
        granted.set(plugin.manifest.id, new Set(rule.grants));
        return { plugin: plugin.manifest.id, version: plugin.manifest.version };
      } finally { activating = false; }
    },
    offer(registry, proposal) {
      const existing = registry.manifests().some(manifest => manifest.provides.some(item => item.id === proposal.requirement.id));
      return {
        ...proposal,
        candidates: (proposal.candidates ?? []).map(entry => ({
          ...entry,
          canActivate: !existing && entry.descriptor.manifest.provides.length === 1 && entry.descriptor.manifest.permissions.every(permission =>
            activations.get(entry.signature)?.grants.includes(permission) === true) && activations.has(entry.signature),
        })),
      };
    },
  };
}
