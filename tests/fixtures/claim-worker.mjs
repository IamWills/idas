import { appendFile, access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { Engine, Registry } from '../../packages/core/dist/index.js';
import { standard, echoPlugin } from '../../packages/standard/dist/index.js';
import { fileStore, fileWorkspaceClaim } from '../../packages/node/dist/index.js';

const [directory, action] = process.argv.slice(2);
const registry = new Registry('node');
await registry.load(() => standard({
  store: fileStore(directory), resolve: registry.inspect.bind(registry), tool: registry.invoke.bind(registry),
}));
await registry.load(() => fileWorkspaceClaim(directory));
const echo = echoPlugin();
await registry.load(() => ({
  ...echo,
  async invoke(_capability, input, { signal }) {
    await appendFile(join(directory, 'calls'), 'invoked\n');
    if (action === 'hold') await writeFile(join(directory, 'entered'), '');
    while (action === 'hold') {
      try { await access(join(directory, 'continue')); break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await setTimeout(10, undefined, { signal });
    }
    return input;
  },
}));
const engine = new Engine(registry, { workspaceClaim: true });
try {
  if (action === 'init') {
    await engine.apply(await engine.preview('desk', 'workflow echo "safe"'));
  } else if (action === 'apply') {
    await engine.apply(await engine.preview('desk', 'dark mode'));
  } else {
    const result = await engine.dispatch('desk', 'run', null, 'same-event');
    console.log(result.revision);
  }
} catch (error) {
  console.error(error.code);
  process.exitCode = 1;
}
