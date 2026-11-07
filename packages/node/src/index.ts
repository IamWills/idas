import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rmdir, unlink, open, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { canonical, IdasError, id } from '@intent-driven/contracts';
import type { Snapshot, Store } from '@intent-driven/contracts';

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
/** Use a private, local directory. Locks are never stolen; recover abandoned locks offline. */
export function fileStore(directory: string): Store {
  const dir = resolve(directory);
  const pathFor = (scope: string) => {
    if (!id.safeParse(scope).success) throw new IdasError('INVALID', 'Invalid workspace scope');
    return join(dir, scope + '.json');
  };
  const history = async (scope: string): Promise<Snapshot[]> => {
    const file = pathFor(scope);
    try {
      if ((await stat(file)).size > 2_500_000) throw new IdasError('INVALID', 'Stored history exceeds size limit');
      const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
      if (!Array.isArray(parsed) || parsed.some(x => !x || typeof x.revision !== 'number' || x.spec?.intent?.scope !== scope)) {
        throw new IdasError('INVALID', 'Invalid stored history');
      }
      return parsed as Snapshot[];
    } catch (e) { if (missing(e)) return []; throw e; }
  };
  return {
    history,
    async read(scope) { return (await history(scope)).at(-1) ?? null; },
    async compareAndSwap(scope, expected, next, signal) {
      signal?.throwIfAborted();
      const file = pathFor(scope);
      const lock = file + '.lock';
      await mkdir(dir, { mode: 0o700, recursive: true });
      try { await mkdir(lock, { mode: 0o700 }); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false; throw e; }
      const temp = file + '.' + randomUUID() + '.tmp';
      try {
        const entries = await history(scope);
        if ((entries.at(-1)?.revision ?? 0) !== expected) return false;
        const serialized = [...entries.slice(-19), next].map(canonical);
        const bounded = () => '[' + serialized.join(',') + ']';
        while (serialized.length > 1 && Buffer.byteLength(bounded()) > 2_500_000) serialized.shift();
        const body = bounded();
        if (Buffer.byteLength(body) > 2_500_000) throw new IdasError('INVALID', 'Snapshot exceeds storage size limit');
        const fd = await open(temp, 'wx', 0o600);
        try { await fd.writeFile(body); await fd.sync(); } finally { await fd.close(); }
        signal?.throwIfAborted();
        await rename(temp, file);
        return true;
      } finally {
        try { await unlink(temp); } catch (e) { if (!missing(e)) throw e; }
        finally { await rmdir(lock); }
      }
    },
  };
}

export { approveSandbox } from './sandbox.js';
export type { SandboxCandidate, SandboxOptions } from './sandbox.js';
export { sandboxCatalog } from './catalog.js';
export type { SandboxCatalog, SandboxCatalogOptions } from './catalog.js';
