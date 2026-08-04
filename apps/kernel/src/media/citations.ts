/**
 * Finding the media a record cites.
 *
 * A `MediaRef` can appear anywhere a schema puts one — `evidence` on an
 * observation, `media` on a party, and wherever a future entity puts the next
 * one. Rather than listing the fields, which would go stale the first time the
 * schema package adds an entity and would fail silently when it did, this
 * walks the document and recognises the shape.
 *
 * Recognition is deliberately strict: an object is a media citation only if it
 * carries a `content_hash` that is a lowercase hex SHA-256 *and* a
 * `storage_ref`. A loose match on `content_hash` alone would pull in anchoring
 * roots and conversion digests, and citing those would make bytes reachable
 * through records that never mentioned them.
 */

const SHA256 = /^[0-9a-f]{64}$/u;

/** How deep to walk. Records are shallow; anything deeper is not a record. */
const MAX_DEPTH = 12;

export function citedMedia(document: unknown): string[] {
  const found = new Set<string>();
  walk(document, 0, found);
  return [...found];
}

function walk(node: unknown, depth: number, found: Set<string>): void {
  if (depth > MAX_DEPTH || node === null || typeof node !== 'object') return;

  if (Array.isArray(node)) {
    for (const item of node) walk(item, depth + 1, found);
    return;
  }

  const record = node as Record<string, unknown>;
  const hash = record['content_hash'];
  if (
    typeof hash === 'string' &&
    SHA256.test(hash) &&
    typeof record['storage_ref'] === 'string'
  ) {
    found.add(hash);
    return;
  }

  for (const value of Object.values(record)) walk(value, depth + 1, found);
}
