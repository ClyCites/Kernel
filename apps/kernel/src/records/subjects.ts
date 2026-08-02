/**
 * The fields that say who or what a record is about.
 *
 * A "subject" is not a concept the schema carries — spec §7 defines the
 * relationships between entities, but a record has no single owning party. A
 * delivery is about both parties to it. So the subject filter is a declared
 * list per entity rather than something derived, and it is matched with `@>`
 * containment so the GIN index on `body` serves it.
 */
export const SUBJECT_FIELDS: Record<string, readonly string[]> = {
  delivery: ['from_party', 'to_party', 'lot', 'fulfils'],
  delegation: ['delegator', 'delegate'],
};

export function subjectFields(type?: string | undefined): readonly string[] {
  if (type !== undefined) return SUBJECT_FIELDS[type] ?? [];
  return [...new Set(Object.values(SUBJECT_FIELDS).flat())];
}
