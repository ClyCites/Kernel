/**
 * Brief §4 invariant 4: flag, never reject.
 *
 * These are the only reasons a record is refused, and every one of them is
 * structural — the record could not be stored coherently, not merely that its
 * contents look wrong. A field officer with a queue behind him cannot fix a
 * business-rule error, so business rules produce quality flags instead.
 */
export type RejectionCode =
  /** The payload does not satisfy the entity schema in @clycites/schema. */
  | 'malformed_record'
  /** No entity of that `type` exists in the schema. */
  | 'unknown_record_type'
  /** `on_behalf_of` is set but the delegation does not authorise the claim. */
  | 'delegation_not_authorised'
  /** The id is already in use by a record with different contents. */
  | 'id_conflict'
  /** `supersedes` points at a record that is not there, or would form a cycle. */
  | 'supersession_invalid'
  /** No DPPA s.7 or s.9 ground was stated. Not a defect in the claim — a
   * defect in our authority to hold it, which flagging cannot cure. */
  | 'lawful_basis_required'
  /** The stated ground does not reach this record type. s.9(1) special data
   * needs s.9(3)(b) consent, and nothing else will do. */
  | 'lawful_basis_insufficient'
  /** The record's own `lawful_basis` and the request header disagree. Since
   * v0.3 the ground lives in the envelope; the header is kept for clients that
   * have not moved yet. Two different answers is not a conflict the kernel may
   * resolve on the caller's behalf. */
  | 'lawful_basis_conflict';

export interface RejectionIssue {
  path: string;
  message: string;
}

export class RecordRejected extends Error {
  constructor(
    readonly code: RejectionCode,
    message: string,
    readonly issues: RejectionIssue[] = [],
  ) {
    super(message);
    this.name = 'RecordRejected';
  }
}

/** A read the kernel cannot carry out. Nothing to do with record contents. */
export class QueryRejected extends Error {
  constructor(
    readonly code: 'invalid_cursor' | 'unknown_record_type',
    message: string,
  ) {
    super(message);
    this.name = 'QueryRejected';
  }
}
