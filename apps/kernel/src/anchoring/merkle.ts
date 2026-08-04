import { createHash, randomBytes } from 'node:crypto';

/**
 * The tree.
 *
 * Two decisions here are the ones that matter, and both are about what an
 * attacker can do with a hash they are given legitimately.
 *
 * **Domain separation.** Leaves are hashed with a 0x00 prefix and internal
 * nodes with 0x01. Without that, a 64-byte record whose digest happens to look
 * like two concatenated hashes could be presented as an internal node, and a
 * proof could be produced for a record that was never in the tree.
 *
 * **An odd node is promoted, not duplicated.** The common shortcut of
 * duplicating the last leaf when a level has an odd count makes two different
 * leaf sets produce the same root, which is how CVE-2012-2459 worked. We carry
 * the odd node up a level unchanged instead.
 */

const LEAF = Buffer.from([0x00]);
const NODE = Buffer.from([0x01]);

const sha256 = (...parts: Buffer[]): string =>
  createHash('sha256').update(Buffer.concat(parts)).digest('hex');

const hex = (value: string): Buffer => Buffer.from(value, 'hex');

/**
 * A per-record salt, 32 bytes.
 *
 * Only the root is published, and a root over hundreds of records is not
 * reversible. A *leaf* hash is a different matter: it is handed out during
 * verification, and the records it covers are often low-entropy — a name, a
 * weight in a narrow range, a date. That is grindable on a laptop. The salt is
 * what stops a leaf hash from being an oracle for its own record.
 */
export const newSalt = (): string => randomBytes(32).toString('hex');

/**
 * A record's digest: SHA-256 over its canonical form.
 *
 * Canonical, because the same record read twice must produce the same number.
 * JSON key order is not guaranteed by anything — not by Postgres jsonb, not by
 * a client, not by a later refactor — so a digest over `JSON.stringify` would
 * be a digest over an accident.
 */
export const recordDigest = (record: unknown): string =>
  sha256(Buffer.from(canonical(record), 'utf8'));

export const leafHash = (salt: string, digest: string): string =>
  sha256(LEAF, hex(salt), hex(digest));

export const nodeHash = (left: string, right: string): string =>
  sha256(NODE, hex(left), hex(right));

export interface ProofStep {
  /** Which side the sibling sits on, so a verifier concatenates in order. */
  side: 'left' | 'right';
  hash: string;
}

/** The root over an ordered list of leaf hashes. */
export function merkleRoot(leaves: readonly string[]): string {
  if (leaves.length === 0) {
    throw new Error('a Merkle root over nothing is not a statement about anything');
  }

  let level = [...leaves];
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = level[i + 1];
      next.push(right === undefined ? left : nodeHash(left, right));
    }
    level = next;
  }
  return level[0]!;
}

/**
 * The siblings needed to walk one leaf up to the root.
 *
 * This is the whole privacy argument for the verification endpoint: every step
 * is a hash of a salted leaf or of two such hashes. A verifier learns that
 * other records were in the batch and learns nothing whatsoever about them —
 * not their type, not their subject, not their size.
 */
export function proofFor(leaves: readonly string[], index: number): ProofStep[] {
  if (index < 0 || index >= leaves.length) {
    throw new Error(`leaf ${index} is not in a tree of ${leaves.length}`);
  }

  const path: ProofStep[] = [];
  let level = [...leaves];
  let at = index;

  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = level[i + 1];

      if (right === undefined) {
        // Promoted. No sibling, so nothing to record.
        next.push(left);
        if (at === i) at = next.length - 1;
        continue;
      }

      if (at === i) {
        path.push({ side: 'right', hash: right });
        at = next.length;
      } else if (at === i + 1) {
        path.push({ side: 'left', hash: left });
        at = next.length;
      }
      next.push(nodeHash(left, right));
    }
    level = next;
  }

  return path;
}

/**
 * Recompute a root from one leaf and its path.
 *
 * Deliberately free of any dependency on this codebase's state — it takes
 * strings and returns a string. A verifier who does not trust us should be
 * able to reimplement this function from the description in
 * docs/decisions/0038-p6-anchoring.md in an afternoon, and get the same answer.
 */
export function rootFromProof(leaf: string, path: readonly ProofStep[]): string {
  let current = leaf;
  for (const step of path) {
    current =
      step.side === 'left' ? nodeHash(step.hash, current) : nodeHash(current, step.hash);
  }
  return current;
}

/**
 * Canonical JSON: keys sorted, no insignificant whitespace.
 *
 * Not RFC 8785 in full — we do not have to be, because both sides of every
 * comparison are this function, and the format is written down. What it does
 * guarantee is that a record that has not changed does not change its digest,
 * which is the only property the anchor depends on.
 */
export function canonical(value: unknown): string {
  if (value === null) return 'null';

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonical(item)).join(',')}]`;
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      // undefined is not representable in JSON, and a key whose value is
      // undefined must not shift the digest depending on whether the driver
      // materialised it.
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  }

  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error('a non-finite number has no canonical form');
  }

  if (value instanceof Date) return JSON.stringify(value.toISOString());

  return JSON.stringify(value);
}
