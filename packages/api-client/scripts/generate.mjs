import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import openapiTS, { astToString } from 'openapi-typescript';
import ts from 'typescript';

const contractPath = fileURLToPath(
  new URL('../../../apps/kernel/openapi.json', import.meta.url),
);
const outputPath = fileURLToPath(new URL('../src/generated.ts', import.meta.url));

const canonical = new Set([
  'Party',
  'Account',
  'Delegation',
  'Membership',
  'Facility',
  'Plot',
  'Planting',
  'Harvest',
  'Observation',
  'Lot',
  'CustodyTransfer',
  'Delivery',
  'DeliveryConfirmation',
  'Agreement',
  'Obligation',
  'SettlementReference',
  'Retraction',
  'Inference',
  'UnitConversion',
]);

const document = JSON.parse(await readFile(contractPath, 'utf8'));
const nodes = await openapiTS(document, {
  alphabetize: true,
  exportType: true,
  immutable: true,
  transform(_schema, options) {
    const name = options.path?.match(/^#\/components\/schemas\/([^/]+)$/)?.[1];
    if (name === undefined || !canonical.has(name)) return undefined;
    return ts.factory.createTypeReferenceNode(
      ts.factory.createQualifiedName(
        ts.factory.createIdentifier('Schema'),
        ts.factory.createIdentifier(name),
      ),
    );
  },
});

const output =
  '// Generated from apps/kernel/openapi.json. Do not edit.\n' +
  "import type * as Schema from '@clycites/schema';\n\n" +
  `export const API_VERSION = ${JSON.stringify(document.info.version)} as const;\n\n` +
  astToString(nodes);

await writeFile(outputPath, output, 'utf8');
console.log(`wrote ${outputPath}`);