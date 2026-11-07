import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rmdir, unlink, open, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { canonical, clone, IdasError, id, pluginManifest } from '@intent-driven/contracts';
import type { Json, Plugin, Snapshot, Store, PluginManifest } from '@intent-driven/contracts';

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

export interface SandboxCandidate { image: string; manifest: PluginManifest }
export interface SandboxOptions {
  approve(candidate: Readonly<SandboxCandidate>, signal: AbortSignal): boolean | Promise<boolean>;
  probes: { capability: string; input: Json; expected: Json }[];
}
const digest = /^(?:[a-z0-9][a-z0-9./:_-]{0,240}@)?sha256:[a-f0-9]{64}$/;
const docker = (args: string[]) => spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
async function remove(name: string): Promise<void> {
  await new Promise<void>(done => {
    const child = docker(['rm', '-f', name]);
    child.stdout.resume(); child.stderr.resume(); child.stdin.end();
    child.on('error', () => done()); child.on('close', () => done());
    const timer = setTimeout(() => { child.kill('SIGKILL'); done(); }, 3000);
    child.on('close', () => clearTimeout(timer)); child.on('error', () => clearTimeout(timer));
  });
}
async function run(image: string, capability: string, input: Json, operation: string, outer: AbortSignal): Promise<Json> {
  const signal = AbortSignal.any([outer, AbortSignal.timeout(8000)]);
  signal.throwIfAborted();
  const name = 'idas-' + randomUUID();
  const body = canonical({ capability, input, operation });
  const child = docker(['run', '--rm', '--name', name, '--pull=never', '--network=none', '--read-only', '--user=65534:65534',
    '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=32', '--memory=96m', '--memory-swap=96m',
    '--cpus=0.5', '--ipc=none', '--init', '-i', image]);
  try {
    const output = await new Promise<string>((yes, no) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const abort = () => no(new IdasError(outer.aborted ? 'CANCELLED' : 'TIMEOUT', 'Sandbox invocation aborted'));
      signal.addEventListener('abort', abort, { once: true });
      child.stdout.on('data', (buf: Buffer) => {
        size += buf.length;
        if (size > 262144) no(new IdasError('PLUGIN', 'Sandbox output too large'));
        else chunks.push(buf);
      });
      child.stderr.resume();
      child.stdin.on('error', () => {}); // early plugin exit is reported by the exit code
      child.on('error', cause => { signal.removeEventListener('abort', abort); no(new IdasError('PLUGIN', 'Docker could not start', { cause })); });
      child.on('close', code => {
        signal.removeEventListener('abort', abort);
        if (code === 0) yes(Buffer.concat(chunks).toString('utf8'));
        else no(new IdasError('PLUGIN', 'Sandbox exited with code ' + code));
      });
      child.stdin.end(body + '\n');
      if (signal.aborted) abort();
    });
    try { return clone(JSON.parse(output)); }
    catch (cause) { throw new IdasError('PLUGIN', 'Sandbox returned invalid JSON', { cause }); }
  } finally {
    if (child.exitCode === null) { child.kill('SIGKILL'); await remove(name); }
  }
}
/** Host-curated image only. No image pulls, mounts, credentials or host sockets enter the container. */
export async function approveSandbox(candidate: SandboxCandidate, options: SandboxOptions, signal = new AbortController().signal): Promise<Plugin> {
  const m = pluginManifest.parse(clone(candidate.manifest));
  const image = candidate.image;
  if (!digest.test(image) || m.requires.length || m.provides.some(p => p.id.startsWith('idas.'))) {
    throw new IdasError('INVALID', 'Sandbox requires a pinned image and standalone tool capabilities');
  }
  const probes = clone(options.probes) as unknown as SandboxOptions['probes'];
  if (probes.length > 100 || probes.some(p => !m.provides.some(x => x.id === p.capability)) ||
      m.provides.some(p => !probes.some(x => x.capability === p.id))) {
    throw new IdasError('INVALID', 'Each sandbox capability needs a contract probe');
  }
  for (const p of probes) {
    if (canonical(await run(image, p.capability, p.input, 'probe', signal)) !== canonical(p.expected)) {
      throw new IdasError('INVALID', 'Sandbox contract probe failed: ' + p.capability);
    }
  }
  const approved = await options.approve({ image, manifest: structuredClone(m) }, signal);
  signal.throwIfAborted();
  if (!approved) throw new IdasError('DENIED', 'Sandbox plugin activation was not approved');
  return {
    manifest: m,
    invoke(capability, input, ctx) {
      if (!m.provides.some(p => p.id === capability)) throw new IdasError('DENIED', 'Unknown sandbox capability');
      return run(image, capability, input, ctx.operation, ctx.signal);
    },
  };
}
