import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * J6 — naming discipline.
 *
 * The kernel supplies verified measurements: how much was delivered, on what
 * factor, weighed by whom, with what evidence behind the factor. It does not
 * score anybody. A lender scores; that is their judgement, their model and
 * their regulatory exposure, and it stays on their side of the API.
 *
 * The distinction is not cosmetic. "Credit score" is a term of art with a
 * settled meaning, and a system that emits one has taken on an automated
 * decision under DPPA s.14 and a set of duties nobody here has agreed to
 * discharge. It also invites the exact misreading the whole design exists to
 * prevent — that a cooperative's scale drift is a fact about a farmer.
 *
 * So the words are banned in code, in documentation, and in the OpenAPI
 * document a lender's engineers will read. This test is the enforcement.
 */

const BANNED = [
  /credit[ _-]?scor(e|es|ed|ing)/i,
  /credit[ _-]?rating/i,
  /credit[ _-]?worth(y|iness)/i,
  /risk[ _-]?scor(e|es|ed|ing)/i,
];

const SCANNED_EXTENSIONS = ['.ts', '.tsx', '.js', '.md', '.sql', '.json', '.yml', '.yaml'];

const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  '.turbo',
  'dist',
  'build',
  'coverage',
]);

/**
 * `@clycites/schema` is vendored and read-only — the contract is owned
 * elsewhere and this repository may not edit it. It contains one occurrence,
 * in prose describing why a forward commitment from a solvent buyer improves a
 * loan's security. That is a statement about a buyer's balance sheet and not
 * an output of this system, but it is exactly the word this rule bans and it
 * should be raised with whoever owns the package. Carved out by name, so a
 * *new* occurrence anywhere else still fails.
 */
const CARVED_OUT = [
  join('packages', 'schema'),
  // This file names the banned terms in order to ban them.
  join('apps', 'kernel', 'test', 'invariants', 'naming.test.ts'),
];

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

interface Hit {
  file: string;
  line: number;
  text: string;
}

function* walk(directory: string): Generator<string> {
  for (const entry of readdirSync(directory)) {
    if (SKIPPED_DIRECTORIES.has(entry)) continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      yield* walk(path);
      continue;
    }
    if (SCANNED_EXTENSIONS.some((extension) => entry.endsWith(extension))) yield path;
  }
}

function scan(): Hit[] {
  const hits: Hit[] = [];
  for (const path of walk(REPO_ROOT)) {
    const relativePath = relative(REPO_ROOT, path);
    if (CARVED_OUT.some((carve) => relativePath === carve || relativePath.startsWith(carve + sep))) {
      continue;
    }

    const lines = readFileSync(path, 'utf8').split('\n');
    lines.forEach((text, index) => {
      if (BANNED.some((pattern) => pattern.test(text))) {
        hits.push({ file: relativePath, line: index + 1, text: text.trim() });
      }
    });
  }
  return hits;
}

describe('the kernel supplies measurements; lenders score', () => {
  test('no scoring vocabulary anywhere in code, documentation or the contract', () => {
    const hits = scan();
    assert.deepEqual(
      hits,
      [],
      `the kernel does not score anybody. Rephrase in terms of what was ` +
        `verified:\n${hits.map((hit) => `  ${hit.file}:${hit.line}  ${hit.text}`).join('\n')}`,
    );
  });

  test('the OpenAPI document was scanned, not merely assumed clean', () => {
    // A rule that silently stops covering the contract is worse than none. The
    // document is generated, so it is the file most likely to acquire the
    // vocabulary without anybody typing it into a source file.
    const scanned = [...walk(REPO_ROOT)].map((path) => relative(REPO_ROOT, path));
    assert.ok(
      scanned.includes(join('apps', 'kernel', 'openapi.json')),
      'openapi.json is not being scanned',
    );
    assert.ok(
      scanned.some((path) => path.startsWith(join('docs')) && path.endsWith('.md')),
      'the documentation is not being scanned',
    );
  });

  test('the rule catches the phrasings it is meant to catch', () => {
    const shouldFail = [
      'the credit score is 720',
      'creditScore: number',
      'credit-scoring model',
      'a credit rating from the bureau',
      'assessing creditworthiness',
      'risk_score above 0.4',
    ];
    for (const phrase of shouldFail) {
      assert.ok(
        BANNED.some((pattern) => pattern.test(phrase)),
        `"${phrase}" should be banned`,
      );
    }

    // And does not catch the things the kernel legitimately says. Naming a
    // lender's purpose is not scoring; neither is naming the risk itself.
    const shouldPass = [
      'purpose: credit_assessment',
      'a lender scores; the kernel supplies verified metrics',
      'the risk that a bag factor is wrong',
      'credit is extended by somebody else',
    ];
    for (const phrase of shouldPass) {
      assert.ok(
        !BANNED.some((pattern) => pattern.test(phrase)),
        `"${phrase}" is legitimate and must not be banned`,
      );
    }
  });
});
