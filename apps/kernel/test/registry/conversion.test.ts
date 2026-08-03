import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { uuidv7 } from 'uuidv7';

import { startTestDatabase, type TestDatabase } from '../helpers/database.js';
import {
  deliveryDocument,
  ingestServiceFor,
  type TestIngest,
} from '../helpers/fixtures.js';
import { ConversionService } from '../../src/registry/conversion.service.js';
import { RegistryRepository } from '../../src/registry/registry.repository.js';

let db: TestDatabase;
let ingest: TestIngest;

before(async () => {
  db = await startTestDatabase();
  ({ ingest } = ingestServiceFor(db.app));
});

after(async () => {
  await db.stop();
});

/** Seeded by 0010: maize bag -> 100 kg nationally, 120 kg in Kapchorwa. */
const MAIZE_BAG = '019fc600-0000-7000-8000-000000000020';
const MAIZE_BAG_KAPCHORWA = '019fc600-0000-7000-8000-000000000030';
const COFFEE_BAG = '019fc600-0000-7000-8000-000000000010';

/** A delivery of `bags` bags of maize, normalized however the client says. */
const delivery = (quantity: Record<string, unknown>, extra = {}) =>
  deliveryDocument({
    id: uuidv7(),
    commodity: 'crop.maize.grain',
    quantity: {
      raw_value: 12,
      raw_unit: 'bag',
      raw_unit_label: null,
      normalized_kg: 1200,
      conversion_id: MAIZE_BAG,
      measurement_method: 'coop_weighed',
      quality_flags: [],
      ...quantity,
    },
    ...extra,
  });

const flagsOf = async (document: Record<string, unknown>) => {
  const { record } = await ingest.ingest(document);
  return record.quality_flags;
};

/**
 * Spec §3.2. Before this, `conversion_id` was any well-formed UUID and
 * `normalized_kg` was whatever the client said it was. A record could claim a
 * kilogram figure with nothing behind it and read as *more* reliable than an
 * honest unconverted one.
 */
describe('a normalized weight must be reproducible from the registry', () => {
  test('a conversion that resolves and reproduces the weight raises nothing', async () => {
    const flags = await flagsOf(delivery({}));

    assert.ok(!flags.some((flag) => flag.startsWith('conversion_')), flags.join());
  });

  test('an unknown conversion id is flagged, not rejected', async () => {
    const flags = await flagsOf(delivery({ conversion_id: uuidv7() }));

    assert.ok(flags.includes('conversion_unresolved'));
  });

  test('a normalized weight with no conversion at all never reaches the flag', async () => {
    // The schema's own refinement gets there first, which is the right place
    // for it. Recorded here so the boundary stays visible.
    const rejected = await ingest
      .ingest(delivery({ conversion_id: null }))
      .then(() => null, (error: unknown) => error);

    assert.equal((rejected as { code?: string }).code, 'malformed_record');
  });

  test('kilograms need no conversion', async () => {
    const flags = await flagsOf(
      delivery({
        raw_value: 1200,
        raw_unit: 'kg',
        normalized_kg: 1200,
        conversion_id: null,
      }),
    );

    assert.ok(!flags.includes('conversion_unresolved'), flags.join());
  });

  test('a weight the kernel cannot reproduce is flagged', async () => {
    // 12 bags at the seeded 100 kg is 1200. The client says 5000.
    const flags = await flagsOf(delivery({ normalized_kg: 5000 }));

    assert.ok(flags.includes('conversion_mismatch'));
  });

  test('the record is still stored — P6 flags, it does not reject', async () => {
    const document = delivery({ normalized_kg: 5000 });
    const { record } = await ingest.ingest(document);

    assert.equal(record.id, document.id);
  });
});

describe('a conversion only counts inside its own scope', () => {
  test('a factor for another commodity is a scope mismatch', async () => {
    const flags = await flagsOf(
      delivery({ conversion_id: COFFEE_BAG, normalized_kg: 720 }),
    );

    assert.ok(flags.includes('conversion_scope_mismatch'));
  });

  test('a district factor cited by a record with no district is a scope mismatch', async () => {
    const flags = await flagsOf(
      delivery({ conversion_id: MAIZE_BAG_KAPCHORWA, normalized_kg: 1440 }),
    );

    assert.ok(
      flags.includes('conversion_scope_mismatch'),
      'a record that never says where it happened cannot claim a local factor',
    );
  });

  test('scope and arithmetic are separate findings', async () => {
    const flags = await flagsOf(
      delivery({ conversion_id: COFFEE_BAG, normalized_kg: 99 }),
    );

    assert.ok(flags.includes('conversion_scope_mismatch'));
    assert.ok(flags.includes('conversion_mismatch'));
  });

  test('a document carrying both commodity and region satisfies the scope', async () => {
    const conversions = new ConversionService(new RegistryRepository(db.app));

    const flags = await conversions.flags(
      {
        commodity: 'crop.maize.grain',
        admin_region: { code: 'UG.KAPCHORWA', vintage: '2020' },
        quantity: {
          raw_value: 12,
          raw_unit: 'bag',
          normalized_kg: 1440,
          conversion_id: MAIZE_BAG_KAPCHORWA,
        },
      },
      '2026-08-01T00:00:00.000Z',
    );

    assert.deepEqual(flags, []);
  });

  test('FINDING: no core entity carries both a commodity and a region', () => {
    // Delivery, Lot and Harvest name a commodity but no boundary. Plot and
    // Facility name a boundary but no commodity. So a region-scoped factor
    // cannot currently be satisfied by any record the kernel accepts, and the
    // Kapchorwa row seeded in 0010 will flag wherever it is cited.
    //
    // This is a schema-shape question for spec §13, not something to soften
    // here by letting an unlocated record borrow a district factor.
    assert.ok(true);
  });
});
