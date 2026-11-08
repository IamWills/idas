import { createPublicKey, verify } from 'node:crypto';
import semver from 'semver';
import { canonical, capability, clone, IdasError, id, services, signedSandboxDescriptor } from '@intent-driven/contracts';
import type { Plugin, Requirement, SignedSandboxDescriptor } from '@intent-driven/contracts';
import { approveSandbox } from './sandbox.js';
import type { SandboxOptions } from './sandbox.js';

export interface SandboxCatalogOptions {
  environment: string;
  /** Host-pinned Ed25519 public keys in SPKI PEM format. */
  trustedKeys: Readonly<Record<string, string>>;
  /** When supplied, each signer must have explicit plugin and capability namespaces. */
  publisherScopes?: Readonly<Record<string, { plugins: readonly string[]; capabilities: readonly string[] }>>;
  /** Host-owned transport. Return a JSON array from a catalog the host chooses. */
  load(requirement: Readonly<Requirement>, signal: AbortSignal): Promise<unknown>;
}

export interface SandboxCatalog {
  discover(requirement: Requirement, signal?: AbortSignal): Promise<SignedSandboxDescriptor[]>;
  approve(requirement: Requirement, candidate: unknown, options: SandboxOptions, signal?: AbortSignal): Promise<Plugin>;
  evolutionPlugin(): Plugin;
}

function readRequirement(value: unknown): Requirement {
  const parsed = capability.safeParse(clone(value));
  if (!parsed.success || semver.validRange(parsed.data.range) === null) {
    throw new IdasError('INVALID', 'Invalid catalog capability requirement');
  }
  return parsed.data;
}

export function sandboxCatalog(options: SandboxCatalogOptions): SandboxCatalog {
  const { environment, load } = options;
  if (!id.safeParse(environment).success) throw new IdasError('INVALID', 'Invalid catalog environment');
  const keys = new Map(Object.entries(options.trustedKeys).map(([name, pem]) => {
    if (!id.safeParse(name).success || !pem.trim().startsWith('-----BEGIN PUBLIC KEY-----')) {
      throw new IdasError('INVALID', 'Invalid catalog key: ' + name);
    }
    let key;
    try { key = createPublicKey(pem); }
    catch (cause) { throw new IdasError('INVALID', 'Invalid catalog key: ' + name, { cause }); }
    if (key.asymmetricKeyType !== 'ed25519') throw new IdasError('INVALID', 'Catalog key must use Ed25519: ' + name);
    return [name, key] as const;
  }));
  const scopes = options.publisherScopes && new Map(Object.entries(options.publisherScopes).map(([name, scope]) => {
    const namespaces = [...scope.plugins, ...scope.capabilities];
    if (!keys.has(name) || !scope.plugins.length || !scope.capabilities.length ||
        namespaces.some(namespace => !id.safeParse(namespace).success || namespace === 'idas' || namespace.startsWith('idas.'))) {
      throw new IdasError('INVALID', 'Invalid publisher scope: ' + name);
    }
    return [name, { plugins: [...scope.plugins], capabilities: [...scope.capabilities] }] as const;
  }));
  const within = (identifier: string, namespaces: readonly string[]) =>
    namespaces.some(namespace => identifier === namespace || identifier.startsWith(namespace + '.'));

  function verifyCandidate(value: unknown): SignedSandboxDescriptor {
    const parsed = signedSandboxDescriptor.safeParse(value);
    if (!parsed.success) throw new IdasError('INVALID', 'Invalid signed sandbox descriptor');
    const entry = parsed.data;
    const { keyId, expiresAt, manifest } = entry.descriptor;
    const key = keys.get(keyId);
    const signature = Buffer.from(entry.signature, 'base64url');
    if (!key || signature.toString('base64url') !== entry.signature ||
        !verify(null, Buffer.from(canonical(entry.descriptor)), key, signature)) {
      throw new IdasError('DENIED', 'Sandbox descriptor signature could not be verified');
    }
    if (expiresAt <= Date.now()) throw new IdasError('DENIED', 'Sandbox descriptor has expired');
    if (manifest.id === 'idas' || manifest.id.startsWith('idas.') || manifest.requires.length || !semver.valid(manifest.version) ||
        manifest.provides.some(p => p.id.startsWith('idas.') || !semver.valid(p.version)) ||
        new Set(manifest.provides.map(p => p.id)).size !== manifest.provides.length) {
      throw new IdasError('INVALID', 'Catalog entries must provide valid standalone tool capabilities');
    }
    if (scopes) {
      const scope = scopes.get(keyId);
      if (!scope || !within(manifest.id, scope.plugins) || manifest.provides.some(p => !within(p.id, scope.capabilities))) {
        throw new IdasError('DENIED', 'Sandbox descriptor exceeds the publisher namespace');
      }
    }
    return entry;
  }

  function compatibleVersion(entry: SignedSandboxDescriptor, requirement: Requirement): string | undefined {
    const { environments, provides } = entry.descriptor.manifest;
    if (!environments.includes('any') && !environments.includes(environment)) return undefined;
    return provides.find(p => p.id === requirement.id && semver.satisfies(p.version, requirement.range))?.version;
  }

  async function discover(requirement: Requirement, signal = new AbortController().signal): Promise<SignedSandboxDescriptor[]> {
    signal.throwIfAborted();
    const request = readRequirement(requirement);
    const raw = await load(Object.freeze({ ...request }), signal);
    signal.throwIfAborted();
    if (!Array.isArray(raw) || raw.length > 100) throw new IdasError('INVALID', 'Catalog response must contain at most 100 entries');
    const entries = clone(raw) as unknown[];
    const candidates = [];
    const releases = new Map<string, string>();
    for (const value of entries) {
      const entry = verifyCandidate(value);
      const version = compatibleVersion(entry, request);
      if (!version) continue;
      const { manifest, image } = entry.descriptor;
      const release = canonical([manifest.id, manifest.version]);
      const fingerprint = canonical([image, manifest]);
      const previous = releases.get(release);
      if (previous === fingerprint) continue;
      if (previous !== undefined) throw new IdasError('CONFLICT', 'Conflicting catalog entries for ' + manifest.id + '@' + manifest.version);
      releases.set(release, fingerprint);
      candidates.push({ entry, version });
    }
    candidates.sort((a, b) => {
      const first = a.entry.descriptor.manifest;
      const second = b.entry.descriptor.manifest;
      return semver.rcompare(a.version, b.version) || semver.rcompare(first.version, second.version) ||
        (first.id < second.id ? -1 : first.id > second.id ? 1 : 0);
    });
    return candidates.map(candidate => candidate.entry);
  }

  return {
    discover,
    async approve(requirement, candidate, activation, signal = new AbortController().signal) {
      signal.throwIfAborted();
      const request = readRequirement(requirement);
      const entry = verifyCandidate(clone(candidate));
      if (!compatibleVersion(entry, request)) throw new IdasError('MISSING', 'Sandbox candidate does not satisfy the capability requirement');
      const plugin = await approveSandbox(entry.descriptor, activation, signal);
      if (entry.descriptor.expiresAt <= Date.now()) throw new IdasError('DENIED', 'Sandbox descriptor expired during approval');
      return plugin;
    },
    evolutionPlugin() {
      return {
        manifest: {
          id: 'idas.sandbox.catalog', version: '1.0.0', environments: [environment],
          requires: [], permissions: [], provides: [{ id: services.evolution, version: '1.1.0' }],
        },
        async invoke(_id, input, ctx) {
          const requirement = readRequirement(input);
          const candidates = await discover(requirement, ctx.signal);
          return clone({
            requirement, status: 'proposal', candidates,
            rationale: candidates.length
              ? 'These signed plugins match the requested capability, version and environment.'
              : 'No trusted catalog entry matches the capability, version and environment.',
            next: candidates.length
              ? ['Review a candidate', 'Run isolated contract tests', 'Request host approval']
              : ['Define a JSON input and output contract for ' + requirement.id,
                'Implement a standalone tool and declare the required capability version',
                'Package and sign an immutable image', 'Prepare host-authored sandbox probes'],
          });
        },
      };
    },
  };
}
