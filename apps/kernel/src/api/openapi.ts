import { z } from 'zod';

import { ConversionBasis } from '@clycites/schema';
import { CONSENT_CHANNELS, CONSENT_PURPOSES } from '../consent/consent.service.js';
import {
  OBJECTION_CHANNELS,
  WITHDRAWAL_CHANNELS,
} from '../consent/objection.service.js';
import { NOTICE_CHANNELS } from '../consent/retention-notice.repository.js';
import { ENTITY_SCHEMAS } from '../records/entity-registry.js';
import { SUBJECT_HEADER } from './subject.js';
import { DATASET_HEADER, LAWFUL_BASIS_HEADER } from './dataset.js';
import { DATASETS } from '../records/record.js';
import { LAWFUL_BASES } from '../records/lawful-basis.js';

/**
 * OpenAPI 3.1 generated from the Zod schemas. Brief §5 phase 4: generated, not
 * hand-written — a hand-written document drifts from the code the first time
 * anyone is in a hurry.
 *
 * One thing it cannot express: Zod refinements have no JSON Schema equivalent,
 * so cross-field rules (`on_behalf_of` requires `delegation`, `normalized_kg`
 * requires `conversion_id`, a record may not supersede itself) are absent from
 * the document even though the kernel enforces them. A generated client will
 * therefore let a caller build a record the kernel refuses. That is a limit of
 * JSON Schema, not a second validation layer to write; the refusal comes back
 * as a problem document listing the offending fields.
 */

export type JsonSchema = Record<string, unknown>;
export type OpenApiDocument = Record<string, unknown>;

const SCHEMA_KEYWORD = '$schema';

function pascal(type: string): string {
  return type
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function jsonSchema(schema: z.ZodType, io: 'input' | 'output'): JsonSchema {
  const generated = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io,
  }) as JsonSchema;
  delete generated[SCHEMA_KEYWORD];
  return generated;
}

/** Fields a caller may not set: the kernel assigns one and derives the other. */
const SERVER_OWNED = ['recorded_at', 'superseded_by'];

function submissionSchema(schema: z.ZodType): JsonSchema {
  const generated = jsonSchema(schema, 'input');
  const properties = generated['properties'] as Record<string, unknown>;
  const required = (generated['required'] as string[] | undefined) ?? [];

  for (const field of SERVER_OWNED) delete properties[field];
  generated['required'] = required.filter(
    (field) => !SERVER_OWNED.includes(field),
  );

  return generated;
}

function ref(name: string): JsonSchema {
  return { $ref: `#/components/schemas/${name}` };
}

const PROBLEM: JsonSchema = {
  type: 'object',
  description: 'RFC 9457 problem details.',
  required: ['type', 'title', 'status'],
  properties: {
    type: { type: 'string', format: 'uri-reference' },
    title: { type: 'string' },
    status: { type: 'integer' },
    detail: { type: 'string' },
    instance: { type: 'string', format: 'uri-reference' },
    code: { type: 'string' },
    correlation_id: { type: 'string' },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        required: ['path', 'message'],
        properties: {
          path: { type: 'string' },
          message: { type: 'string' },
        },
      },
    },
  },
};

function problemResponse(description: string): JsonSchema {
  return {
    description,
    content: { 'application/problem+json': { schema: ref('Problem') } },
  };
}

/**
 * The verified subject. Authentik establishes the claim; the kernel receives it
 * on this header and trusts the gateway. Every read is governed against it, so
 * exposing the kernel port directly would make every read forgeable.
 */
const subjectHeader: JsonSchema = {
  name: SUBJECT_HEADER,
  in: 'header',
  description:
    'The authenticated party, set by the gateway. Reads without it are refused.',
  schema: { type: 'string', format: 'uuid' },
};

const consentResponse: JsonSchema = problemResponse(
  'No lawful basis for this disclosure. Consent is not implemented yet, so only a subject reading their own records and the party that asserted a record are permitted.',
);

/**
 * The DPPA ground the write is made under. Mandatory, and mandatory per record
 * rather than per deployment, because s.7(3) resolves an objection by asking
 * what the record was collected under — see docs/decisions/0019-lawful-basis.md.
 */
const lawfulBasisHeader: JsonSchema = {
  name: LAWFUL_BASIS_HEADER,
  in: 'header',
  required: true,
  description:
    'The Data Protection and Privacy Act, 2019 ground this record is collected under. Financial records are s.9(1) special data and accept special_data_consent only.',
  schema: { type: 'string', enum: [...LAWFUL_BASES] },
};

/**
 * Present so that the seed generator is not a special case in the contract. It
 * is ignored unless SEED_INGEST_ENABLED, and it can only ever select `seed`.
 */
const datasetHeader: JsonSchema = {
  name: DATASET_HEADER,
  in: 'header',
  description:
    'Marks a write as fabricated. Ignored unless seed ingest is enabled; anything unrecognised reads as live.',
  schema: { type: 'string', enum: [...DATASETS] },
};

const writeHeaders: JsonSchema[] = [lawfulBasisHeader, datasetHeader];

const basisResponse: JsonSchema = problemResponse(
  'No delegation authorises this claim, or no lawful basis was stated for it. The record may be well formed; what is missing is our authority to hold it.',
);

export function buildOpenApiDocument(): OpenApiDocument {
  const types = Object.keys(ENTITY_SCHEMAS).sort();
  const schemas: Record<string, JsonSchema> = {};

  for (const type of types) {
    const entity = ENTITY_SCHEMAS[type as keyof typeof ENTITY_SCHEMAS];
    schemas[pascal(type)] = jsonSchema(entity, 'output');
    schemas[`${pascal(type)}Submission`] = submissionSchema(entity);
  }

  const discriminator = {
    propertyName: 'type',
    mapping: Object.fromEntries(
      types.map((type) => [type, `#/components/schemas/${pascal(type)}`]),
    ),
  };

  schemas['Record'] = {
    oneOf: types.map((type) => ref(pascal(type))),
    discriminator,
  };
  schemas['RecordSubmission'] = {
    oneOf: types.map((type) => ref(`${pascal(type)}Submission`)),
    discriminator: {
      propertyName: 'type',
      mapping: Object.fromEntries(
        types.map((type) => [
          type,
          `#/components/schemas/${pascal(type)}Submission`,
        ]),
      ),
    },
  };

  schemas['Custody'] = {
    type: 'object',
    required: [
      'custodian',
      'asserted',
      'as_of',
      'transfers',
      'forked',
      'broken',
    ],
    description:
      'How the kernel arrived at `record.custodian`. Present on lots only.',
    properties: {
      custodian: {
        type: 'string',
        format: 'uuid',
        description: 'Who holds the lot now, per the transfer chain.',
      },
      asserted: {
        type: 'string',
        format: 'uuid',
        description:
          'The custodian named when the lot was created. Kept so the derived answer never erases the claimed one.',
      },
      as_of: {
        type: ['string', 'null'],
        format: 'date-time',
        description: 'When the current holder took it. Null if nothing moved.',
      },
      transfers: { type: 'integer', minimum: 0 },
      forked: {
        type: 'boolean',
        description:
          'A transfer in the sequence was corrected two ways at once and was left out of the walk, so `custodian` is where the lot got to before the dispute and not necessarily where it is.',
      },
      broken: {
        type: 'boolean',
        description:
          'A transfer moved the lot from a party who was not holding it. Two simultaneous transfers present this way too. Surfaced, never resolved.',
      },
    },
  };

  schemas['SettlementSummary'] = {
    type: 'object',
    required: [
      'currency',
      'amount_minor',
      'references',
      'referenced_minor',
      'unreferenced_minor',
      'currency_mismatch',
      'forked',
      'incomplete',
      'disputed',
    ],
    description:
      'What settlement records say about **one** obligation. Present on obligations only. There is deliberately no equivalent keyed on a party: totalling what someone is owed across obligations produces a balance, and ClyCites holds no funds and is not a ledger of record for money.',
    properties: {
      currency: {
        type: 'string',
        description: "The obligation's currency. Only settlements in it count.",
      },
      amount_minor: { type: 'integer' },
      references: { type: 'integer', minimum: 0 },
      referenced_minor: {
        type: 'object',
        additionalProperties: { type: 'integer' },
        description:
          'Sums by `verification_status`, kept apart and never added together. An `asserted` settlement is one side’s claim; a `provider_verified` one is evidence from the rail, and the distinction is the whole value of the repayment signal.',
      },
      unreferenced_minor: {
        type: 'integer',
        description:
          'The obligation less every reference against it. Not a balance: the kernel does not know whether money moved, only whether a record exists claiming it did. Negative when over-referenced, and not clamped.',
      },
      currency_mismatch: {
        type: 'integer',
        minimum: 0,
        description:
          'Settlements denominated in some other currency. Counted, never converted — adding across currencies would invent an exchange rate.',
      },
      forked: {
        type: 'integer',
        minimum: 0,
        description:
          'Settlements corrected two ways at once. Counted, never summed — a fork has two tips and the kernel will not pick one.',
      },
      incomplete: {
        type: 'boolean',
        description:
          'A settlement was left out because it is forked, so `unreferenced_minor` is an upper bound.',
      },
      disputed: { type: 'boolean' },
    },
  };

  schemas['SubjectResolution'] = {
    type: 'object',
    required: [
      'ref',
      'declared_type',
      'exists',
      'actual_type',
      'type_matches',
      'retracted',
    ],
    description:
      'Whether an observation’s `subject_ref` names anything in the log. Present on observations only. Resolved on every read rather than settled at ingest, because an observation can arrive before its subject and later be about something perfectly real.',
    properties: {
      ref: { type: 'string', format: 'uuid' },
      declared_type: { type: 'string' },
      exists: { type: 'boolean' },
      actual_type: {
        type: ['string', 'null'],
        description: 'The record type actually found. Null if nothing was.',
      },
      type_matches: {
        type: ['boolean', 'null'],
        description:
          'Null while unknowable — the subject has not arrived, or the declared type names nothing the log can hold. False is permanent and also carries a `subject_type_mismatch` quality flag.',
      },
      retracted: {
        type: 'boolean',
        description:
          'The subject was retracted. Surfaced rather than hiding the observation, which remains someone’s account of what they saw.',
      },
    },
  };

  schemas['BalanceLeg'] = {
    type: 'object',
    required: [
      'transfer',
      'from_party',
      'to_party',
      'at',
      'expected_kg',
      'weighed_kg',
      'declared_loss_kg',
      'discrepancy_kg',
      'breached',
    ],
    description: 'One hand-over, and what the lot weighed when it happened.',
    properties: {
      transfer: { type: 'string', format: 'uuid' },
      from_party: { type: 'string', format: 'uuid' },
      to_party: { type: 'string', format: 'uuid' },
      at: { type: 'string', format: 'date-time' },
      expected_kg: {
        type: ['number', 'null'],
        description:
          'What it weighed at the previous hand-over, less losses declared since.',
      },
      weighed_kg: { type: ['number', 'null'] },
      declared_loss_kg: { type: 'number' },
      discrepancy_kg: {
        type: ['number', 'null'],
        description:
          'Positive means mass went missing. Negative means mass appeared, which is no less interesting.',
      },
      breached: { type: 'boolean' },
    },
  };

  schemas['Balance'] = {
    type: 'object',
    required: [
      'opening_kg',
      'closing_kg',
      'declared_loss_kg',
      'unexplained_kg',
      'tolerance',
      'breached',
      'incomplete',
      'legs',
    ],
    description:
      "Spec §9.1. Where the lot's mass went, reconciled across the custody sequence — every transfer re-weighs the lot, so the sequence is a series of independent measurements of the same produce. Present on lots only. A discrepancy is always stored and served, never a reason to refuse a record.",
    properties: {
      opening_kg: { type: ['number', 'null'] },
      closing_kg: { type: ['number', 'null'] },
      declared_loss_kg: {
        type: 'number',
        description:
          'Sum of `loss.declared` Observations against this lot. Losses are events with an author and a time, not fields on the lot.',
      },
      unexplained_kg: {
        type: ['number', 'null'],
        description: 'Shrinkage nobody accounted for.',
      },
      tolerance: {
        type: 'number',
        description:
          'The fraction of the opening weight in force when this was computed. Configurable; the default is a placeholder pending field validation.',
      },
      breached: {
        type: 'boolean',
        description:
          'The whole-lot ratio was exceeded, or any single leg was. A lot that loses 8% and gains it back nets to zero and is still not clean.',
      },
      incomplete: {
        type: 'boolean',
        description:
          'A weighing or a loss could not be read in kilograms, or one of them is under an unresolved correction, so the arithmetic is partial. A clean-looking balance on an incomplete ledger means nothing.',
      },
      legs: { type: 'array', items: ref('BalanceLeg') },
    },
  };

  schemas['Fulfilment'] = {
    type: 'object',
    required: [
      'deliveries',
      'confirmed',
      'unconvertible',
      'forked',
      'delivered_kg',
      'committed_kg',
      'outstanding_kg',
      'over_delivered',
      'incomplete',
    ],
    description:
      'What the deliveries pointing at this agreement add up to. Present on agreements only. Summed on every read — the agreement stores no counter, because a stored total is wrong the moment a delivery is corrected or retracted.',
    properties: {
      deliveries: {
        type: 'integer',
        minimum: 0,
        description:
          'Deliveries counted. Superseded and retracted ones are excluded.',
      },
      confirmed: {
        type: 'integer',
        minimum: 0,
        description:
          'Of those, how many the counterparty confirmed. Arrival and agreement are different facts.',
      },
      unconvertible: {
        type: 'integer',
        minimum: 0,
        description: 'Deliveries whose quantity never reached kilograms.',
      },
      forked: {
        type: 'integer',
        minimum: 0,
        description:
          'Deliveries under an unresolved correction. A fork has two tips, so neither branch is added to `delivered_kg` and neither is counted in `deliveries`.',
      },
      delivered_kg: { type: 'number' },
      committed_kg: {
        type: ['number', 'null'],
        description:
          'Null when the agreement itself was never normalized, in which case the shortfall is unknowable rather than zero.',
      },
      outstanding_kg: {
        type: ['number', 'null'],
        description:
          'Negative when more arrived than was committed. Not clamped: an over-delivery is a fact worth seeing.',
      },
      over_delivered: { type: 'boolean' },
      incomplete: {
        type: 'boolean',
        description:
          'At least one delivery is unconvertible or forked, so `delivered_kg` is a floor and not a total. Any percentage taken from it understates.',
      },
    },
  };

  schemas['Staleness'] = {
    type: 'object',
    required: [
      'stale',
      'reasons',
      'superseded_inputs',
      'retracted_inputs',
      'unresolved_inputs',
    ],
    description:
      'Spec §8 rule 5. Whether the records this inference was computed from have moved since. Present on inferences only. Derived on every read and never written into the body: the log is append-only, so a stored flag could only be corrected by a second record asserting the first is stale, and it would be wrong again the moment an input moved. A `stale` supplied on ingest is discarded.',
    properties: {
      stale: { type: 'boolean' },
      reasons: {
        type: 'array',
        items: { type: 'string', enum: ['input_superseded', 'input_retracted'] },
        description:
          'Both can apply at once. A superseded input means a newer value exists and the model can re-run. A retracted input means the input is gone and recomputation may be impossible — a different problem with a different answer.',
      },
      superseded_inputs: {
        type: 'array',
        items: { type: 'string', format: 'uuid' },
      },
      retracted_inputs: {
        type: 'array',
        items: { type: 'string', format: 'uuid' },
      },
      unresolved_inputs: {
        type: 'array',
        items: { type: 'string', format: 'uuid' },
        description:
          'Named as a dependency but not found. Not staleness — it is a statement that the check could not be made.',
      },
    },
  };

  schemas['RecordView'] = {
    type: 'object',
    required: ['record', 'quality_flags', 'superseded_by', 'retracted'],
    properties: {
      record: ref('Record'),
      quality_flags: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Kernel-derived labels. Never merged into the record itself, so the asserted body reads back byte for byte. The two exceptions are the fields the schema itself marks derived — `superseded_by` and, on a lot, `custodian` — which the kernel computes rather than serving a stale claim.',
      },
      superseded_by: {
        type: 'array',
        items: { type: 'string', format: 'uuid' },
        description:
          'Direct corrections of this record. More than one entry is a fork: two parties corrected the same record and the kernel will not choose between them.',
      },
      retracted: { type: 'boolean' },
      custody: ref('Custody'),
      balance: ref('Balance'),
      fulfilment: ref('Fulfilment'),
      subject: ref('SubjectResolution'),
      settlement: ref('SettlementSummary'),
      staleness: ref('Staleness'),
    },
  };

  schemas['Page'] = {
    type: 'object',
    required: ['records', 'next_cursor'],
    properties: {
      records: { type: 'array', items: ref('RecordView') },
      next_cursor: { type: ['string', 'null'] },
    },
  };

  schemas['Chain'] = {
    type: 'object',
    required: ['records'],
    properties: {
      records: {
        type: 'array',
        items: ref('RecordView'),
        description: 'Every version of the record, oldest first.',
      },
    },
  };

  schemas['Health'] = {
    type: 'object',
    required: ['status'],
    properties: {
      status: { type: 'string' },
      schema_version: { type: 'string' },
    },
  };

  schemas['Device'] = {
    type: 'object',
    required: ['device_id', 'registered_by', 'label', 'registered_at'],
    properties: {
      device_id: { type: 'string', format: 'uuid' },
      registered_by: { type: 'string', format: 'uuid' },
      label: { type: 'string' },
      registered_at: { type: 'string', format: 'date-time' },
    },
  };

  schemas['DeviceRegistration'] = {
    type: 'object',
    required: ['device_id', 'registered_by', 'label'],
    properties: {
      device_id: {
        type: 'string',
        format: 'uuid',
        description: 'Generated on the device. The kernel never issues one.',
      },
      registered_by: { type: 'string', format: 'uuid' },
      label: { type: 'string', minLength: 1, maxLength: 120 },
    },
  };

  schemas['DrainResult'] = {
    type: 'object',
    required: ['id', 'outcome'],
    properties: {
      id: { type: ['string', 'null'], format: 'uuid' },
      outcome: { type: 'string', enum: ['accepted', 'replayed', 'rejected'] },
      code: { type: 'string' },
      detail: { type: 'string' },
      issues: {
        type: 'array',
        items: {
          type: 'object',
          required: ['path', 'message'],
          properties: {
            path: { type: 'string' },
            message: { type: 'string' },
          },
        },
      },
    },
  };

  schemas['DrainReport'] = {
    type: 'object',
    required: ['results'],
    properties: {
      results: {
        type: 'array',
        items: ref('DrainResult'),
        description:
          'One entry per submitted record, in the order they were sent.',
      },
    },
  };

  schemas['Changes'] = {
    type: 'object',
    required: ['records', 'next_cursor', 'has_more'],
    properties: {
      records: { type: 'array', items: ref('RecordView') },
      next_cursor: { type: ['string', 'null'] },
      has_more: { type: 'boolean' },
    },
  };

  schemas['ConversionSample'] = {
    type: 'object',
    required: ['ordinal', 'weight_kg', 'condition'],
    description: 'One weighing. Present only where somebody actually weighed.',
    properties: {
      ordinal: { type: 'integer', minimum: 1 },
      weight_kg: { type: 'number', exclusiveMinimum: 0 },
      condition: {
        type: ['string', 'null'],
        description:
          'The state of that container, e.g. `damp,tight`. Per sample, because one damp bag among eleven dry ones is the observation that explains the spread.',
      },
    },
  };

  schemas['UnitConversion'] = {
    type: 'object',
    required: ['id', 'from_unit', 'to_unit', 'factor', 'basis'],
    description:
      'A factor, and the evidence for it. `basis` is the whole point: `measured` means somebody weighed a sample and the sample is below; `assumed_default` means the number is a convention nobody has checked. A quantity resting on the second is not wrong, it is unverified, and a lender is entitled to tell the difference without asking us.',
    properties: {
      id: { type: 'string', format: 'uuid' },
      from_unit: { type: 'string' },
      to_unit: { type: 'string' },
      factor: { type: 'number', exclusiveMinimum: 0 },
      commodity: { type: ['string', 'null'] },
      region_code: { type: ['string', 'null'] },
      region_vintage: {
        type: ['string', 'null'],
        description:
          'The boundary vintage the region code is read against. A district code without one is ambiguous across time.',
      },
      valid_from: { type: ['string', 'null'], format: 'date' },
      valid_to: { type: ['string', 'null'], format: 'date' },
      basis: { type: 'string', enum: [...ConversionBasis.options] },
      source: { type: ['string', 'null'] },
      supersedes: {
        type: ['string', 'null'],
        format: 'uuid',
        description:
          'The factor this one corrects. Rows are never edited, so a record citing the older id keeps the meaning it had when it was written.',
      },
      sample_size: { type: ['integer', 'null'], minimum: 1 },
      sample_min: { type: ['number', 'null'] },
      sample_max: { type: ['number', 'null'] },
      sample_stddev: { type: ['number', 'null'], minimum: 0 },
      condition: { type: ['string', 'null'] },
      local_label: {
        type: ['string', 'null'],
        description: 'What the container is called where it was weighed, e.g. `kaveera`.',
      },
      measured_by: { type: ['string', 'null'] },
      measured_at: { type: ['string', 'null'], format: 'date-time' },
      instrument: { type: ['string', 'null'] },
      sample: {
        type: 'array',
        items: ref('ConversionSample'),
        description: 'Returned on the single-conversion route only.',
      },
    },
  };

  schemas['ObservationTypeEntry'] = {
    type: 'object',
    required: ['code', 'version', 'label', 'value_kind', 'owner'],
    properties: {
      code: { type: 'string' },
      version: { type: 'integer', minimum: 1 },
      label: { type: 'string' },
      unit: { type: ['string', 'null'] },
      value_kind: { type: 'string' },
      permitted_methods: { type: 'array', items: { type: 'string' } },
      subject_types: { type: 'array', items: { type: 'string' } },
      owner: {
        type: 'string',
        description: 'The party accountable for the entry. An unowned vocabulary grows entries nobody can retire.',
      },
      source: { type: ['string', 'null'] },
    },
  };

  schemas['CropCodeEntry'] = {
    type: 'object',
    required: ['code', 'label'],
    properties: {
      code: { type: 'string' },
      label: { type: 'string' },
      parent_code: { type: ['string', 'null'] },
      external_scheme: { type: ['string', 'null'] },
      external_code: { type: ['string', 'null'] },
    },
  };

  schemas['AdminRegionEntry'] = {
    type: 'object',
    required: ['code', 'vintage', 'name', 'level'],
    properties: {
      code: { type: 'string' },
      vintage: { type: 'string' },
      name: { type: 'string' },
      level: { type: 'string' },
      parent_code: { type: ['string', 'null'] },
      parent_vintage: { type: ['string', 'null'] },
      source: { type: ['string', 'null'] },
    },
  };

  schemas['GradingSchemeEntry'] = {
    type: 'object',
    required: ['scheme', 'label', 'owner'],
    description:
      'Stored opaquely. `ordinal` orders values inside one scheme and carries no meaning across schemes: UNBS Grade 1 and a buyer’s Grade 1 are different claims and the kernel never ranks one against the other.',
    properties: {
      scheme: { type: 'string' },
      label: { type: 'string' },
      owner: { type: 'string' },
      source: { type: ['string', 'null'] },
      values: {
        type: 'array',
        description: 'Returned on the single-scheme route only.',
        items: {
          type: 'object',
          required: ['scheme', 'value'],
          properties: {
            scheme: { type: 'string' },
            value: { type: 'string' },
            label: { type: ['string', 'null'] },
            ordinal: { type: ['integer', 'null'] },
          },
        },
      },
    },
  };

  schemas['SeasonCalendarEntry'] = {
    type: 'object',
    required: ['region_code', 'region_vintage', 'label', 'starts_on', 'ends_on', 'basis', 'source'],
    description:
      'What a season label means in one region. Nearly empty on purpose: only what a citation supports is in the table, so a label with no row returns nothing rather than a plausible guess. `basis` distinguishes a published window from one somebody observed in a field. Open decision D5 — whose calendar wins when a cooperative disagrees with the national one — is not answered here.',
    properties: {
      region_code: { type: 'string' },
      region_vintage: { type: 'string' },
      label: { type: 'string' },
      starts_on: { type: 'string', format: 'date' },
      ends_on: { type: 'string', format: 'date' },
      basis: { type: 'string', enum: ['published', 'observed'] },
      source: { type: 'string' },
      note: { type: ['string', 'null'] },
    },
  };

  schemas['PartyLink'] = {
    type: 'object',
    required: [
      'id',
      'relation',
      'left_party',
      'right_party',
      'asserted_by',
      'confidence',
      'evidence',
    ],
    description:
      'An assertion that two party ids are the same person. Reversible: a link is withdrawn by retraction, and no record is ever rewritten. Confidence is never a boolean because matching is never a boolean.',
    properties: {
      id: { type: 'string', format: 'uuid' },
      relation: { type: 'string', enum: ['same_as'] },
      left_party: { type: 'string', format: 'uuid' },
      right_party: { type: 'string', format: 'uuid' },
      asserted_by: { type: 'string', format: 'uuid' },
      asserted_at: { type: 'string', format: 'date-time' },
      confidence: { type: 'number', exclusiveMinimum: 0, maximum: 1 },
      evidence: {
        type: 'string',
        enum: [
          'national_id_match',
          'phone_match',
          'name_and_region_match',
          'declared_by_subject',
          'declared_by_organisation',
          'assumed',
        ],
        description:
          'The weakest three are named explicitly so a consumer can refuse to act on them.',
      },
      evidence_note: { type: ['string', 'null'] },
      lawful_basis: { type: 'string' },
      retracted_at: { type: ['string', 'null'], format: 'date-time' },
      retracted_by: { type: ['string', 'null'], format: 'uuid' },
      retraction_reason: { type: ['string', 'null'] },
    },
  };

  schemas['ConsentGrant'] = {
    type: 'object',
    required: [
      'id',
      'subject',
      'grantee',
      'purpose',
      'record_types',
      'granted_at',
      'granted_via',
    ],
    description:
      'One subject permitting one grantee to use records of named types for one named purpose. Purpose-bound and never widened. Withdrawal fills `revoked_at` from a separate row; the grant itself is never edited, because a consent record that could be edited is not evidence of anything.',
    properties: {
      id: { type: 'string', format: 'uuid' },
      subject: { type: 'string', format: 'uuid' },
      grantee: { type: 'string', format: 'uuid' },
      purpose: { type: 'string', enum: [...CONSENT_PURPOSES] },
      record_types: {
        type: 'array',
        items: { type: 'string' },
        description:
          'A grant over deliveries is not a grant over harvests. There is no wildcard.',
      },
      granted_at: { type: 'string', format: 'date-time' },
      expires_at: { type: ['string', 'null'], format: 'date-time' },
      granted_via: {
        type: 'string',
        enum: [...CONSENT_CHANNELS],
        description:
          'How the subject actually said yes. A grant nobody can evidence is not one.',
      },
      evidence: { type: 'array', items: {} },
      dataset: { type: 'string', enum: [...DATASETS] },
      revoked_at: {
        type: ['string', 'null'],
        format: 'date-time',
        description:
          'Resolved at request time, not at grant time: a grant withdrawn before the read does not authorise it.',
      },
    },
  };

  schemas['Objection'] = {
    type: 'object',
    required: ['id', 'subject', 'lodged_at', 'lodged_via', 'lodged_by'],
    description:
      'An objection to processing under s.7(3). Not the same thing as withdrawing a grant: withdrawal names one grantee and one purpose, an objection is against the processing itself and stops it only where the record’s lawful basis is not one of the s.7(2) grounds.',
    properties: {
      id: { type: 'string', format: 'uuid' },
      subject: { type: 'string', format: 'uuid' },
      scope: {
        type: ['array', 'null'],
        items: { type: 'string' },
        description:
          'Record types covered, or null for all of them. A farmer objecting to observations about their plot has not objected to the delivery receipts they need for a loan.',
      },
      lodged_at: { type: 'string', format: 'date-time' },
      lodged_via: { type: 'string', enum: [...OBJECTION_CHANNELS] },
      lodged_by: {
        type: 'string',
        format: 'uuid',
        description:
          'Not always the subject. An officer may lodge under delegation, because a farmer with no smartphone must still be able to object.',
      },
      delegation: { type: ['string', 'null'], format: 'uuid' },
      evidence: { type: 'array', items: {} },
      dataset: { type: 'string', enum: [...DATASETS] },
      withdrawn_at: { type: ['string', 'null'], format: 'date-time' },
    },
  };

  schemas['RetentionNotice'] = {
    type: 'object',
    required: [
      'id',
      'party',
      'notice_text',
      'period_stated',
      'lawful_basis',
      'purposes',
      'language',
      'given_via',
      'given_at',
    ],
    description:
      'The notice given to a subject at enrolment, DPPA s.13(1)(i), recorded as it was given. A farmer enrolled in March was told something; a policy changed in June does not become what they were told.',
    properties: {
      id: { type: 'string', format: 'uuid' },
      party: { type: 'string', format: 'uuid' },
      notice_text: {
        type: 'string',
        description:
          'The notice in full, not a template id. A template can be edited afterwards, which would make the notice unprovable.',
      },
      period_stated: {
        type: 'string',
        description:
          'What the subject was told about how long, in the words used. Free text on purpose: “until three years after your last delivery” is a real answer and is not a duration. A machine-readable period would invite a job to act on it, and the lawful period is unresolved.',
      },
      lawful_basis: { type: 'string', enum: [...LAWFUL_BASES] },
      purposes: { type: 'array', items: { type: 'string' } },
      language: {
        type: 'string',
        description:
          'A notice in a language the subject does not read does not inform them, so the claim is recorded and can be checked.',
      },
      given_via: { type: 'string', enum: [...NOTICE_CHANNELS] },
      given_by: {
        type: ['string', 'null'],
        format: 'uuid',
        description: 'The verified caller who gave it, never a body field.',
      },
      given_at: { type: 'string', format: 'date-time' },
      dataset: { type: 'string', enum: [...DATASETS] },
    },
  };

  schemas['RetentionNoticeSubmission'] = {
    type: 'object',
    required: [
      'party',
      'notice_text',
      'period_stated',
      'lawful_basis',
      'purposes',
      'language',
      'given_via',
      'given_at',
    ],
    properties: {
      party: { type: 'string', format: 'uuid' },
      notice_text: { type: 'string', minLength: 1, maxLength: 20_000 },
      period_stated: { type: 'string', minLength: 1, maxLength: 1_000 },
      lawful_basis: { type: 'string', enum: [...LAWFUL_BASES] },
      purposes: {
        type: 'array',
        items: { type: 'string', minLength: 1 },
        minItems: 1,
        maxItems: 16,
      },
      language: { type: 'string', minLength: 2, maxLength: 64 },
      given_via: { type: 'string', enum: [...NOTICE_CHANNELS] },
      given_at: { type: 'string', format: 'date-time' },
    },
  };

  schemas['ObjectionOutcome'] = {
    type: 'object',
    required: ['objection', 'stopped', 'continuing', 'notice'],
    description:
      'Both sets, enumerated. Never a boolean: a subject told “done” while a cooperative carries on under contract_performance has been misled, which is worse than a refusal.',
    properties: {
      objection: ref('Objection'),
      stopped: { type: 'array', items: ref('BasisOutcome') },
      continuing: { type: 'array', items: ref('BasisOutcome') },
      notice: {
        type: 'array',
        items: { type: 'string' },
        description:
          'What an objection does not do. Erasure, notifying prior recipients, and the audit log are all outside it, as is another party’s own record of a transaction it was part of.',
      },
    },
  };

  schemas['BasisOutcome'] = {
    type: 'object',
    required: ['record_type', 'lawful_basis', 'records'],
    properties: {
      record_type: { type: 'string' },
      lawful_basis: { type: 'string' },
      records: { type: 'integer' },
      ground: {
        type: 'string',
        description: 'Present only where processing continues. Why it continues.',
      },
    },
  };

  schemas['SubjectAccessResponse'] = {
    type: 'object',
    required: ['subject', 'dataset', 'prepared_at', 'due_by', 'held', 'records', 'disclosures', 'consents', 'objections', 'truncated', 'notice'],
    description:
      'Everything held about one subject, assembled for them under s.24. Not a record read: the consent guard answers whether one party may see another’s record, and a subject asking for their own data is not that question.',
    properties: {
      subject: { type: 'string', format: 'uuid' },
      dataset: { type: 'string', enum: [...DATASETS] },
      prepared_at: { type: 'string', format: 'date-time' },
      due_by: {
        type: 'string',
        format: 'date-time',
        description:
          's.24(9) gives thirty days. Carried here so the deadline is the subject’s to hold us to rather than ours to remember.',
      },
      held: {
        type: 'boolean',
        description: 's.24(1)(a). False is an answer, not a refusal.',
      },
      records: { type: 'array', items: ref('SubjectAccessRecord') },
      disclosures: {
        type: 'array',
        items: ref('Disclosure'),
        description:
          's.24(1)(c). Third parties only: the subject’s own reads are not disclosures, and a refused request disclosed nothing.',
      },
      consents: { type: 'array', items: ref('ConsentGrant') },
      objections: { type: 'array', items: ref('Objection') },
      truncated: {
        type: 'boolean',
        description:
          'True when the answer hit its cap and is incomplete. Reported rather than paginated: a response that silently stops at a page boundary is worse than a slow one.',
      },
      notice: { type: 'array', items: { type: 'string' } },
    },
  };

  schemas['SubjectAccessRecord'] = {
    type: 'object',
    required: ['id', 'type', 'occurred_at', 'recorded_at', 'lawful_basis', 'retracted', 'superseded_by', 'document', 'redacted'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      type: { type: 'string' },
      occurred_at: { type: 'string', format: 'date-time' },
      recorded_at: { type: 'string', format: 'date-time' },
      lawful_basis: {
        type: 'string',
        description:
          'The ground it was collected on. Whether an objection can stop it turns on this.',
      },
      retracted: {
        type: 'boolean',
        description:
          'A retracted record is still held, so it is still answered for. What a subject asks for is not what a buyer would be shown.',
      },
      superseded_by: { type: 'array', items: { type: 'string', format: 'uuid' } },
      document: { type: 'object', description: 'The record, after redaction.' },
      redacted: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Fields blanked under s.24(4). Named rather than silently removed, so the subject knows what to ask about.',
      },
    },
  };

  schemas['Disclosure'] = {
    type: 'object',
    required: ['occurred_at', 'actor', 'purpose', 'access', 'record_types', 'records'],
    properties: {
      occurred_at: { type: 'string', format: 'date-time' },
      actor: { type: ['string', 'null'], format: 'uuid' },
      purpose: { type: ['string', 'null'] },
      access: {
        type: ['string', 'null'],
        description:
          'Which permission was leaned on. Whether somebody read a record on a grant the subject gave or on a membership they never agreed to is the part a subject would act on.',
      },
      record_types: { type: 'array', items: { type: 'string' } },
      records: { type: 'array', items: { type: 'string', format: 'uuid' } },
    },
  };

  schemas['PartyLinkResolution'] = {
    type: 'object',
    required: ['identities', 'links', 'collapsed'],
    description:
      'Everything reachable from a party, and the links that got you there. There is no canonical id and no route that will give you one: merging is not reversible, and a consumer asking for a farmer’s deliveries gets a set plus the links so it can decide for itself. Open decision D2 is deferred, not answered.',
    properties: {
      identities: {
        type: 'array',
        items: { type: 'string', format: 'uuid' },
        description: 'The party asked about first, then everything linked to it.',
      },
      links: { type: 'array', items: ref('PartyLink') },
      collapsed: {
        const: false,
        description:
          'Always false. Present so that no consumer mistakes this for a merged identity.',
      },
    },
  };

  schemas['Problem'] = PROBLEM;

  return {
    openapi: '3.1.0',
    info: {
      title: 'ClyCites Kernel',
      version: '0.1.0',
      summary: 'The append-only record layer.',
      description:
        'Every application reaches the kernel through this contract and never past it. Records are appended, never changed: a correction is a new record that supersedes the one before it, and a retraction hides a record from default reads without removing it.',
    },
    servers: [{ url: '/v1' }],
    tags: [
      { name: 'records', description: 'The fact log.' },
      { name: 'inference', description: 'Derived records, kept apart.' },
      { name: 'sync', description: 'Offline devices push and pull.' },
      {
        name: 'registry',
        description:
          'Reference data. Unauthenticated on purpose: a weight you need our permission to verify is a weight you are trusting us for. Immutable, so cache it.',
      },
      {
        name: 'identity',
        description:
          'Links between party ids. Assertions, never merges: a wrong link is withdrawn, a wrong merge is archaeology.',
      },
      {
        name: 'consent',
        description:
          'Grants, and their withdrawal. Written by the subject and read by the subject; nothing here is a grantee’s to manage. Objections live here too, and are a different right: a grant is withdrawn one grantee at a time, an objection is against the processing itself.',
      },
      { name: 'operations', description: 'Liveness and readiness.' },
    ],
    paths: {
      '/records': {
        post: {
          tags: ['records'],
          operationId: 'submitRecord',
          summary: 'Append a record',
          description:
            'Idempotent on the client-generated id: resubmitting an identical record returns 200 and writes nothing. Reusing an id for different contents is a conflict.',
          parameters: writeHeaders,
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: ref('RecordSubmission') },
            },
          },
          responses: {
            '201': {
              description: 'Appended.',
              headers: {
                Location: { schema: { type: 'string' }, required: true },
              },
              content: { 'application/json': { schema: ref('RecordView') } },
            },
            '200': {
              description: 'Already in the log; nothing was written.',
              content: { 'application/json': { schema: ref('RecordView') } },
            },
            '403': basisResponse,
            '409': problemResponse('That id belongs to a different record.'),
            '422': problemResponse('The record is not one the schema allows.'),
          },
        },
        get: {
          tags: ['records'],
          operationId: 'listRecords',
          summary: 'List current records',
          description:
            'Superseded and retracted records are absent. Both remain addressable by id.',
          parameters: [
            {
              name: 'type',
              in: 'query',
              schema: { type: 'string', enum: types },
            },
            {
              name: 'asserted_by',
              in: 'query',
              schema: { type: 'string', format: 'uuid' },
            },
            {
              name: 'subject',
              in: 'query',
              description:
                'A party or entity the record is about — either side of a delivery, either side of a delegation.',
              schema: { type: 'string', format: 'uuid' },
            },
            {
              name: 'purpose',
              in: 'query',
              description:
                'The lawful basis for the read, under the Data Protection and Privacy Act, 2019. Purpose-bound consent is not implemented yet, so naming a purpose is refused.',
              schema: { type: 'string', enum: [...CONSENT_PURPOSES] },
            },
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
            },
            { name: 'cursor', in: 'query', schema: { type: 'string' } },
            subjectHeader,
          ],
          responses: {
            '200': {
              description: 'A page of records.',
              content: { 'application/json': { schema: ref('Page') } },
            },
            '400': problemResponse('The cursor is not one we issued.'),
            '403': consentResponse,
            '422': problemResponse('No such record type.'),
          },
        },
      },
      '/records/{id}': {
        get: {
          tags: ['records'],
          operationId: 'getRecord',
          summary: 'Fetch a record by id',
          description:
            'Returns superseded and retracted records too, labelled as such.',
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
            subjectHeader,
          ],
          responses: {
            '200': {
              description: 'The record.',
              content: { 'application/json': { schema: ref('RecordView') } },
            },
            '403': consentResponse,
            '404': problemResponse('Not in the log.'),
          },
        },
      },
      '/records/{id}/chain': {
        get: {
          tags: ['records'],
          operationId: 'getRecordChain',
          summary: 'Walk the supersession chain',
          description:
            'Every version of the record, oldest first, from any point in the chain.',
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
            subjectHeader,
          ],
          responses: {
            '200': {
              description: 'The chain.',
              content: { 'application/json': { schema: ref('Chain') } },
            },
            '403': consentResponse,
            '404': problemResponse('Not in the log.'),
          },
        },
      },
      '/inferences/{id}': {
        get: {
          tags: ['inference'],
          operationId: 'getInference',
          summary: 'Fetch an inference by id',
          description:
            'Inferences live in their own namespace and never appear in a record read. Asking for one is deliberate.',
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
            subjectHeader,
          ],
          responses: {
            '200': {
              description: 'The inference.',
              content: { 'application/json': { schema: ref('RecordView') } },
            },
            '403': consentResponse,
            '404': problemResponse('Not in the inference log.'),
          },
        },
      },
      '/devices': {
        post: {
          tags: ['sync'],
          operationId: 'registerDevice',
          summary: 'Register a device',
          description:
            'Idempotent. Re-registering the same device to the same party returns 200; claiming a device id already held by another party is a conflict.',
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: ref('DeviceRegistration') },
            },
          },
          responses: {
            '201': {
              description: 'Registered.',
              content: { 'application/json': { schema: ref('Device') } },
            },
            '200': {
              description: 'Already registered to this party.',
              content: { 'application/json': { schema: ref('Device') } },
            },
            '409': problemResponse('That device belongs to another party.'),
            '422': problemResponse('The registration is not well formed.'),
          },
        },
      },
      '/sync/outbox': {
        post: {
          tags: ['sync'],
          operationId: 'drainOutbox',
          summary: 'Append a batch captured offline',
          description:
            'Every record is processed independently, so one bad record does not strand the rest of a device\u2019s outbox. The response is always 200 when the batch itself was well formed; per-record outcomes are in the body. Replaying a batch is safe.',
          parameters: writeHeaders,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'array',
                  items: ref('RecordSubmission'),
                  maxItems: 500,
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'The batch was received. See each result.',
              content: { 'application/json': { schema: ref('DrainReport') } },
            },
            '422': problemResponse('The batch itself is not well formed.'),
          },
        },
      },
      '/sync/changes': {
        get: {
          tags: ['sync'],
          operationId: 'pullChanges',
          summary: 'Pull everything appended since a cursor',
          description:
            'The replication feed, oldest first, scoped to the records the requesting party asserted. Unlike a default read it includes superseded and retracted records, because a device holding a partial copy of the log has to be able to resolve a chain without asking. The cursor is held by the device; the kernel keeps no per-device position.',
          parameters: [
            {
              name: 'cursor',
              in: 'query',
              description: 'Omit to start from the beginning of the log.',
              schema: { type: 'string' },
            },
            {
              name: 'limit',
              in: 'query',
              schema: {
                type: 'integer',
                minimum: 1,
                maximum: 500,
                default: 100,
              },
            },
            subjectHeader,
          ],
          responses: {
            '200': {
              description: 'A page of changes.',
              content: { 'application/json': { schema: ref('Changes') } },
            },
            '400': problemResponse('The cursor is not one we issued.'),
            '403': consentResponse,
          },
        },
      },
      '/registry/conversions': {
        get: {
          tags: ['registry'],
          operationId: 'listConversions',
          summary: 'Find conversion factors',
          description:
            'Newest first. No subject header: reference data has no data subject, and requiring a credential to check a weight would make verification depend on our permission.',
          parameters: [
            { name: 'from_unit', in: 'query', schema: { type: 'string' } },
            { name: 'to_unit', in: 'query', schema: { type: 'string' } },
            { name: 'commodity', in: 'query', schema: { type: 'string' } },
            { name: 'region_code', in: 'query', schema: { type: 'string' } },
            {
              name: 'basis',
              in: 'query',
              schema: { type: 'string', enum: [...ConversionBasis.options] },
            },
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
            },
          ],
          responses: {
            '200': {
              description: 'Matching factors, without their sample rows.',
              headers: {
                'Cache-Control': { schema: { type: 'string' } },
                'RateLimit-Remaining': { schema: { type: 'string' } },
              },
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['conversions'],
                    properties: {
                      conversions: {
                        type: 'array',
                        items: ref('UnitConversion'),
                      },
                    },
                  },
                },
              },
            },
            '400': problemResponse('A filter is not a shape we accept.'),
            '429': problemResponse(
              'Too many requests from one address. The rows are immutable — cache them rather than polling.',
            ),
          },
        },
      },
      '/registry/conversions/{id}': {
        get: {
          tags: ['registry'],
          operationId: 'getConversion',
          summary: 'Fetch one factor and the weighings behind it',
          description:
            'The route a lender uses to check a quantity. A delivery states `raw_value`, `raw_unit` and `normalized_kg` and cites a `conversion_id`; this resolves that id to a factor, a basis, and — where the basis is `measured` — the individual weights, who took them, when, and on what instrument.',
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
          ],
          responses: {
            '200': {
              description: 'The factor, with its sample.',
              content: {
                'application/json': { schema: ref('UnitConversion') },
              },
            },
            '404': problemResponse('No such factor.'),
            '429': problemResponse('Too many requests from one address.'),
          },
        },
      },
      '/registry/observation-types': {
        get: {
          tags: ['registry'],
          operationId: 'listObservationTypes',
          summary: 'The observation vocabulary',
          parameters: [
            { name: 'subject_type', in: 'query', schema: { type: 'string' } },
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
            },
          ],
          responses: {
            '200': {
              description: 'Registered types, newest version of each first.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['observation_types'],
                    properties: {
                      observation_types: {
                        type: 'array',
                        items: ref('ObservationTypeEntry'),
                      },
                    },
                  },
                },
              },
            },
            '400': problemResponse('A filter is not a shape we accept.'),
            '429': problemResponse('Too many requests from one address.'),
          },
        },
      },
      '/registry/observation-types/{code}': {
        get: {
          tags: ['registry'],
          operationId: 'getObservationType',
          summary: 'One observation type, current version',
          parameters: [
            {
              name: 'code',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
          ],
          responses: {
            '200': {
              description: 'The type.',
              content: {
                'application/json': { schema: ref('ObservationTypeEntry') },
              },
            },
            '404': problemResponse('Not registered.'),
            '429': problemResponse('Too many requests from one address.'),
          },
        },
      },
      '/registry/crop-codes': {
        get: {
          tags: ['registry'],
          operationId: 'listCropCodes',
          summary: 'The crop vocabulary',
          description:
            'An indirection layer, not a taxonomy. Open decision D1 has not chosen an underlying standard; `external_scheme` and `external_code` are where the mapping will land when it does.',
          parameters: [
            { name: 'parent_code', in: 'query', schema: { type: 'string' } },
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
            },
          ],
          responses: {
            '200': {
              description: 'Crop codes.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['crop_codes'],
                    properties: {
                      crop_codes: {
                        type: 'array',
                        items: ref('CropCodeEntry'),
                      },
                    },
                  },
                },
              },
            },
            '400': problemResponse('A filter is not a shape we accept.'),
            '429': problemResponse('Too many requests from one address.'),
          },
        },
      },
      '/registry/crop-codes/{code}': {
        get: {
          tags: ['registry'],
          operationId: 'getCropCode',
          summary: 'One crop code',
          parameters: [
            {
              name: 'code',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
          ],
          responses: {
            '200': {
              description: 'The code.',
              content: { 'application/json': { schema: ref('CropCodeEntry') } },
            },
            '404': problemResponse('Not registered.'),
            '429': problemResponse('Too many requests from one address.'),
          },
        },
      },
      '/registry/admin-regions': {
        get: {
          tags: ['registry'],
          operationId: 'listAdminRegions',
          summary: 'Administrative boundaries, by vintage',
          parameters: [
            { name: 'vintage', in: 'query', schema: { type: 'string' } },
            { name: 'level', in: 'query', schema: { type: 'string' } },
            { name: 'parent_code', in: 'query', schema: { type: 'string' } },
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
            },
          ],
          responses: {
            '200': {
              description: 'Regions.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['admin_regions'],
                    properties: {
                      admin_regions: {
                        type: 'array',
                        items: ref('AdminRegionEntry'),
                      },
                    },
                  },
                },
              },
            },
            '400': problemResponse('A filter is not a shape we accept.'),
            '429': problemResponse('Too many requests from one address.'),
          },
        },
      },
      '/registry/admin-regions/{code}/{vintage}': {
        get: {
          tags: ['registry'],
          operationId: 'getAdminRegion',
          summary: 'One region at one boundary vintage',
          description:
            'Both parts are required. Uganda’s districts have subdivided repeatedly, so a bare district code is ambiguous across time and there is deliberately no route that accepts one.',
          parameters: [
            {
              name: 'code',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
            {
              name: 'vintage',
              in: 'path',
              required: true,
              schema: { type: 'string', pattern: '^\\d{4}$' },
            },
          ],
          responses: {
            '200': {
              description: 'The region.',
              content: {
                'application/json': { schema: ref('AdminRegionEntry') },
              },
            },
            '404': problemResponse('No such region at that vintage.'),
            '429': problemResponse('Too many requests from one address.'),
          },
        },
      },
      '/registry/grading-schemes': {
        get: {
          tags: ['registry'],
          operationId: 'listGradingSchemes',
          summary: 'Grading vocabularies',
          parameters: [
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
            },
          ],
          responses: {
            '200': {
              description: 'Schemes, without their values.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['grading_schemes'],
                    properties: {
                      grading_schemes: {
                        type: 'array',
                        items: ref('GradingSchemeEntry'),
                      },
                    },
                  },
                },
              },
            },
            '400': problemResponse('A filter is not a shape we accept.'),
            '429': problemResponse('Too many requests from one address.'),
          },
        },
      },
      '/registry/grading-schemes/{scheme}': {
        get: {
          tags: ['registry'],
          operationId: 'getGradingScheme',
          summary: 'One scheme and its permitted values',
          parameters: [
            {
              name: 'scheme',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
          ],
          responses: {
            '200': {
              description: 'The scheme, with its values.',
              content: {
                'application/json': { schema: ref('GradingSchemeEntry') },
              },
            },
            '404': problemResponse('Not registered.'),
            '429': problemResponse('Too many requests from one address.'),
          },
        },
      },
      '/registry/seasons': {
        get: {
          tags: ['registry'],
          operationId: 'listSeasons',
          summary: 'What a season label means, where it is known',
          description:
            'Nearly empty on purpose. Only windows a published source states are in the table; a label with no row returns nothing rather than a plausible guess.',
          parameters: [
            { name: 'label', in: 'query', schema: { type: 'string' } },
            { name: 'region_code', in: 'query', schema: { type: 'string' } },
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
            },
          ],
          responses: {
            '200': {
              description: 'Season windows, most recent label first.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['seasons'],
                    properties: {
                      seasons: {
                        type: 'array',
                        items: ref('SeasonCalendarEntry'),
                      },
                    },
                  },
                },
              },
            },
            '400': problemResponse('A filter is not a shape we accept.'),
            '429': problemResponse('Too many requests from one address.'),
          },
        },
      },
      '/registry/seasons/{label}/{code}/{vintage}': {
        get: {
          tags: ['registry'],
          operationId: 'getSeason',
          summary: 'One season window for one region',
          description:
            'Most specific region wins: a district row beats the national one. No match is a 404, not a fallback.',
          parameters: [
            { name: 'label', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'code', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'vintage', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': {
              description: 'The window, with its citation.',
              content: {
                'application/json': { schema: ref('SeasonCalendarEntry') },
              },
            },
            '404': problemResponse('No calendar for that season in that region.'),
            '429': problemResponse('Too many requests from one address.'),
          },
        },
      },
      '/parties/{id}/links': {
        get: {
          tags: ['identity'],
          operationId: 'resolvePartyLinks',
          summary: 'Identities linked to this party',
          description:
            'Resolved transitively, capped at eight hops, and never collapsed. A longer chain is a matcher that has joined two unrelated clusters, not a person with many aliases.',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'purpose', in: 'query', schema: { type: 'string' } },
          ],
          responses: {
            '200': {
              description: 'The set and its links.',
              content: {
                'application/json': { schema: ref('PartyLinkResolution') },
              },
            },
            '403': problemResponse('Consent did not permit the disclosure.'),
          },
        },
      },
      '/parties/links': {
        post: {
          tags: ['identity'],
          operationId: 'assertPartyLink',
          summary: 'Assert that two parties are the same person',
          description:
            'The asserter is the verified subject, never a body field: a caller who can name who asserted a link can attribute their guess to somebody else.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['left_party', 'right_party', 'confidence', 'evidence', 'lawful_basis'],
                  properties: {
                    left_party: { type: 'string', format: 'uuid' },
                    right_party: { type: 'string', format: 'uuid' },
                    confidence: { type: 'number', exclusiveMinimum: 0, maximum: 1 },
                    evidence: { type: 'string' },
                    evidence_note: { type: ['string', 'null'] },
                    lawful_basis: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: {
            '201': {
              description: 'Linked.',
              content: { 'application/json': { schema: ref('PartyLink') } },
            },
            '400': problemResponse('The assertion is not a shape we accept.'),
            '403': problemResponse('Consent did not permit the assertion.'),
          },
        },
      },
      '/parties/links/{id}': {
        delete: {
          tags: ['identity'],
          operationId: 'retractPartyLink',
          summary: 'Withdraw a link',
          description:
            'Nothing is deleted. The row keeps who withdrew the link and why, which is what makes linking recoverable where merging is not.',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['reason'],
                  properties: { reason: { type: 'string', maxLength: 500 } },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Retracted.',
              content: { 'application/json': { schema: ref('PartyLink') } },
            },
            '404': problemResponse('No live link with that id.'),
          },
        },
      },
      '/consent/grants': {
        get: {
          tags: ['consent'],
          operationId: 'listOwnGrants',
          summary: 'What this subject has permitted',
          description:
            'Scoped to the verified subject and never widenable. A grant is personal data about the person who gave it, so this is part of their subject-access answer — and a grantee able to list a subject’s grants could enumerate everybody else that subject deals with.',
          responses: {
            '200': {
              description: 'The subject’s own grants, withdrawn ones included.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['grants'],
                    properties: {
                      grants: { type: 'array', items: ref('ConsentGrant') },
                    },
                  },
                },
              },
            },
            '403': problemResponse('No verified subject.'),
          },
        },
        post: {
          tags: ['consent'],
          operationId: 'grantConsent',
          summary: 'Give consent',
          description:
            'The subject is the verified subject, never a body field. Purpose-bound: a grant for credit assessment is not a grant for market intelligence, and the kernel never widens one to cover another.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['grantee', 'purpose', 'record_types', 'granted_via'],
                  properties: {
                    grantee: { type: 'string', format: 'uuid' },
                    purpose: { type: 'string', enum: [...CONSENT_PURPOSES] },
                    record_types: {
                      type: 'array',
                      items: { type: 'string' },
                      minItems: 1,
                    },
                    expires_at: { type: ['string', 'null'], format: 'date-time' },
                    granted_via: { type: 'string', enum: [...CONSENT_CHANNELS] },
                    evidence: { type: 'array', items: {} },
                  },
                },
              },
            },
          },
          responses: {
            '201': {
              description: 'Granted.',
              content: { 'application/json': { schema: ref('ConsentGrant') } },
            },
            '400': problemResponse('The grant is not a shape we accept.'),
            '403': problemResponse('No verified subject.'),
          },
        },
      },
      '/consent/grants/{id}': {
        delete: {
          tags: ['consent'],
          operationId: 'revokeConsent',
          summary: 'Withdraw consent',
          description:
            'Nothing is deleted and nothing is updated. A withdrawal is a new row beside the grant, so a subject who withdraws in August can still show they had consented in July.',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          responses: {
            '200': {
              description: 'Withdrawn.',
              content: { 'application/json': { schema: ref('ConsentGrant') } },
            },
            '403': problemResponse('No verified subject.'),
            '404': problemResponse('No grant of yours with that id.'),
          },
        },
      },
      '/objections': {
        get: {
          tags: ['consent'],
          operationId: 'listOwnObjections',
          summary: 'What this subject has objected to',
          responses: {
            '200': {
              description: 'The subject’s own objections, withdrawn ones included.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['objections'],
                    properties: {
                      objections: { type: 'array', items: ref('Objection') },
                    },
                  },
                },
              },
            },
            '403': problemResponse('No verified subject.'),
          },
        },
        post: {
          tags: ['consent'],
          operationId: 'lodgeObjection',
          summary: 'Object to processing',
          description:
            'May be lodged for another party under a delegation — `on_behalf_of` with `delegation` — because a farmer with no smartphone must still be able to object. The response enumerates what stopped and what continues, with the ground named for each.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['lodged_via'],
                  properties: {
                    on_behalf_of: { type: 'string', format: 'uuid' },
                    delegation: { type: 'string', format: 'uuid' },
                    scope: {
                      type: ['array', 'null'],
                      items: { type: 'string' },
                      minItems: 1,
                    },
                    lodged_via: { type: 'string', enum: [...OBJECTION_CHANNELS] },
                    evidence: { type: 'array', items: {} },
                  },
                },
              },
            },
          },
          responses: {
            '201': {
              description: 'Lodged, with both sets enumerated.',
              content: {
                'application/json': { schema: ref('ObjectionOutcome') },
              },
            },
            '400': problemResponse(
              'Lodging for another party without naming the delegation it rests on.',
            ),
            '403': problemResponse('No verified subject.'),
          },
        },
      },
      '/objections/{id}': {
        delete: {
          tags: ['consent'],
          operationId: 'withdrawObjection',
          summary: 'Re-consent',
          description:
            'The subject only, and never under a delegation. Lodging an objection protects the subject and may be delegated; withdrawing one removes the protection, and the party best placed to want it removed is the one whose access it restricts. `ussd_confirmation` is not accepted here for the same reason.',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['withdrawn_via'],
                  properties: {
                    withdrawn_via: { type: 'string', enum: [...WITHDRAWAL_CHANNELS] },
                    reason: { type: ['string', 'null'] },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Withdrawn.',
              content: { 'application/json': { schema: ref('Objection') } },
            },
            '400': problemResponse('Evidence too weak to remove a protection.'),
            '403': problemResponse('No verified subject.'),
            '404': problemResponse('No objection of yours with that id.'),
          },
        },
      },
      '/retention/notices': {
        post: {
          tags: ['consent'],
          operationId: 'giveRetentionNotice',
          summary: 'Record the notice given at enrolment',
          description:
            'DPPA s.13(1)(i). Records what a subject was actually told about how long their data will be kept — the wording, the ground, the purposes, the language it was given in and how it reached them. `given_by` is the verified caller and is never taken from the body. Append-only: a changed policy is a new notice, and the earlier one still governs the period before it. Nothing in the kernel acts on `period_stated`; the lawful period is unresolved and no expiry job exists.',
          parameters: writeHeaders,
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: ref('RetentionNoticeSubmission') },
            },
          },
          responses: {
            '201': {
              description: 'Recorded.',
              content: { 'application/json': { schema: ref('RetentionNotice') } },
            },
            '400': problemResponse('The notice is incomplete.'),
            '403': problemResponse('No verified party.'),
          },
        },
        get: {
          tags: ['consent'],
          operationId: 'retentionNotices',
          summary: 'What a party was told, and when',
          description:
            'The subject sees every notice given to them; anybody else sees only the notices they themselves gave, so a cooperative cannot read what a rival told the same farmer. With `as_at`, returns the single notice in force at that moment — which is the question worth asking, since a notice given later does not retroactively become what somebody was told.',
          parameters: [
            {
              name: 'party',
              in: 'query',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
            {
              name: 'as_at',
              in: 'query',
              required: false,
              schema: { type: 'string', format: 'date-time' },
            },
          ],
          responses: {
            '200': {
              description: 'Notices this caller may read.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['notices'],
                    properties: {
                      notices: {
                        type: 'array',
                        items: ref('RetentionNotice'),
                      },
                    },
                  },
                },
              },
            },
            '400': problemResponse('A party id is required.'),
            '403': problemResponse('No verified party.'),
          },
        },
      },
      '/subject-access': {
        get: {
          tags: ['consent'],
          operationId: 'subjectAccess',
          summary: 'Everything held about you',
          description:
            'There is no subject parameter and there must not be one. The answer is assembled for the verified subject and nobody else, because a route that took an id would be a route for enumerating everyone’s records with one compromised token. Where a record involves another individual their particulars are blanked and the record is still returned — s.24(4) and s.24(7) offer redaction, and wholesale refusal is the wrong answer to the commonest shape of record held.',
          responses: {
            '200': {
              description: 'The subject’s own answer under s.24.',
              content: {
                'application/json': {
                  schema: ref('SubjectAccessResponse'),
                },
              },
            },
            '403': problemResponse('No verified subject.'),
          },
        },
      },
      '/health': {
        get: {
          tags: ['operations'],
          operationId: 'health',
          summary: 'Liveness',
          responses: {
            '200': {
              description: 'The process is up.',
              content: { 'application/json': { schema: ref('Health') } },
            },
          },
        },
      },
      '/ready': {
        get: {
          tags: ['operations'],
          operationId: 'ready',
          summary: 'Readiness',
          description: 'Checks that the log is reachable.',
          responses: {
            '200': {
              description: 'Ready to serve.',
              content: { 'application/json': { schema: ref('Health') } },
            },
            '503': problemResponse('The log is not reachable.'),
          },
        },
      },
      '/metrics': {
        get: {
          tags: ['operations'],
          operationId: 'metrics',
          summary: 'Prometheus metrics',
          description:
            'Normalized mass grouped by the basis of the conversion behind it, ' +
            'and the share of it resting on an unverified default factor. ' +
            'A high assumed share is the honest state of the unit registry, ' +
            'not a fault in the endpoint.',
          responses: {
            '200': {
              description: 'Prometheus text exposition format.',
              content: { 'text/plain': { schema: { type: 'string' } } },
            },
            '500': problemResponse('The rollup could not be computed.'),
          },
        },
      },
    },
    components: { schemas },
  };
}
