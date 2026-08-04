import { Inject, Injectable } from '@nestjs/common';
import { uuidv7 } from 'uuidv7';
import { Inference, MAX_RECOMMENDED_INFERENCE_DEPTH } from '@clycites/schema';

import { AuditService } from '../audit/audit.service.js';
import { RecordRejected } from '../records/errors.js';
import { RecordRepository } from '../records/record.repository.js';
import {
  splitEnvelope,
  type Dataset,
  type RecordDocument,
  type StoredRecord,
} from '../records/record.js';
import { isLawfulBasis, LAWFUL_BASES, type LawfulBasis } from '../records/lawful-basis.js';
import {
  InferenceRepository,
  type ValidationRow,
  type Verdict,
} from './inference.repository.js';

/** Depth was computed at 2 or more: a model consuming another model's output. */
export const INFERENCE_DEPTH_EXCEEDED = 'inference_depth_exceeded';
/** An input is not in the corpus, so the depth beneath it is unknown. */
export const INFERENCE_INPUT_UNRESOLVED = 'inference_input_unresolved';
/** The client's own `inference_depth` disagreed with the computed one. */
export const INFERENCE_DEPTH_MISSTATED = 'inference_depth_misstated';

export interface InferenceContext {
  dataset?: Dataset | undefined;
  /**
   * No default, and no inheritance from the inputs. An inference about a named
   * farmer is processing of that farmer's data in its own right, and the fact
   * that each input carried a ground does not establish one for the derived
   * claim — a model may well produce something the collection consent never
   * reached. Same reasoning as `IngestContext.lawfulBasis`.
   */
  lawfulBasis?: LawfulBasis | undefined;
  correlationId?: string | null | undefined;
}

export interface InferenceResult {
  record: StoredRecord;
  replayed: boolean;
}

export interface LinkValidation {
  inference: string;
  observation: string;
  verdict: Verdict;
  note: string | null;
  linkedBy: string;
  dataset: Dataset;
  correlationId?: string | null | undefined;
}

/**
 * The inference write path. Separate from `IngestService` on purpose, and not
 * a branch inside it: brief §4 invariant 2 says observations and inferences
 * never mix, and a single service with an `if (record_class === …)` is one
 * refactor away from mixing them.
 *
 * Two things the client does not get to decide:
 *
 *   `inference_depth`, which is computed here from the inputs actually in the
 *   corpus. A client that could declare its own depth could declare 0 on a
 *   model chained three deep, and depth is the only signal that compounding
 *   error is happening at all.
 *
 *   `validated_by`, which is derived on read from `inference.validation`. The
 *   log is append-only, so a stored array could never gain the August
 *   observation that settles a March prediction.
 */
@Injectable()
export class InferenceService {
  constructor(
    @Inject(RecordRepository) private readonly repository: RecordRepository,
    @Inject(InferenceRepository) private readonly inferences: InferenceRepository,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async append(
    payload: unknown,
    context: InferenceContext = {},
  ): Promise<InferenceResult> {
    const dataset = context.dataset ?? 'live';
    const basis = context.lawfulBasis;
    if (basis === undefined || !isLawfulBasis(basis)) {
      throw new RecordRejected(
        'lawful_basis_required',
        'no DPPA ground was stated for this inference',
        [
          {
            path: 'x-clycites-lawful-basis',
            message: `expected one of: ${LAWFUL_BASES.join(', ')}`,
          },
        ],
      );
    }

    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      throw new RecordRejected('malformed_record', 'an inference must be a JSON object');
    }

    const submitted = payload as Record<string, unknown>;

    // Same discipline as the fact path: kernel-derived fields are stripped
    // before validation rather than checked afterwards, so there is no branch
    // in which a client value survives.
    const candidate: Record<string, unknown> = {
      ...submitted,
      recorded_at: new Date().toISOString(),
    };
    const claimedDepth = candidate['inference_depth'];
    delete candidate['stale'];
    delete candidate['validated_by'];
    // Restored below with the computed value. Present here only because the
    // schema requires the field and would otherwise reject before we can say
    // anything useful about why.
    candidate['inference_depth'] = typeof claimedDepth === 'number' ? claimedDepth : 0;

    const parsed = Inference.safeParse(candidate);
    if (!parsed.success) {
      throw new RecordRejected(
        'malformed_record',
        'the record does not satisfy the Inference schema',
        parsed.error.issues.map((issue) => ({
          path: issue.path.join('.') || '(root)',
          message: issue.message,
        })),
      );
    }

    const document = parsed.data as unknown as RecordDocument;
    const { envelope, body } = splitEnvelope(document);
    const inputs = (body['inputs'] as string[] | undefined) ?? [];

    const { depth, unresolved } = await this.depthOf(inputs, dataset);
    body['inference_depth'] = depth;
    body['validated_by'] = [];
    body['stale'] = false;

    const flags: string[] = [];
    if (depth > MAX_RECOMMENDED_INFERENCE_DEPTH) flags.push(INFERENCE_DEPTH_EXCEEDED);
    if (unresolved.length > 0) flags.push(INFERENCE_INPUT_UNRESOLVED);
    // Not a rejection. The record is still what the model produced, and P6 says
    // flag rather than refuse — but a client whose arithmetic disagrees with
    // the kernel's is worth knowing about, because it usually means the client
    // does not know what its own inputs are.
    if (typeof claimedDepth === 'number' && claimedDepth !== depth) {
      flags.push(INFERENCE_DEPTH_MISSTATED);
    }

    const record: StoredRecord = {
      id: String(envelope['id']),
      type: 'inference',
      record_class: 'inference',
      schema_version: String(envelope['schema_version']),
      occurred_at: String(envelope['occurred_at']),
      occurred_at_precision: String(envelope['occurred_at_precision']),
      recorded_at: String(envelope['recorded_at']),
      asserted_by: String(envelope['asserted_by']),
      authenticated_as: null,
      on_behalf_of: null,
      delegation: null,
      device_id: null,
      supersedes: null,
      body,
      ext: (envelope['ext'] as Record<string, unknown> | undefined) ?? {},
      quality_flags: flags,
      dataset,
      lawful_basis: basis,
    };

    const result = await this.repository.appendIfAbsent(record);

    await this.audit.record({
      action: 'record.write',
      outcome: 'allowed',
      dataset,
      reason: result.replayed ? 'inference_replayed' : 'inference_appended',
      actor: record.asserted_by,
      records: [record.id],
      recordTypes: ['inference'],
      detail: {
        inference_depth: depth,
        claimed_depth: typeof claimedDepth === 'number' ? claimedDepth : null,
        unresolved_inputs: unresolved.length,
      },
      correlationId: context.correlationId ?? null,
    });

    return result;
  }

  /**
   * `1 + max(depth of inputs)`, or 0 when every input is an observation.
   *
   * Computed from the corpus, never from the payload. An input that is not in
   * the corpus contributes 0 and is named separately: it would be worse to
   * silently assume an absent input is an observation, since the commonest
   * reason for absence is that it is an inference in another dataset.
   */
  private async depthOf(
    inputs: readonly string[],
    dataset: Dataset,
  ): Promise<{ depth: number; unresolved: string[] }> {
    const [depths, observations] = await Promise.all([
      this.inferences.inputDepths(inputs, dataset),
      this.inferences.knownObservations(inputs, dataset),
    ]);

    const unresolved = inputs.filter(
      (id) => !depths.has(id) && !observations.has(id),
    );

    if (depths.size === 0) return { depth: 0, unresolved };

    const deepest = Math.max(...[...depths.values()]);
    return { depth: deepest + 1, unresolved };
  }

  /**
   * Spec §6.3. What reality later said, linked to the prediction that said it
   * first.
   *
   * The link is a row beside the inference, never an edit to it. The
   * prediction acquires a verdict and stays a prediction: there is no path
   * from here into `facts.record`, because a forecast that became a fact
   * by turning out roughly right is the contamination the split exists to
   * prevent.
   */
  async validate(link: LinkValidation): Promise<ValidationRow> {
    const row = await this.inferences.link({
      id: uuidv7(),
      inferenceId: link.inference,
      observation: link.observation,
      verdict: link.verdict,
      note: link.note,
      linkedAt: new Date().toISOString(),
      linkedBy: link.linkedBy,
      dataset: link.dataset,
    });

    await this.audit.record({
      action: 'record.write',
      outcome: 'allowed',
      dataset: link.dataset,
      reason: 'inference_validated',
      actor: link.linkedBy,
      records: [link.inference, link.observation],
      recordTypes: ['inference', 'validation'],
      detail: { verdict: link.verdict },
      correlationId: link.correlationId ?? null,
    });

    return row;
  }

  async validationsFor(
    inferenceIds: readonly string[],
    dataset: Dataset,
  ): Promise<Map<string, ValidationRow[]>> {
    return this.inferences.validationsFor(inferenceIds, dataset);
  }
}
