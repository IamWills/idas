import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { Engine, Registry } from '../../packages/core/dist/index.js';
import { adaptationContext, assertJson, IdasError, id, MissingCapabilityError } from '../../packages/contracts/dist/index.js';
import { standard } from '../../packages/standard/dist/index.js';
import { fileStore, fileWorkspaceClaim } from '../../packages/node/dist/index.js';
import { workbenchAdaptation, workbenchBadge, workbenchCompiler, workbenchTools } from '../web/workbench.ts';

import { sharedExtensions } from './shared-extensions.mjs';

const scope = 'workspace';
const revision = value => Number.isSafeInteger(value) && value > 0;
const fields = {
  snapshot: [], preview: ['intent'], recommend: ['context'], apply: ['token'],
  suggestExtension: ['intent'], activateExtension: ['intent', 'signature'],
  dispatch: ['event', 'eventId', 'input'], rollback: ['revision', 'expectedRevision'],
};

async function readRequest(request) {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json') {
    throw new IdasError('INVALID', 'Expected application/json');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 16_384) throw new IdasError('INVALID', 'Request is too large');
    chunks.push(chunk);
  }
  let data;
  try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new IdasError('INVALID', 'Expected a JSON request'); }
  assertJson(data);
  if (!data || Array.isArray(data) || typeof data !== 'object' || typeof data.action !== 'string' || !Object.hasOwn(fields, data.action) ||
      Object.keys(data).some(key => key !== 'action' && !fields[data.action].includes(key))) {
    throw new IdasError('INVALID', 'Unknown action or request field');
  }
  return data;
}

export async function createSharedWorkspace({ directory, token, extensions }) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) {
    throw new Error('IDAS_SHARED_TOKEN must be a random token with at least 32 URL-safe characters');
  }
  const secret = Buffer.from('Bearer ' + token);
  const extensionHost = extensions && sharedExtensions(extensions);
  const registry = new Registry('node', (permission, plugin, workspace) =>
    workspace === scope && extensionHost?.authorize(permission, plugin) === true);
  await registry.load(() => standard({
    store: fileStore(directory), resolve: registry.inspect.bind(registry), tool: registry.invoke.bind(registry),
  }));
  await registry.load(workbenchCompiler);
  await registry.load(workbenchAdaptation);
  await registry.load(workbenchTools);
  await registry.load(workbenchBadge);
  await registry.load(() => fileWorkspaceClaim(directory));
  if (extensionHost) await registry.load(extensionHost.plugin);
  const engine = new Engine(registry, { workspaceClaim: true });
  const previews = new Map();

  function issue(change) {
    const now = Date.now();
    for (const [key, item] of previews) if (item.expires <= now) previews.delete(key);
    if (previews.size >= 16) previews.delete(previews.keys().next().value);
    const token = randomUUID();
    previews.set(token, { change, expires: now + 300_000 });
    return { token, change };
  }

  async function missingRequirement(intent, options) {
    try { await engine.preview(scope, intent, null, options); }
    catch (error) {
      if (error instanceof MissingCapabilityError) return error.requirement;
      throw error;
    }
    throw new IdasError('CONFLICT', 'The intent no longer has a missing capability');
  }

  async function invoke(data, signal) {
    const options = { signal };
    switch (data.action) {
      case 'suggestExtension': {
        const requirement = await missingRequirement(data.intent, options);
        const proposal = await engine.suggest(scope, requirement, options);
        return { proposal: extensionHost ? extensionHost.offer(registry, proposal) : { ...proposal, candidates: [] } };
      }
      case 'activateExtension': {
        if (!extensionHost) throw new IdasError('DENIED', 'This host does not allow browser activation');
        if (typeof data.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(data.signature)) {
          throw new IdasError('INVALID', 'Select a signed extension');
        }
        const requirement = await missingRequirement(data.intent, options);
        return { activation: await extensionHost.activate(registry, requirement, data.signature, signal) };
      }
      case 'snapshot': return { snapshot: await engine.snapshot(scope, options) };
      case 'preview': return { preview: issue(await engine.preview(scope, data.intent, null, options)) };
      case 'recommend': {
        const parsed = adaptationContext.safeParse(data.context);
        if (!parsed.success) throw new IdasError('INVALID', 'Expected an allowlisted device and task');
        const recommendation = await engine.recommend(scope, parsed.data, options);
        return { preview: recommendation ? { ...issue(recommendation.change), reason: recommendation.reason } : null };
      }
      case 'apply': {
        const item = previews.get(data.token);
        previews.delete(data.token);
        if (!item || item.expires <= Date.now()) throw new IdasError('INVALID', 'Preview token is unknown, used or expired');
        return { snapshot: await engine.apply(item.change, options) };
      }
      case 'dispatch':
        if (!id.safeParse(data.event).success || !id.safeParse(data.eventId).success) throw new IdasError('INVALID', 'Invalid event');
        return { snapshot: await engine.dispatch(scope, data.event, data.input ?? null, data.eventId, options) };
      case 'rollback':
        if (!revision(data.revision) || !revision(data.expectedRevision)) throw new IdasError('INVALID', 'Invalid rollback revisions');
        return { snapshot: await engine.rollback(scope, data.revision, { ...options, expectedRevision: data.expectedRevision }) };
    }
  }

  return createServer({ requestTimeout: 30_000, headersTimeout: 10_000 }, async (request, response) => {
    const reply = (status, payload) => {
      if (response.destroyed) return;
      response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify(payload));
    };
    if (request.url !== '/api/idas' || request.method !== 'POST') return reply(404, { code: 'MISSING', message: 'Route not found' });
    const candidate = Buffer.from(request.headers.authorization ?? '');
    if (candidate.length !== secret.length || !timingSafeEqual(candidate, secret)) {
      request.resume();
      response.setHeader('WWW-Authenticate', 'Bearer');
      return reply(401, { code: 'DENIED', message: 'Invalid workspace credentials' });
    }
    const controller = new AbortController();
    response.once('close', () => { if (!response.writableFinished) controller.abort(); });
    try {
      reply(200, await invoke(await readRequest(request), controller.signal));
    } catch (error) {
      request.resume();
      const code = error instanceof IdasError ? error.code : 'PLUGIN';
      const status = { INVALID: 400, DENIED: 403, MISSING: 404, CONFLICT: 409, TIMEOUT: 504, CANCELLED: 408 }[code] ?? 500;
      const message = status === 500 ? 'Workspace operation failed' : error.message;
      reply(status, { code, message, ...(error instanceof MissingCapabilityError ? { requirement: error.requirement } : {}) });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = process.env.IDAS_SHARED_EXTENSIONS;
  const extensions = path ? JSON.parse(await readFile(path, 'utf8')) : undefined;
  const server = await createSharedWorkspace({ extensions, directory: process.env.IDAS_DATA ?? '.idas-shared', token: process.env.IDAS_SHARED_TOKEN });
  server.listen(4178, '127.0.0.1', () => console.log('IDAS shared workspace listening on http://127.0.0.1:4178'));
}
