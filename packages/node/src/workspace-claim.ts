import { randomUUID } from 'node:crypto';
import { mkdir, rmdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { id, IdasError, services } from '@intent-driven/contracts';
import type { Plugin } from '@intent-driven/contracts';

/** Single local filesystem only. A crashed holder leaves a fail-closed claim for operator recovery. */
export function fileWorkspaceClaim(directory: string): Plugin {
  const root = resolve(directory);
  const held = new Map<string, string>();
  return {
    manifest: {
      id: 'idas.node.file-claim', version: '1.0.0', environments: ['node', 'bun'], requires: [], permissions: [],
      provides: [{ id: services.workspaceClaim, version: '1.0.0' }],
    },
    async invoke(_capability, input) {
      if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.scope !== 'string' ||
          !id.safeParse(input.scope).success) throw new IdasError('INVALID', 'Invalid workspace claim scope');
      const { scope, action } = input;
      const lock = join(root, scope + '.claim');
      if (action === 'acquire') {
        await mkdir(root, { recursive: true, mode: 0o700 });
        try { await mkdir(lock, { mode: 0o700 }); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            throw new IdasError('CONFLICT', 'Workspace is already claimed');
          }
          throw error;
        }
        const token = randomUUID();
        held.set(scope, token);
        return token;
      }
      if (action !== 'release' || typeof input.token !== 'string' || held.get(scope) !== input.token) {
        throw new IdasError('DENIED', 'Workspace claim is not owned by this caller');
      }
      await rmdir(lock);
      if (held.get(scope) === input.token) held.delete(scope);
      return true;
    },
  };
}
