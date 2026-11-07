import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { canonical, clone, IdasError, pluginManifest, sandboxImage } from '@intent-driven/contracts';
import type { Json, Plugin, PluginManifest } from '@intent-driven/contracts';

export interface SandboxCandidate { image: string; manifest: PluginManifest }
export interface SandboxOptions {
  approve(candidate: Readonly<SandboxCandidate>, signal: AbortSignal): boolean | Promise<boolean>;
  probes: { capability: string; input: Json; expected: Json }[];
}
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
  if (!sandboxImage.safeParse(image).success || m.requires.length || m.provides.some(p => p.id.startsWith('idas.'))) {
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
