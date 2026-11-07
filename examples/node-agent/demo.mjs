import { writeFile } from 'node:fs/promises';
import { Engine, Registry } from '../../packages/core/dist/index.js';
import { echoPlugin, standard } from '../../packages/standard/dist/index.js';
import { fileStore } from '../../packages/node/dist/index.js';
import { canonical } from '../../packages/contracts/dist/index.js';

const registry = new Registry('node', undefined, event => {
  if (process.env.IDAS_TRACE) console.error(JSON.stringify(event));
});
await registry.load(() => standard({
  store: fileStore(process.env.IDAS_DATA ?? '.idas-data'),
  resolve: registry.inspect.bind(registry), tool: registry.invoke.bind(registry),
}));
await registry.load(echoPlugin);
const engine = new Engine(registry);
const [command = 'demo', ...args] = process.argv.slice(2);
const scope = 'workspace';
try {
  if (command === 'demo' || command === 'apply') {
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
    throw new Error('Usage: demo | apply <intent> | run [eventId] | show | export <path> | rollback <revision>');
  }
  console.log(JSON.stringify(await engine.snapshot(scope), null, 2));
} catch (e) { console.error(e.code ?? 'ERROR', e.message); process.exitCode = 1; }
