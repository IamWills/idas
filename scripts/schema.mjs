import { writeFile } from 'node:fs/promises';
import { jsonSchema } from '../packages/contracts/dist/index.js';
await writeFile(new URL('../docs/idss.schema.json', import.meta.url), JSON.stringify(jsonSchema(), null, 2) + '\n');
