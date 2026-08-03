import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { uuidv7 } from 'uuidv7';

import { startTestDatabase, type TestDatabase } from '../helpers/database.js';
import {
  deliveryDocument,
  entityDocument,
  ingestServiceFor,
  subjectAccessServiceFor,
  type TestIngest,
} from '../helpers/fixtures.js';
import { OperationsController } from '../../src/api/operations.controller.js';
import { DisclosureNotificationRepository } from '../../src/consent/disclosure-notification.repository.js';
import { ObjectionRepository } from '../../src/consent/objection.repository.js';
import { RegistryRepository } from '../../src/registry/registry.repository.js';
import { RecordRepository } from '../../src/records/record.repository.js';
import { declaredLawfulBasis } from '../../src/api/dataset.js';
import {
  carriesFinancialData,
  checkBasis,
  LAWFUL_BASES,
  objectionStops,
} from '../../src/records/lawful-basis.js';
import type { Request } from 'express';
import type { IngestService } from '../../src/records/ingest.service.js';

let db: TestDatabase;
let ingest: TestIngest;
let service: IngestService;
let repository: RecordRepository;
let operations: OperationsController;

before(async () => {
  db = await startTestDatabase();
  const assembled = ingestServiceFor(db.app);
  ingest = assembled.ingest;
  service = assembled.service;
  repository = assembled.repository;
  operations = new OperationsController(
    db.app,
    new RegistryRepository(db.app),
    repository,
    new ObjectionRepository(db.app),
    subjectAccessServiceFor(db.app),
    new DisclosureNotificationRepository(db.app),
  );
});

after(async () => {
  await db.stop();
});

const requestWith = (headers: Record<string, string>): Request =>
  ({ header: (name: string) => headers[name.toLowerCase()] }) as Request;

describe('a record states the ground it was collected under', () => {
  test('a write with no stated basis is refused', async () => {
    await assert.rejects(
      service.ingest(deliveryDocument()),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, 'lawful_basis_required');
        return true;
      },
    );
  });

  test('a basis outside the Act is refused', async () => {
    await assert.rejects(
      service.ingest(deliveryDocument(), {
        lawfulBasis: 'legitimate_interest' as never,
      }),
      (error: Error & { code?: string }) => {
        // The DPPA has no legitimate-interest ground. Accepting a GDPR habit
        // here would record a basis that does not exist in Ugandan law.
        assert.equal(error.code, 'lawful_basis_required');
        return true;
      },
    );
  });

  test('nothing is written when the basis is missing', async () => {
    const document = deliveryDocument();
    await assert.rejects(service.ingest(document));

    const found = await repository.findById(String(document['id']));
    assert.equal(found, null);
  });

  test('the stated basis is stored on the record', async () => {
    const { record } = await ingest.ingest(
      entityDocument('plot'),
      { lawfulBasis: 'consent' },
    );

    assert.equal(record.lawful_basis, 'consent');
    const stored = await repository.findById(record.id);
    assert.equal(stored?.lawful_basis, 'consent');
  });

  test('every value in the enum is accepted by the column', async () => {
    for (const basis of LAWFUL_BASES) {
      const { record } = await ingest.ingest(entityDocument('plot'), {
        lawfulBasis: basis,
      });
      assert.equal(record.lawful_basis, basis);
    }
  });
});

describe('financial records are s.9 special data', () => {
  test('an obligation on contract_performance is rejected', async () => {
    await assert.rejects(
      ingest.ingest(entityDocument('obligation'), {
        lawfulBasis: 'contract_performance',
      }),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, 'lawful_basis_insufficient');
        return true;
      },
    );
  });

  test('an obligation on special_data_consent is accepted', async () => {
    const { record } = await ingest.ingest(entityDocument('obligation'), {
      lawfulBasis: 'special_data_consent',
    });

    assert.equal(record.lawful_basis, 'special_data_consent');
  });

  test('a settlement reference is financial too', async () => {
    await assert.rejects(
      ingest.ingest(entityDocument('settlement_reference'), {
        lawfulBasis: 'consent',
      }),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, 'lawful_basis_insufficient');
        return true;
      },
    );
  });

  test('a priced delivery is financial; an unpriced one is not', () => {
    assert.equal(
      carriesFinancialData('delivery', {
        agreed_price: { amount_minor: 1150, currency: 'UGX' },
      }),
      true,
    );
    assert.equal(carriesFinancialData('delivery', { agreed_price: null }), false);
  });

  test('FINDING: the default delivery is special data', async () => {
    // `deliveryDocument` mirrors Appendix A, and it carries a price. If the
    // real corpus looks like the spec's own example then almost every delivery
    // is s.9(1) special data, and the platform runs on s.9(3)(b) consent —
    // which is also the basis a farmer can withdraw under s.7(3).
    assert.equal(carriesFinancialData('delivery', deliveryDocument()), true);

    await assert.rejects(
      ingest.ingest(deliveryDocument(), {
        lawfulBasis: 'contract_performance',
      }),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, 'lawful_basis_insufficient');
        return true;
      },
    );
  });

  test('a non-financial record accepts any ground', () => {
    for (const basis of LAWFUL_BASES) {
      assert.equal(checkBasis(basis, 'plot', {}), null);
    }
  });
});

describe('s.7(3) resolves by basis', () => {
  test('consent can be withdrawn', () => {
    assert.equal(objectionStops('consent'), true);
    assert.equal(objectionStops('special_data_consent'), true);
  });

  test('a s.7(2) ground is not the subject’s to withdraw', () => {
    for (const basis of [
      'legal_authorisation',
      'public_duty',
      'national_security',
      'law_enforcement',
      'contract_performance',
      'medical',
      'legal_obligation',
    ] as const) {
      assert.equal(objectionStops(basis), false, basis);
    }
  });

  test('every basis in the enum has a settled answer', () => {
    for (const basis of LAWFUL_BASES) {
      assert.equal(typeof objectionStops(basis), 'boolean');
    }
  });
});

describe('the declared basis comes from the caller, not the payload', () => {
  test('a recognised header is read', () => {
    const request = requestWith({ 'x-clycites-lawful-basis': 'consent' });

    assert.equal(declaredLawfulBasis(request), 'consent');
  });

  test('an absent header yields nothing rather than a guess', () => {
    assert.equal(declaredLawfulBasis(requestWith({})), undefined);
  });

  test('an unrecognised header yields nothing rather than a guess', () => {
    const request = requestWith({ 'x-clycites-lawful-basis': 'because' });

    assert.equal(declaredLawfulBasis(request), undefined);
  });

  test('a basis in the payload is ignored', async () => {
    const document = deliveryDocument();
    document['lawful_basis'] = 'legal_obligation';

    const { record } = await ingest.ingest(document, {
      lawfulBasis: 'special_data_consent',
    });

    assert.equal(record.lawful_basis, 'special_data_consent');
    assert.equal(record.body['lawful_basis'], undefined);
  });
});

describe('the basis distribution is reported', () => {
  test('metrics carry the census and the special-data breach count', async () => {
    await ingest.ingest(entityDocument('plot'), { lawfulBasis: 'consent' });

    const body = await operations.metrics();

    assert.match(
      body,
      /kernel_records_by_lawful_basis\{basis="consent",financial="false"\} \d+/,
    );
    assert.match(body, /# TYPE kernel_records_by_lawful_basis gauge/);
    // Ingest refuses every route to a non-zero value.
    assert.match(body, /kernel_financial_records_without_special_consent 0\n/);
  });

  test('not even the schema owner can write a record without a basis', async () => {
    await assert.rejects(
      db.owner.query(
        `insert into facts.record (
           id, type, record_class, schema_version, occurred_at,
           occurred_at_precision, recorded_at, asserted_by, body, ext,
           quality_flags, dataset, lawful_basis
         ) values (
           $1, 'plot', 'observation', '0.2.0', now(), 'instant', now(), $2,
           '{}'::jsonb, '{}'::jsonb, '{}', 'live', null
         )`,
        [uuidv7(), uuidv7()],
      ),
      /facts_lawful_basis_stated/,
    );
  });

  test('records written before 0013 are grandfathered, not backfilled', async () => {
    const { rows } = await db.owner.query<{ convalidated: boolean }>(
      `select convalidated from pg_constraint
        where conname = 'facts_lawful_basis_stated'
          and conrelid = 'facts.record'::regclass`,
    );

    // NOT VALID is the point: the constraint binds every insert from now on
    // while leaving pre-existing rows unchecked. Backfilling them with
    // 'consent' would assert a consent nobody obtained, into a log that can
    // never correct it.
    assert.equal(rows[0]?.convalidated, false);
  });
});
