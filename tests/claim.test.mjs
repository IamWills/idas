import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const exec = promisify(execFile);
const worker = fileURLToPath(new URL('./fixtures/claim-worker.mjs', import.meta.url));

test('a shared local workspace claim excludes a second process before effects and preserves event receipts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'idas-claim-'));
  const run = action => exec(process.execPath, [worker, directory, action], { timeout: 8000 });
  let first;
  try {
    await run('init');
    first = run('hold');
    void first.catch(() => {});
    for (let attempts = 0; ; attempts++) {
      try {
        await access(join(directory, 'entered'));
        break;
      } catch (error) {
        if (error.code !== 'ENOENT' || attempts >= 250) throw error;
        await setTimeout(10);
      }
    }
    await assert.rejects(run('dispatch'), error => /CONFLICT/.test(error.stderr));
    await assert.rejects(run('apply'), error => /CONFLICT/.test(error.stderr));
    await writeFile(join(directory, 'continue'), '');
    assert.equal((await first).stdout.trim(), '2');
    assert.equal((await run('dispatch')).stdout.trim(), '2');
    assert.equal(await readFile(join(directory, 'calls'), 'utf8'), 'invoked\n');
  } finally {
    first?.child?.kill();
    await first?.catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});
