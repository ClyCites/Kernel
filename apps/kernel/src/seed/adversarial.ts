import { SCHEMA_VERSION } from '@clycites/schema';
import { COOPS, CONVERSIONS, type CoopFixture } from './fixtures.js';
import {
  DAY,
  envelope,
  kg,
  UNRESOLVED_CONVERSION,
  type DeliveryRecord,
  type FarmerRef,
  type LotRecord,
  type Push,
  type SeedPlan,
} from './generate.js';
import { at, IdFactory, Rng, round } from './random.js';

/**
 * Work order D5. The cases the corpus exists for.
 *
 * Everything above this file is ordinary traffic — necessary, because an
 * adversarial case in isolation is a unit test and the point is that these are
 * buried in two hundred plausible records. These are the ones that are supposed
 * to be hard: two farmers with one name, one farmer with two, corrections that
 * collide, and writes that must be refused.
 */

export interface AdversarialContext {
  rng: Rng;
  ids: IdFactory;
  push: Push;
  coopParties: Record<CoopFixture['key'], string>;
  officers: Record<CoopFixture['key'], string>;
  facilities: Record<CoopFixture['key'], string>;
  /** Farmer id to plot id. A Harvest without a plot does not satisfy the schema. */
  plots: Record<string, string>;
  delegations: Record<CoopFixture['key'], string>;
  bylawDelegationId: string;
  agreements: Record<CoopFixture['key'], string>;
  obligations: Record<CoopFixture['key'], string>;
  overDeliveredAgreement: string;
  farmers: FarmerRef[];
  deliveries: DeliveryRecord[];
  lots: LotRecord[];
  lender: string;
}

const COOP_A = COOPS[0]!;
const COOP_C = COOPS[2]!;
const COOP_D = COOPS[3]!;

export function appendAdversarial(plan: SeedPlan, ctx: AdversarialContext): void {
  const { rng, ids, push, coopParties, officers, facilities, farmers, deliveries } = ctx;

  /* ── 1. One name, two people, inside a single cooperative ───────────────
     The registry has no way to tell them apart except the NIN one of them
     holds. A system that deduplicates on display_name silently merges a
     farmer's harvest into her neighbour's credit history. */

  const twinName = 'Nakato Ssemakula';
  const twinA = ids.next();
  const twinB = ids.next();
  for (const [id, withNin] of [
    [twinA, true],
    [twinB, false],
  ] as const) {
    push(
      envelope({ id, type: 'party', occurredAt: at(DAY.registration + 7), assertedBy: coopParties.A }, {
        kind: 'person',
        display_name: twinName,
        identifiers: withNin
          ? [
              {
                scheme: 'ug.nira.nin',
                value: 'CM91004411AA',
                attested_by: coopParties.A,
                attested_at: at(DAY.registration + 7, 10),
              },
            ]
          : [],
        contacts: [{ channel: 'phone', value: withNin ? '+256772110011' : '+256772110022' }],
        primary_region: { code: COOP_A.district.code, vintage: COOP_A.district.vintage },
      }),
      'contract_performance',
    );
  }

  /* ── 2. One person, two cooperatives, two spellings ─────────────────────
     Cross-coop double-financing is the failure this makes visible. Both
     records are honest; neither coop knows about the other. */

  const dualA = ids.next();
  push(
    envelope({ id: dualA, type: 'party', occurredAt: at(DAY.registration + 8), assertedBy: coopParties.A }, {
      kind: 'person',
      display_name: 'Byaruhanga Tumusiime',
      identifiers: [],
      contacts: [{ channel: 'phone', value: '+256772330044' }],
      primary_region: { code: COOP_A.district.code, vintage: COOP_A.district.vintage },
    }),
    'contract_performance',
  );

  const dualB = ids.next();
  push(
    envelope({ id: dualB, type: 'party', occurredAt: at(DAY.registration + 9), assertedBy: coopParties.B }, {
      kind: 'person',
      display_name: 'B. Tumusime',
      identifiers: [],
      // Same handset, one digit transposed by whoever typed it in.
      contacts: [{ channel: 'phone', value: '+256772330404' }],
      primary_region: { code: COOPS[1]!.district.code, vintage: COOPS[1]!.district.vintage },
    }),
    'contract_performance',
  );

  /* ── 3. A correction: one delivery superseded by a re-weighing ─────────── */

  const corrected = deliveries.find((d) => d.coop === 'A')!;
  plan.markers.supersededDelivery = corrected.id;
  plan.markers.supersedingDelivery = push(
    envelope(
      {
        id: ids.next(),
        type: 'delivery',
        occurredAt: at(corrected.day, 15),
        assertedBy: coopParties.A,
        supersedes: corrected.id,
      },
      deliveryBody(ctx, corrected, 11, true),
    ),
    'special_data_consent',
  );

  /* ── 4. A fork: two officers correct the same delivery, differently ─────
     Neither is wrong and the kernel will not choose. Decision 0021 says the
     derived views drop it and say so, which is what this fixture proves end
     to end rather than in a unit test. */

  const forkParent = deliveries.filter((d) => d.coop === 'A')[1]!;
  plan.markers.forkParent = forkParent.id;
  plan.markers.forkLeft = push(
    envelope(
      {
        id: ids.next(),
        type: 'delivery',
        occurredAt: at(forkParent.day, 16),
        assertedBy: coopParties.A,
        supersedes: forkParent.id,
      },
      deliveryBody(ctx, forkParent, 13, true),
    ),
    'special_data_consent',
  );
  plan.markers.forkRight = push(
    envelope(
      {
        id: ids.next(),
        type: 'delivery',
        occurredAt: at(forkParent.day, 17),
        assertedBy: coopParties.A,
        supersedes: forkParent.id,
      },
      deliveryBody(ctx, forkParent, 9, false),
    ),
    'special_data_consent',
  );

  /* ── 5. A retraction: the delivery was booked against the wrong farmer ─── */

  const misattributed = deliveries.filter((d) => d.coop === 'B')[0]!;
  plan.markers.retractedDelivery = misattributed.id;
  plan.markers.retraction = push(
    envelope(
      {
        id: ids.next(),
        type: 'retraction',
        occurredAt: at(misattributed.day + 3),
        assertedBy: coopParties.B,
      },
      {
        target: misattributed.id,
        reason_code: 'wrong_subject',
        note: 'Booked against the wrong member at intake; re-entered under the correct farmer.',
      },
    ),
    'contract_performance',
  );

  /* ── 6. Delegated writes ────────────────────────────────────────────────
     Coop B's officer records for forty farmers under a bylaw. That is lawful
     and it is also the weakest ground in the enum, so every one of these
     carries `delegated_by_organisational_bylaw` and a lender can price it. */

  const bylawSubjects = [
    ...farmers.filter((f) => f.coop === 'B'),
    ...farmers.filter((f) => f.coop === 'A'),
  ].slice(0, 40);

  bylawSubjects.forEach((farmer, index) => {
    const coop = farmer.coop === 'B' ? COOPS[1]! : COOP_A;
    push(
      envelope(
        {
          id: ids.next(),
          type: 'harvest',
          occurredAt: at(DAY.harvest + 2),
          assertedBy: officers.B,
          onBehalfOf: coopParties.B,
          delegation: ctx.bylawDelegationId,
        },
        {
          plot: ctx.plots[farmer.id],
          crop: coop.commodity,
          quantity: {
            raw_value: 2 + (index % 5),
            raw_unit: coop.rawUnit,
            raw_unit_label: coop.rawUnitLabel,
            normalized_kg: round((2 + (index % 5)) * coop.factor, 3),
            conversion_id: coop.conversionId ?? UNRESOLVED_CONVERSION,
            measurement_method: 'field_estimated',
          },
        },
      ),
      'contract_performance',
    );
  });

  // One write under the ordinary in-person delegation, for contrast: same
  // mechanism, stronger ground, different flag.
  const contrastFarmer = farmers.find((f) => f.coop === 'A')!;
  push(
    envelope(
      {
        id: ids.next(),
        type: 'harvest',
        occurredAt: at(DAY.harvest + 3),
        assertedBy: officers.A,
        onBehalfOf: coopParties.A,
        delegation: ctx.delegations.A,
      },
      { plot: ctx.plots[contrastFarmer.id], crop: COOP_A.commodity, quantity: kg(410, 'coop_weighed') },
    ),
    'contract_performance',
  );

  /* ── 7. Two writes claiming authority nobody granted ────────────────────
     These must be refused. A seed that only contains records the kernel
     accepted cannot demonstrate that it refuses anything. */

  push(
    envelope(
      {
        id: ids.next(),
        type: 'harvest',
        occurredAt: at(DAY.harvest + 4),
        assertedBy: officers.C,
        onBehalfOf: coopParties.A,
        delegation: ctx.delegations.A,
      },
      { plot: ctx.plots[contrastFarmer.id], crop: COOP_A.commodity, quantity: kg(300, 'field_estimated') },
    ),
    'contract_performance',
    'rejected',
    "coop C's officer citing coop A's delegation, which does not name him",
  );

  push(
    envelope(
      {
        id: ids.next(),
        type: 'settlement_reference',
        occurredAt: at(DAY.settlement + 1),
        assertedBy: officers.A,
        onBehalfOf: coopParties.A,
        delegation: ctx.delegations.A,
      },
      {
        obligation: ctx.obligations.A,
        amount: { amount_minor: 1_000_000, currency: 'UGX' },
        settled_at: at(DAY.settlement + 1, 12),
        rail: 'cash',
        external_ref: 'OUT-OF-SCOPE',
        confirmed_by: coopParties.A,
      },
    ),
    'special_data_consent',
    'rejected',
    'the delegation covers delivery, harvest and observation — not money',
  );

  /* ── 8. The lawful basis a priced delivery cannot be written under ────── */

  const priced = deliveries.find((d) => d.coop === 'A')!;
  push(
    envelope(
      { id: ids.next(), type: 'delivery', occurredAt: at(priced.day, 12), assertedBy: coopParties.A },
      deliveryBody(ctx, priced, 5, false),
    ),
    'contract_performance',
    'rejected',
    's.9(1) — a priced delivery about an identifiable person needs s.9(3) consent',
  );

  /* ── 9. A conversion whose scope cannot be checked ──────────────────────
     The Kapchorwa factor is region-scoped. A Delivery carries no region, so
     nothing about it can satisfy the scope — and, equally, nothing about it
     can contradict the scope either. This used to raise
     `conversion_scope_mismatch`, which read as a finding against the record
     when it was really a finding against the check. It now raises
     `region_unresolvable`: the factor may well hold here, and we cannot say.

     Worth stating plainly, because it is the more useful half of P1's third
     item: no record type that carries a quantity also carries an
     `admin_region`. Plot and Facility have a region and no quantity; Delivery
     and Harvest have a quantity and no region. So the region limb of the
     scope check is unreachable in this corpus by construction, and every
     district-scoped factor in the registry is uncheckable against the records
     that cite it. */

  const scopeVictim = deliveries.find((d) => d.coop === 'C')!;
  plan.markers.regionUnresolvableDelivery = push(
    envelope(
      { id: ids.next(), type: 'delivery', occurredAt: at(scopeVictim.day, 13), assertedBy: coopParties.C },
      {
        from_party: scopeVictim.farmer,
        to_party: coopParties.C,
        lot: null,
        fulfils: ctx.agreements.C,
        commodity: COOP_C.commodity,
        quantity: {
          raw_value: 7,
          raw_unit: 'bag',
          raw_unit_label: 'gunia',
          normalized_kg: 840,
          conversion_id: CONVERSIONS.maizeBagKapchorwa,
          measurement_method: 'coop_counted',
        },
        location: facilities.C,
        agreed_price: { amount_minor: 1150, currency: 'UGX' },
        counterparty_confirmed_at: null,
        counterparty_confirmed_by: null,
      },
    ),
    'special_data_consent',
  );

  /* ── 9b. A conversion cited outside its scope, determinably ─────────────
     Coop D grows beans. This delivery cites the maize bag factor, which is
     registered against `crop.maize.grain`. Commodity is stated on every
     delivery, so unlike the region case above this comparison has an answer,
     and the answer is no — the factor does not cover this record.

     A clerk picking the wrong row off a list of factors is the ordinary way
     this happens, and the kilograms that come out are wrong by whatever the
     two factors differ by. After the split this is the only record in the
     corpus raising `conversion_scope_mismatch`, which is the point: the flag
     now appears where something is actually wrong. */

  const wrongFactorFarmer = farmers.find((f) => f.coop === 'D')!;
  plan.markers.scopeMismatchDelivery = push(
    envelope(
      { id: ids.next(), type: 'delivery', occurredAt: at(DAY.harvest + 3, 9), assertedBy: coopParties.D },
      {
        from_party: wrongFactorFarmer.id,
        to_party: coopParties.D,
        lot: null,
        fulfils: null,
        commodity: COOP_D.commodity,
        quantity: {
          raw_value: 4,
          raw_unit: 'bag',
          raw_unit_label: 'gunia',
          normalized_kg: 400,
          conversion_id: CONVERSIONS.maizeBagAssumed,
          measurement_method: 'coop_counted',
        },
        location: facilities.D,
        agreed_price: null,
        counterparty_confirmed_at: null,
        counterparty_confirmed_by: null,
      },
    ),
    'special_data_consent',
  );

  /* ── 10. A quantity nobody normalised ───────────────────────────────────
     A heap is a heap. Refusing the record loses the observation; storing it
     unnormalised keeps it and marks it unusable for underwriting. */

  const heapFarmer = farmers.find((f) => f.coop === 'D')!;
  push(
    envelope({ id: ids.next(), type: 'harvest', occurredAt: at(DAY.harvest + 1), assertedBy: coopParties.D }, {
      plot: ctx.plots[heapFarmer.id],
      crop: COOPS[3]!.commodity,
      quantity: {
        raw_value: 3,
        raw_unit: 'heap',
        raw_unit_label: 'ntabo',
        normalized_kg: null,
        conversion_id: null,
        measurement_method: 'self_reported',
      },
    }),
    'contract_performance',
  );

  /* ── 11. Over-delivery against the small forward ────────────────────────
     Coop A committed two tonnes and its members brought more. Fulfilment is
     summed from deliveries, so this has to come out as over-delivered rather
     than capped at the commitment. */

  const overDeliverers = farmers.filter((f) => f.coop === 'A').slice(0, 4);
  for (const farmer of overDeliverers) {
    push(
      envelope(
        { id: ids.next(), type: 'delivery', occurredAt: at(DAY.deliveryFirst + 40, 9), assertedBy: coopParties.A },
        {
          from_party: farmer.id,
          to_party: coopParties.A,
          lot: null,
          fulfils: ctx.overDeliveredAgreement,
          commodity: COOP_A.commodity,
          quantity: {
            raw_value: 8,
            raw_unit: 'bag',
            raw_unit_label: 'kaveera',
            normalized_kg: 800,
            conversion_id: CONVERSIONS.maizeBagMeasured,
            measurement_method: 'coop_weighed',
          },
          location: facilities.A,
          agreed_price: { amount_minor: 1200, currency: 'UGX' },
          counterparty_confirmed_at: at(DAY.deliveryFirst + 40, 18),
          counterparty_confirmed_by: farmer.id,
        },
      ),
      'special_data_consent',
    );
  }

  /* ── 12. An inference, validated by a later delivery ──────────────────
     P4: this now writes. `POST /v1/inferences` is the second route, and the
     validation is a second request months after the first, because that is
     what happens in the field — the prediction is made in March and the
     delivery that settles it arrives in August.

     `validated_by` is not submitted. The kernel derives it from
     `inference.validation`, so a value in the body would be discarded; the
     seed states the linkage the same way a client has to, through the
     validation route. `inference_depth` is likewise computed — every input
     here is an observation, so it comes out 0 — and the fixture no longer
     asserts a number the kernel would only overwrite. D5's "at least one
     Inference with validated_by" is satisfiable through the contract now. */

  const subject = farmers.find((f) => f.coop === 'C')!;
  const validator = deliveries.filter((d) => d.coop === 'C').slice(-1)[0]!;
  const inputs = deliveries.filter((d) => d.farmer === subject.id).map((d) => d.id);

  plan.markers.inference = push(
    {
      id: ids.next(),
      type: 'inference',
      record_class: 'inference',
      schema_version: SCHEMA_VERSION,
      occurred_at: at(DAY.lot, 12),
      occurred_at_precision: 'day',
      asserted_by: ctx.lender,
      model_id: 'yield-estimator',
      model_version: '0.1.0',
      inference_type: 'yield.predicted',
      subject_type: 'party',
      subject_ref: subject.id,
      inputs,
      output: {
        kind: 'range',
        low: round(rng.normalWithin(800, 80, 400, 1200), 1),
        high: round(rng.normalWithin(1400, 90, 1250, 1900), 1),
        unit: 'kg',
      },
      confidence: round(rng.normalWithin(0.62, 0.08, 0.4, 0.9), 3),
      inference_depth: 0,
    },
    'contract_performance',
  );

  plan.validations.push({
    inference: plan.markers.inference,
    observation: validator.id,
    verdict: 'confirmed',
    linkedBy: ctx.lender,
    note: 'the delivery that settled the estimate, linked when it arrived',
  });
}

/** A delivery body that mirrors an existing one at a different weight. */
function deliveryBody(
  ctx: AdversarialContext,
  source: DeliveryRecord,
  bags: number,
  confirmed: boolean,
): Record<string, unknown> {
  const coop = COOPS.find((c) => c.key === source.coop)!;
  return {
    from_party: source.farmer,
    to_party: ctx.coopParties[source.coop],
    lot: null,
    fulfils: ctx.agreements[source.coop],
    commodity: coop.commodity,
    quantity: {
      raw_value: bags,
      raw_unit: coop.rawUnit,
      raw_unit_label: coop.rawUnitLabel,
      normalized_kg: round(bags * coop.factor, 3),
      conversion_id: coop.conversionId ?? UNRESOLVED_CONVERSION,
      measurement_method: 'coop_weighed',
    },
    location: ctx.facilities[source.coop],
    agreed_price: { amount_minor: 1150, currency: 'UGX' },
    counterparty_confirmed_at: confirmed ? at(source.day, 19) : null,
    counterparty_confirmed_by: confirmed ? source.farmer : null,
  };
}
