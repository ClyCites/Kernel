/**
 * The fields that say who or what a record is about.
 *
 * A "subject" is not something the schema carries — spec §7 defines how the
 * entities relate, but a record has no single owning party. A delivery is about
 * both sides of it; a membership is about the member and the organisation. So
 * this is a declared list per entity rather than something derived, and it is
 * matched with `@>` containment so the GIN index on `body` serves it.
 *
 * Two notations beyond a plain field name:
 *   - `id` matches the record's own id, for entities that are about themselves.
 *   - `parties[].party` matches inside an array of objects.
 */
export const SUBJECT_FIELDS: Record<string, readonly string[]> = {
  party: ['id'],
  account: ['primary_party'],
  delegation: ['delegator', 'delegate'],
  membership: ['member', 'organisation'],
  facility: ['operated_by'],
  plot: ['held_by'],
  planting: ['plot'],
  harvest: ['plot', 'planting'],
  observation: ['subject_ref'],
  lot: ['custodian'],
  custody_transfer: ['lot', 'from_party', 'to_party'],
  delivery: ['from_party', 'to_party', 'lot', 'fulfils'],
  agreement: ['parties[].party'],
  obligation: ['obligor', 'obligee', 'arising_from'],
  settlement_reference: ['obligation', 'confirmed_by'],
  retraction: ['target'],
};

export function subjectFields(type?: string | undefined): readonly string[] {
  if (type !== undefined) return SUBJECT_FIELDS[type] ?? [];
  return [...new Set(Object.values(SUBJECT_FIELDS).flat())];
}

/** The value for a `body @> …` test matching `id` in the given field. */
export function containment(field: string, id: string): Record<string, unknown> {
  const [outer, inner] = field.split('[].');
  if (inner !== undefined && outer !== undefined) {
    return { [outer]: [{ [inner]: id }] };
  }
  return { [field]: id };
}
