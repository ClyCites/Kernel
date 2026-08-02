import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { buildOpenApiDocument } from './openapi.js';

const target = fileURLToPath(new URL('../../openapi.json', import.meta.url));

await writeFile(target, `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`);
console.log(`wrote ${target}`);
