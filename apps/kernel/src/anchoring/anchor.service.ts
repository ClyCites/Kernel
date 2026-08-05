import { Inject, Injectable, Optional } from '@nestjs/common';
import { uuidv7 } from 'uuidv7';

import { AuditService } from '../audit/audit.service.js';
import { ReadService, type Reader } from '../records/read.service.js';
import { subjectsOf } from '../records/subjects.js';
import {
  AnchorRepository,
  type AnchorBatchRow,
  type NewLeaf,
} from './anchor.repository.js';
import {
  leafHash,
  merkleRoot,
  newSalt,
  proofFor,
  recordDigest,
  rootFromProof,
  type ProofStep,
} from './merkle.js';
import {
  encodeMessage,
  HCS_PUBLISHER,
  type TopicPublisher,
} from './publisher.js';

/** One message a day; a batch far larger than this is a sign something is wrong. */
export const MAX_BATCH_RECORDS = 50_000;

/** Retries are spaced, not immediate; a network that is down stays down for a while. */
export const RETRY_BACKOFF_SECONDS = [60, 300, 1_800, 7_200, 21_600] as const;

export interface AnchorProof {
  record_id: string;
  batch_date: string;
  merkle_root: string;
  record_count: number;
  network: string;
  topic_id: string | null;
  sequence_number: string | null;
  consensus_at: string | null;
  salt: string;
  record_digest: string;
  leaf_hash: string;
  path: ProofStep[];
}

export interface AnchorRun {
  date: string;
  batch: AnchorBatchRow | null;
  anchored: number;
  published: boolean;
  error: string | null;
}

export interface AnchorVerification {
  batch_date: string;
  published_root: string;
  recomputed_root: string | null;
  expected_count: number;
  restored_count: number;
  topic_id: string | null;
  sequence_number: string | null;
  network: string;
  agrees: boolean;
}

/**
 * How long anchoring may be silent before it is a fault.
 *
 * The batch covers the previous day, so a healthy kernel is always one day
 * behind and never zero. Two days is one missed run, which happens; three is a
 * pattern. Set here rather than in configuration because an operator who can
 * widen the window can also silence the alarm, and the whole point of this
 * measure is that it cannot be quietly turned off.
 */
export const ANCHOR_STALE_AFTER_DAYS = 3;

/**
 * The state a monitor needs, not the outcome of a run.
 *
 * `stale` is computed from whether a fresh root exists, so a scheduler that
 * was never installed, a container that stopped, and a credential that expired
 * all produce the same alert. A check that watched exit codes would see
 * nothing in any of those cases, because a job that does not run does not
 * fail.
 */
export interface AnchorFreshness {
  configured: boolean;
  last_published: string | null;
  last_consensus_at: string | null;
  age_days: number | null;
  stale: boolean;
  stale_after_days: number;
  pending_batches: number;
  failed_batches: number;
  oldest_unanchored: string | null;
  unanchored_age_days: number | null;
}

@Injectable()
export class AnchorService {
  constructor(
    @Inject(AnchorRepository) private readonly anchors: AnchorRepository,
    @Inject(ReadService) private readonly reads: ReadService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Optional()
    @Inject(HCS_PUBLISHER)
    private readonly publisher: TopicPublisher | null = null,
  ) {}

  get configured(): boolean {
    return this.publisher !== null;
  }

  /**
   * Build the day's batch and publish it.
   *
   * Idempotent in both halves. Re-running a day whose batch exists returns
   * that batch untouched; re-running a day whose batch is pending retries the
   * publish. Neither produces a second root.
   */
  async run(date: string): Promise<AnchorRun> {
    const existing = await this.anchors.batchFor(date);
    if (existing !== null) {
      if (existing.state === 'published') {
        return { date, batch: existing, anchored: 0, published: false, error: null };
      }
      const error = await this.publish(existing);
      return {
        date,
        batch: await this.anchors.batchById(existing.id),
        anchored: 0,
        published: error === null,
        error,
      };
    }

    const built = await this.build(date);
    if (built === null) {
      return { date, batch: null, anchored: 0, published: false, error: null };
    }

    const error = await this.publish(built);
    return {
      date,
      batch: await this.anchors.batchById(built.id),
      anchored: built.record_count,
      published: error === null,
      error,
    };
  }

  /**
   * The tree, stored. Returns null when there is nothing to anchor — an empty
   * batch would publish a root that says nothing and cost a message to say it.
   */
  async build(date: string): Promise<AnchorBatchRow | null> {
    const records = await this.anchors.unanchored(date, MAX_BATCH_RECORDS);
    if (records.length === 0) return null;

    const bodies = await this.anchors.bodies(records.map((record) => record.id));

    const leaves: NewLeaf[] = [];
    for (const [position, record] of records.entries()) {
      const body = bodies.get(record.id);
      if (body === undefined) {
        throw new Error(`record ${record.id} is in the key table but not in either log`);
      }
      const salt = newSalt();
      const digest = recordDigest(body);
      leaves.push({
        record_id: record.id,
        position,
        salt,
        record_digest: digest,
        leaf_hash: leafHash(salt, digest),
      });
    }

    return this.anchors.createBatch({
      id: uuidv7(),
      date,
      root: merkleRoot(leaves.map((leaf) => leaf.leaf_hash)),
      network: this.publisher?.network ?? 'testnet',
      leaves,
    });
  }

  /** Returns null on success, or the error that will be retried. */
  async publish(batch: AnchorBatchRow): Promise<string | null> {
    if (this.publisher === null) {
      return 'no publisher is configured';
    }

    try {
      const receipt = await this.publisher.publish(
        encodeMessage({
          v: 1,
          kind: 'clycites.anchor',
          dataset: 'live',
          date: batch.batch_date,
          root: batch.merkle_root,
          count: batch.record_count,
          alg: 'sha256/salted-leaf/v1',
        }),
      );

      await this.anchors.markPublished(batch.id, receipt);
      await this.audit.record({
        action: 'anchor.publish',
        outcome: 'allowed',
        dataset: 'live',
        reason: 'root_published',
        detail: {
          batch_date: batch.batch_date,
          merkle_root: batch.merkle_root,
          record_count: batch.record_count,
          network: this.publisher.network,
          topic_id: receipt.topicId,
          sequence_number: receipt.sequenceNumber,
        },
      });
      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.anchors.markFailed(batch.id, message);
      return message;
    }
  }

  /** Seconds to wait before the next attempt on a batch that has failed. */
  backoffFor(attempts: number): number {
    const last = RETRY_BACKOFF_SECONDS[RETRY_BACKOFF_SECONDS.length - 1]!;
    return RETRY_BACKOFF_SECONDS[attempts] ?? last;
  }

  /**
   * A proof for one record.
   *
   * Gated on the ordinary read check, which is not obvious and is worth saying
   * why. The proof carries the record's salt, and the salt is the only thing
   * standing between a leaf hash and a brute-force search over a low-entropy
   * record. Handing salts to anyone who asks would undo the reason they exist.
   * The verifier this endpoint is for is someone the subject has already let
   * see the record; what they gain here is not access, it is the ability to
   * stop trusting us about it.
   *
   * What comes back contains no other record. Every step of the path is a hash
   * of a salted leaf or of two such hashes.
   */
  async proof(recordId: string, reader: Reader): Promise<AnchorProof | null> {
    const view =
      (await this.reads.get(recordId, reader).catch(() => null)) ??
      (await this.reads.getInference(recordId, reader).catch(() => null));
    if (view === null) return null;

    const leaf = await this.anchors.leafFor(recordId);
    if (leaf === null) return null;

    const batch = await this.anchors.batchById(leaf.batch_id);
    if (batch === null) return null;

    const all = await this.anchors.leaves(leaf.batch_id);
    const path = proofFor(
      all.map((row) => row.leaf_hash),
      leaf.position,
    );

    // Cheap, and it catches the case that matters: a stored root that no
    // longer agrees with the stored leaves means the proof we are about to
    // hand out would fail in the verifier's hands, and we should find that
    // out first.
    if (rootFromProof(leaf.leaf_hash, path) !== batch.merkle_root) {
      throw new Error(
        `batch ${batch.id} does not reproduce its own root; the proof would be wrong`,
      );
    }

    await this.audit.record({
      action: 'anchor.prove',
      outcome: 'allowed',
      dataset: 'live',
      reason: 'proof_issued',
      actor: reader.requester ?? undefined,
      subjects: subjectsOf(view.record),
      records: [recordId],
      recordTypes: [String(view.record.type)],
      detail: { batch_date: batch.batch_date, merkle_root: batch.merkle_root },
    });

    return {
      record_id: recordId,
      batch_date: batch.batch_date,
      merkle_root: batch.merkle_root,
      record_count: batch.record_count,
      network: batch.network,
      topic_id: batch.topic_id,
      sequence_number: batch.sequence_number,
      consensus_at: batch.consensus_at,
      salt: leaf.salt,
      record_digest: leaf.record_digest,
      leaf_hash: leaf.leaf_hash,
      path,
    };
  }

  /** Every published root. Deliberately open: a verifier must not need us. */
  roots(): Promise<{ batch_date: string; merkle_root: string; record_count: number }[]> {
    return this.anchors.publishedRoots();
  }

  /**
   * Whether a fresh root exists — the measure the alert hangs on.
   *
   * Anchoring is the only property in the kernel whose failure is silent by
   * construction. Everything else breaks in front of somebody: a refused write
   * is a 4xx a caller sees, a broken read is a support ticket. A batch that
   * stops running produces nothing at all, and the absence is only noticed the
   * first time someone needs a proof, which is exactly the moment it cannot be
   * repaired. So the alarm is wired to the absence of an expected root rather
   * than to the presence of an error.
   *
   * `configured` is reported alongside because a kernel with no publisher is
   * not broken — it is a deployment that has not been given a topic — and an
   * alert that cannot tell those apart gets muted.
   */
  async freshness(now: Date = new Date()): Promise<AnchorFreshness> {
    const state = await this.anchors.freshness();

    const days = (from: Date): number =>
      Math.floor((now.getTime() - from.getTime()) / 86_400_000);

    const ageDays =
      state.lastPublished === null
        ? null
        : days(new Date(`${state.lastPublished}T00:00:00Z`));

    const unanchoredAgeDays =
      state.oldestUnanchored === null ? null : days(state.oldestUnanchored);

    return {
      configured: this.configured,
      last_published: state.lastPublished,
      last_consensus_at: state.lastConsensusAt?.toISOString() ?? null,
      age_days: ageDays,
      // Never anchored at all counts as stale once a publisher is configured.
      // The first root is the one most likely never to be cut, because that is
      // the run nobody has watched succeed yet.
      stale:
        this.configured &&
        (ageDays === null || ageDays > ANCHOR_STALE_AFTER_DAYS),
      stale_after_days: ANCHOR_STALE_AFTER_DAYS,
      pending_batches: state.pendingBatches,
      failed_batches: state.failedBatches,
      oldest_unanchored: state.oldestUnanchored?.toISOString() ?? null,
      unanchored_age_days: unanchoredAgeDays,
    };
  }

  /**
   * Recompute every published root from the leaves that are actually here.
   *
   * This is the point of anchoring turned back on ourselves. A backup manifest
   * says a restore matches a file we wrote at backup time, which is a real
   * check against corruption and no check at all against us. A published root
   * is different: it was on a public topic before the restore existed, so a
   * restore that reproduces it from its own rows has been checked against
   * evidence it could not have manufactured.
   *
   * A mismatch means the restored leaves are not the leaves that were anchored
   * — records missing, records altered, or a batch reassembled out of order.
   * Any of those is a failed restore, not a warning.
   */
  async verify(): Promise<AnchorVerification[]> {
    const published = await this.anchors.publishedBatches();
    const results: AnchorVerification[] = [];

    for (const batch of published) {
      const leaves = await this.anchors.leaves(batch.id);
      const recomputed =
        leaves.length === 0 ? null : merkleRoot(leaves.map((leaf) => leaf.leaf_hash));

      results.push({
        batch_date: batch.batch_date,
        published_root: batch.merkle_root,
        recomputed_root: recomputed,
        expected_count: batch.record_count,
        restored_count: leaves.length,
        topic_id: batch.topic_id,
        sequence_number: batch.sequence_number,
        network: batch.network,
        agrees: recomputed === batch.merkle_root && leaves.length === batch.record_count,
      });
    }

    return results;
  }
}
