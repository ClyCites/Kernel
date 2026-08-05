import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stable(child)]),
    );
  }
  return value;
}

function same(left, right) {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

export function changedExistingContracts(base, head) {
  const changes = [];
  for (const section of ['paths', 'schemas']) {
    const baseEntries =
      section === 'schemas'
        ? base.components?.schemas ?? {}
        : base.paths ?? {};
    const headEntries =
      section === 'schemas'
        ? head.components?.schemas ?? {}
        : head.paths ?? {};
    for (const [name, value] of Object.entries(baseEntries)) {
      if (!(name in headEntries) || !same(value, headEntries[name])) {
        changes.push(`${section}.${name}`);
      }
    }
  }
  return changes;
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

async function documents(args) {
  const baseFlag = args.indexOf('--base');
  const headFlag = args.indexOf('--head');
  if (baseFlag >= 0 && headFlag >= 0) {
    return Promise.all([
      readFile(args[baseFlag + 1], 'utf8').then(JSON.parse),
      readFile(args[headFlag + 1], 'utf8').then(JSON.parse),
    ]);
  }

  const baseRef = process.env.GITHUB_BASE_REF;
  const mergeBase = baseRef
    ? git('merge-base', 'HEAD', `origin/${baseRef}`)
    : git('rev-parse', 'HEAD^');
  const base = JSON.parse(
    git('show', `${mergeBase}:apps/kernel/openapi.json`),
  );
  const head = JSON.parse(await readFile('apps/kernel/openapi.json', 'utf8'));
  return [base, head];
}

async function main() {
  const [base, head] = await documents(process.argv.slice(2));
  const changes = changedExistingContracts(base, head);
  if (changes.length === 0) {
    console.log('OpenAPI compatibility gate passed');
    return;
  }
  if (process.env.BREAKING_CHANGE_APPROVED === '1') {
    console.log(`Approved contract changes: ${changes.join(', ')}`);
    return;
  }
  console.error(`Pre-existing OpenAPI contracts changed: ${changes.join(', ')}`);
  console.error('Apply the breaking-change PR label only after explicit review.');
  process.exitCode = 1;
}

if (process.argv[1] === new URL(import.meta.url).pathname) await main();