import { z } from 'zod';

import { CONSENT_PURPOSES } from '../consent/consent.service.js';
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
    required: ['custodian', 'asserted', 'as_of', 'transfers', 'broken'],
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
          'A weighing or a loss could not be read in kilograms, so the arithmetic is partial. A clean-looking balance on an incomplete ledger means nothing.',
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
          'At least one delivery is unconvertible, so `delivered_kg` is a floor and not a total. Any percentage taken from it understates.',
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
