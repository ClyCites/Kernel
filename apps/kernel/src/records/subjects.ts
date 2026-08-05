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
  delivery_confirmation: ['delivery', 'confirming_party'],
  agreement: ['parties[].party'],
  obligation: ['obligor', 'obligee', 'arising_from'],
  settlement_reference: ['obligation', 'confirmed_by'],
  retraction: ['target'],
  // FINDING, fixed here: until P4 nothing named an inference, so every read of
  // one was denied `unattributed_record` — not by decision, but because the
  // record class had no write path and therefore never reached the guard.
  inference: ['subject_ref'],
};

export function subjectFields(type?: string | undefined): readonly string[] {
  if (type !== undefined) return SUBJECT_FIELDS[type] ?? [];
  return [...new Set(Object.values(SUBJECT_FIELDS).flat())];
}

/**
 * The subset of `SUBJECT_FIELDS` that names a party rather than an entity.
 *
 * Consent needs this and attribution does not. A delivery is *about* a lot and
 * an agreement as much as about two parties, but only a party can give a grant,
 * and resolving a grant against a lot id is meaningless.
 *
 * Entities absent here have no party field at all. Most of them reach one in a
 * single hop — see `PARTY_HOP_FIELDS`.
 */
export const PARTY_SUBJECT_FIELDS: Record<string, readonly string[]> = {
  party: ['id'],
  account: ['primary_party'],
  delegation: ['delegator', 'delegate'],
  membership: ['member', 'organisation'],
  facility: ['operated_by'],
  plot: ['held_by'],
  lot: ['custodian'],
  custody_transfer: ['from_party', 'to_party'],
  delivery: ['from_party', 'to_party'],
  // Only the confirming party. The other side of the delivery reaches this
  // record as the asserter of the delivery it names, not as its subject.
  delivery_confirmation: ['confirming_party'],
  agreement: ['parties[].party'],
  obligation: ['obligor', 'obligee'],
  settlement_reference: ['confirmed_by'],
};

/** Which parties a record is about. Never taken from the request. */
export function partiesOf(record: Record<string, unknown>): string[] {
  const type = record['type'];
  if (typeof type !== 'string') return [];
  return collect(record, PARTY_SUBJECT_FIELDS[type] ?? []);
}

/**
 * The one field a party-less record reaches a party through.
 *
 * A farmer's harvest names a plot, and the plot names its holder. Without this
 * the farmer is a third party to their own production record, which is the
 * opposite of why the platform exists — and it blocks Farm Intelligence, which
 * reads these three types and nothing else.
 *
 * Exactly one hop, declared per type. Not a graph walk: an unbounded traversal
 * is both a performance problem and a disclosure surface, since every extra
 * edge widens who counts as a party without anyone deciding that it should.
 * The record reached is read for its own direct parties and its own hop is not
 * followed.
 *
 * `retraction` is deliberately absent. Its target may be any record, including
 * a priced one, and a hop that can land on financial data without the record
 * doing the hopping being marked financial would route around s.9. The
 * retractor reaches it as asserter anyway.
 */
export const PARTY_HOP_FIELDS: Record<string, string> = {
  planting: 'plot',
  harvest: 'plot',
  observation: 'subject_ref',
  // An inference resolves exactly as the observation it was computed from
  // would: a yield prediction about a plot reaches the plot's holder, one
  // about a party reaches the party. Deliberately the same one hop and no
  // more — a prediction should not widen who may see something beyond the
  // records it was derived from.
  inference: 'subject_ref',
};

/**
 * The record this one reaches a party through, if any.
 *
 * An observation of a party resolves through the party's own record, which is
 * about itself; an observation of a region resolves through nothing, because
 * regions are registry rows and no uuid names one. Both fall out of the same
 * lookup rather than being special-cased.
 */
export function partyHopOf(record: Record<string, unknown>): string | null {
  const type = record['type'];
  if (typeof type !== 'string') return null;

  const field = PARTY_HOP_FIELDS[type];
  if (field === undefined) return null;

  const ref = record[field];
  return typeof ref === 'string' ? ref : null;
}

/**
 * `Observation.subject_type` names a kind of thing; the log stores record
 * types. They line up everywhere except `region`, which has no record — regions
 * live in `registry.admin_region`, keyed by code and vintage, so no uuidv7
 * `subject_ref` can name one. A region observation is therefore unresolvable by
 * construction. Spec §13 finding, not something to paper over here.
 */
export const RECORD_TYPE_FOR_SUBJECT: Record<string, string | null> = {
  plot: 'plot',
  lot: 'lot',
  party: 'party',
  facility: 'facility',
  planting: 'planting',
  region: null,
};

/** What a stored record looks like to a subject lookup. */
export interface SubjectTarget {
  type: string;
  retracted: boolean;
}

export interface SubjectResolution {
  ref: string;
  declared_type: string;
  exists: boolean;
  actual_type: string | null;
  /** Null while unknowable: the subject has not arrived, or names no record. */
  type_matches: boolean | null;
  retracted: boolean;
}

export function resolveSubject(
  declaredType: string,
  ref: string,
  found: SubjectTarget | undefined,
): SubjectResolution {
  const expected = RECORD_TYPE_FOR_SUBJECT[declaredType] ?? null;

  return {
    ref,
    declared_type: declaredType,
    exists: found !== undefined,
    actual_type: found?.type ?? null,
    type_matches:
      expected === null || found === undefined ? null : found.type === expected,
    retracted: found?.retracted ?? false,
  };
}

/**
 * The one thing about a subject that is permanently true the moment it is
 * knowable. Absence is not: an observation routinely syncs before its subject.
 */
export function subjectTypeMismatched(
  declaredType: string,
  found: SubjectTarget | undefined,
): boolean {
  return resolveSubject(declaredType, '', found).type_matches === false;
}

/** The value for a `body @> …` test matching `id` in the given field. */
export function containment(field: string, id: string): Record<string, unknown> {
  const [outer, inner] = field.split('[].');
  if (inner !== undefined && outer !== undefined) {
    return { [outer]: [{ [inner]: id }] };
  }
  return { [field]: id };
}

/**
 * Who a stored record is about. The consent guard is built from this and never
 * from request input, so a caller cannot nominate their own subjects.
 *
 * An empty result means the record cannot be attributed to anyone, which the
 * consent decision treats as un-releasable rather than unrestricted.
 */
export function subjectsOf(record: Record<string, unknown>): string[] {
  const type = record['type'];
  if (typeof type !== 'string') return [];
  return collect(record, subjectFields(type));
}

function collect(
  record: Record<string, unknown>,
  fields: readonly string[],
): string[] {
  const found = new Set<string>();
  for (const field of fields) {
    if (field === 'id') {
      const id = record['id'];
      if (typeof id === 'string') found.add(id);
      continue;
    }

    const [outer, inner] = field.split('[].');
    if (outer === undefined) continue;
    const value = record[outer];

    if (inner === undefined) {
      if (typeof value === 'string') found.add(value);
      continue;
    }

    if (!Array.isArray(value)) continue;
    for (const element of value) {
      const nested = (element as Record<string, unknown> | null)?.[inner];
      if (typeof nested === 'string') found.add(nested);
    }
  }

  return [...found];
}
