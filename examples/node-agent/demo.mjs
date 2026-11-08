import { writeFile } from 'node:fs/promises';
import { Engine, Registry } from '../../packages/core/dist/index.js';
import { echoPlugin, modelCompiler, standard } from '../../packages/standard/dist/index.js';
import { fileWorkspaceClaim, fileStore } from '../../packages/node/dist/index.js';
import { canonical } from '../../packages/contracts/dist/index.js';
import { httpModel } from './http-model.mjs';

const modelUrl = process.env.IDAS_MODEL_URL;
const dataDir = process.env.IDAS_DATA ?? '.idas-data';
const scope = 'workspace';
const registry = new Registry('node', (permission, plugin, workspace) =>
  !!modelUrl && permission === 'model.http' && plugin === 'example.http-model' && workspace === scope, event => {
  if (process.env.IDAS_TRACE) console.error(JSON.stringify(event));
});
await registry.load(() => standard({
  store: fileStore(dataDir),
  resolve: registry.inspect.bind(registry), tool: registry.invoke.bind(registry),
}));
await registry.load(echoPlugin);
await registry.load(() => fileWorkspaceClaim(dataDir));
const engine = new Engine(registry, { workspaceClaim: true });
const [command = 'demo', ...args] = process.argv.slice(2);
try {
  if (modelUrl && (command === 'apply' || command === 'preview')) {
    await registry.load(() => httpModel(modelUrl, process.env.IDAS_MODEL_TOKEN));
    await registry.load(() => modelCompiler(undefined, { repair: true, available: registry.available.bind(registry) }));
  }
  if (command === 'preview') {
    console.log(JSON.stringify(await engine.preview(scope, args.join(' ')), null, 2));
  } else if (command === 'demo' || command === 'apply') {
    const preview = await engine.preview(scope, command === 'demo' ?
      '改成 2 列深色，状态改成“完成”，工作流回显“你好，IDAS”' : args.join(' '));
    console.error('Changed sections: ' + preview.sections.join(', '));
    await engine.apply(preview);
    if (command === 'demo') await engine.dispatch(scope, 'run', null, 'event-' + crypto.randomUUID());
  } else if (command === 'run') {
    await engine.dispatch(scope, 'run', null, args[0] ?? 'event-' + crypto.randomUUID());
  } else if (command === 'rollback') {
    await engine.rollback(scope, Number(args[0]));
  } else if (command === 'export') {
    const s = await engine.snapshot(scope);
    if (!s || !args[0]) throw new Error('A saved workspace and an output file are required');
    await writeFile(args[0], canonical(s.spec) + '\n');
  } else if (command !== 'show') {
    throw new Error('Usage: demo | preview <intent> | apply <intent> | run [eventId] | show | export <path> | rollback <revision>');
  }
  if (command !== 'preview') console.log(JSON.stringify(await engine.snapshot(scope), null, 2));
} catch (e) { console.error(e.code ?? 'ERROR', e.message); process.exitCode = 1; }
