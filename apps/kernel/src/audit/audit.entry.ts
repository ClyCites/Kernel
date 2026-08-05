import { z } from 'zod';

import type { Dataset } from '../records/record.js';

/**
 * What the audit log is allowed to say happened.
 *
 * Closed on purpose. A free-text action column drifts within a month into
 * fifteen spellings of the same event, and the first query that has to answer a
 * data subject's s.24(1)(c) request then misses a third of the entries.
 */
export const AUDIT_ACTIONS = [
  /** Records were disclosed to a party. */
  'record.read',
  /** A record was appended. */
  'record.write',
  /** A disclosure was refused. */
  'consent.denied',
  /** An append was refused. */
  'write.refused',
  /** The shape of the database changed. Written by the database, not by us. */
  'schema.ddl',
  /**
   * A download url was issued for stored bytes.
   *
   * Separate from `record.read` because releasing a photograph is not the same
   * act as returning the row that cites it — but counted alongside it by
   * `audit.disclosures_to`, because it is just as much a disclosure.
   */
  'media.read',
  /** Bytes were accepted and stored. */
  'media.write',
  /** An upload was refused. */
  'media.refused',
  /** A Merkle root was submitted to the consensus service. */
  'anchor.publish',
  /**
   * A proof was handed out for one record.
   *
   * Logged because the proof carries that record's salt, which is the only
   * thing standing between its leaf hash and a brute-force search.
   */
  'anchor.prove',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];
export type AuditOutcome = 'allowed' | 'denied';

/**
 * The query descriptor.
 *
 * Scalars only, and that is the whole point rather than a convenience. A record
 * body is an object; nesting is therefore not representable here, so no call
 * site can pass one by accident and no future call site can pass one on
 * purpose without changing this type and failing the invariant test that reads
 * it. "We promise not to log bodies" is not a control. A type that cannot hold
 * one is.
 *
 * Values are capped as well as typed, because a long enough string is a body.
 */
export const MAX_DESCRIPTOR_VALUE = 200;

export const AuditDescriptor = z.record(
  z.string().max(64),
  z.union([z.string().max(MAX_DESCRIPTOR_VALUE), z.number(), z.boolean(), z.null()]),
);

export type AuditDescriptor = z.infer<typeof AuditDescriptor>;

/**
 * One access decision.
 *
 * Ids and descriptors. Nothing here can carry what a record said — only which
 * record it was, who it was about, who asked, and what the kernel decided.
 */
export interface AuditEntry {
  action: AuditAction;
  outcome: AuditOutcome;
  /**
   * 0011. Carried per entry so that access to the fabricated corpus never
   * surfaces in a real subject's disclosure list.
   */
  dataset: Dataset;
  /**
   * The consent reason, the rejection code, or the DDL command tag.
   *
   * Denials matter more than successes here: a shifting denial rate is the
   * earliest signal that something upstream has broken, and that signal only
   * exists if the reason is recorded rather than the fact of refusal.
   */
  reason?: string | null | undefined;
  /** The verified subject claim. Null when none reached the kernel. */
  actor?: string | null | undefined;
  /** OAuth client that made the request, distinct from the recipient party. */
  clientId?: string | null | undefined;
  /** Party the client represented and to whom the disclosure was made. */
  actingFor?: string | null | undefined;
  purpose?: string | null | undefined;
  /** Who the data was about. Answers DPPA s.24(1)(c). */
  subjects?: readonly string[] | undefined;
  /** Which records. Answers DPPA s.16(4). */
  records?: readonly string[] | undefined;
  recordTypes?: readonly string[] | undefined;
  detail?: AuditDescriptor | null | undefined;
  correlationId?: string | null | undefined;
}

/**
 * Arrays are bounded before they reach the database.
 *
 * A page of 200 records with several subjects each would otherwise put a
 * thousand uuids in one row, and the entry stops being a description of an
 * access and starts being a copy of its result set. The count is kept in the
 * descriptor so the truncation is visible rather than silent.
 */
export const MAX_IDS_PER_ENTRY = 100;

export function boundedIds(ids: readonly string[] | undefined): string[] {
  if (ids === undefined) return [];
  const unique = [...new Set(ids)];
  return unique.slice(0, MAX_IDS_PER_ENTRY);
}
