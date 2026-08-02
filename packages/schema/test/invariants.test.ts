import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import {
  MEASUREMENT_METHODS,
  MeasurementMethod,
  weakestMethod,
  isUnderwritable,
  Quantity,
  Money,
  Delivery,
  Harvest,
  Party,
  Inference,
  isTrainingEligible,
  exceedsRecommendedDepth,
  SCHEMA_VERSION,
} from "../src/index.js";

/* ── fixtures ─────────────────────────────────────────────────────────── */

const uuid = (n: number) =>
  `01900000-0000-7000-8000-${String(n).padStart(12, "0")}`;

const envelope = (over: Record<string, unknown> = {}) => ({
  id: uuid(1),
  schema_version: SCHEMA_VERSION,
  occurred_at: "2026-07-18T00:00:00+03:00",
  occurred_at_precision: "day",
  recorded_at: "2026-07-18T14:32:11+03:00",
  asserted_by: uuid(2),
  ...over,
});

const kg = (v: number, method: MeasurementMethod = "coop_weighed") => ({
  raw_value: v,
  raw_unit: "kg",
  measurement_method: method,
});

/* ── the trust ladder ─────────────────────────────────────────────────── */

describe("measurement method — spec §3.3", () => {
  test("there is no value for model-derived output", () => {
    for (const forbidden of [
      "model_estimated",
      "predicted",
      "inferred",
      "ai_generated",
    ]) {
      assert.equal(
        MEASUREMENT_METHODS.includes(forbidden as MeasurementMethod),
        false,
        `${forbidden} must never be a measurement method — model outputs are Inferences`,
      );
      assert.equal(MeasurementMethod.safeParse(forbidden).success, false);
    }
  });

  test("a blended figure inherits its weakest component", () => {
    assert.equal(
      weakestMethod(["third_party_verified", "self_reported", "coop_weighed"]),
      "self_reported",
    );
  });

  test("the underwritable threshold sits at coop_weighed", () => {
    assert.equal(isUnderwritable("field_estimated"), false);
    assert.equal(isUnderwritable("coop_weighed"), true);
    assert.equal(isUnderwritable("counterparty_confirmed"), true);
  });
});

/* ── quantity ─────────────────────────────────────────────────────────── */

describe("quantity — spec §3.1", () => {
  test("a normalized weight requires a conversion reference", () => {
    const inlineConversion = Quantity.safeParse({
      raw_value: 12,
      raw_unit: "bag",
      normalized_kg: 1416,
      measurement_method: "coop_weighed",
    });
    assert.equal(
      inlineConversion.success,
      false,
      "an inline conversion cannot be re-derived when the factor turns out wrong",
    );
  });

  test("a conversion reference makes it valid", () => {
    const ok = Quantity.safeParse({
      raw_value: 12,
      raw_unit: "bag",
      raw_unit_label: "kaveera",
      normalized_kg: 1416,
      conversion_id: uuid(9),
      measurement_method: "coop_weighed",
    });
    assert.equal(ok.success, true, JSON.stringify(ok.error?.issues));
  });

  test("kilograms need no conversion", () => {
    assert.equal(Quantity.safeParse({ ...kg(50), normalized_kg: 50 }).success, true);
  });

  test("a measurement method is always required", () => {
    assert.equal(
      Quantity.safeParse({ raw_value: 12, raw_unit: "bag" }).success,
      false,
    );
  });
});

/* ── money ────────────────────────────────────────────────────────────── */

describe("money — spec §3.5", () => {
  test("minor units are integers, never floats", () => {
    assert.equal(Money.safeParse({ amount_minor: 1150.5, currency: "UGX" }).success, false);
    assert.equal(Money.safeParse({ amount_minor: 1150, currency: "UGX" }).success, true);
  });

  test("currency must be ISO 4217", () => {
    assert.equal(Money.safeParse({ amount_minor: 1, currency: "shillings" }).success, false);
  });
});

/* ── the envelope invariants ──────────────────────────────────────────── */

describe("envelope — spec §4", () => {
  const body = {
    kind: "person",
    display_name: "A. Farmer",
  };

  test("acting on behalf of another party requires a delegation", () => {
    const impersonation = Party.safeParse({
      ...envelope({ on_behalf_of: uuid(3) }),
      type: "party",
      record_class: "observation",
      ...body,
    });
    assert.equal(
      impersonation.success,
      false,
      "on_behalf_of without a delegation is an unbounded impersonation primitive",
    );
  });

  test("with a delegation it is accepted", () => {
    const ok = Party.safeParse({
      ...envelope({ on_behalf_of: uuid(3), delegation: uuid(4) }),
      type: "party",
      record_class: "observation",
      ...body,
    });
    assert.equal(ok.success, true, JSON.stringify(ok.error?.issues));
  });

  test("asserted_by is mandatory", () => {
    const e = envelope() as Record<string, unknown>;
    delete e["asserted_by"];
    assert.equal(
      Party.safeParse({ ...e, type: "party", record_class: "observation", ...body })
        .success,
      false,
    );
  });

  test("occurred_at_precision has no default and must be stated", () => {
    const e = envelope() as Record<string, unknown>;
    delete e["occurred_at_precision"];
    assert.equal(
      Party.safeParse({ ...e, type: "party", record_class: "observation", ...body })
        .success,
      false,
      "precision must be explicit — manufactured precision poisons every downstream analytic",
    );
  });

  test("a record cannot supersede itself", () => {
    assert.equal(
      Party.safeParse({
        ...envelope({ supersedes: uuid(1) }),
        type: "party",
        record_class: "observation",
        ...body,
      }).success,
      false,
    );
  });
});

/* ── the quarantine ───────────────────────────────────────────────────── */

describe("inference quarantine — spec §6", () => {
  const prediction = {
    ...envelope({ id: uuid(50) }),
    type: "inference",
    record_class: "inference",
    model_id: "yield.maize.ug",
    model_version: "1.4.2",
    inference_type: "yield.predicted",
    subject_type: "planting",
    subject_ref: uuid(60),
    inputs: [uuid(61)],
    output: { kind: "scalar", value: 1380, unit: "kg" },
    confidence: 0.62,
    inference_depth: 0,
  };

  test("a valid inference parses", () => {
    const ok = Inference.safeParse(prediction);
    assert.equal(ok.success, true, JSON.stringify(ok.error?.issues));
  });

  test("an inference cannot be written as a harvest", () => {
    const smuggled = Harvest.safeParse({
      ...prediction,
      type: "harvest",
      plot: uuid(70),
      crop: "crop.maize.grain",
      quantity: kg(1380),
    });
    assert.equal(
      smuggled.success,
      false,
      "record_class is a pinned literal — a model output cannot enter the fact log",
    );
  });

  test("a fact cannot be written into the inference namespace", () => {
    const misfiled = Inference.safeParse({ ...prediction, record_class: "observation" });
    assert.equal(misfiled.success, false);
  });

  test("an inference must name every input it was computed from", () => {
    assert.equal(
      Inference.safeParse({ ...prediction, inputs: [] }).success,
      false,
      "an inference that cannot name its inputs is not reproducible",
    );
  });

  test("only observations are eligible for training", () => {
    assert.equal(isTrainingEligible({ record_class: "observation" }), true);
    assert.equal(isTrainingEligible({ record_class: "inference" }), false);
  });

  test("chained inference depth is flagged", () => {
    assert.equal(exceedsRecommendedDepth({ inference_depth: 1 }), false);
    assert.equal(exceedsRecommendedDepth({ inference_depth: 2 }), true);
  });
});

/* ── the underwritable record ─────────────────────────────────────────── */

describe("delivery — spec §5.11", () => {
  const base = {
    ...envelope({ id: uuid(100) }),
    type: "delivery",
    record_class: "observation",
    from_party: uuid(101),
    to_party: uuid(102),
    commodity: "crop.maize.grain",
    quantity: {
      raw_value: 12,
      raw_unit: "bag",
      raw_unit_label: "kaveera",
      normalized_kg: 1416,
      conversion_id: uuid(103),
      measurement_method: "coop_weighed",
    },
    location: uuid(104),
    agreed_price: { amount_minor: 1150, currency: "UGX" },
  };

  test("an unconfirmed delivery is valid but unconfirmed", () => {
    const r = Delivery.safeParse(base);
    assert.equal(r.success, true, JSON.stringify(r.error?.issues));
    assert.equal(r.success && r.data.counterparty_confirmed_at, null);
  });

  test("a two-sided confirmation is what makes it evidence", () => {
    const r = Delivery.safeParse({
      ...base,
      counterparty_confirmed_at: "2026-07-18T14:35:02+03:00",
      counterparty_confirmed_by: uuid(101),
    });
    assert.equal(r.success, true, JSON.stringify(r.error?.issues));
    assert.notEqual(r.success && r.data.counterparty_confirmed_at, null);
  });

  test("there is no wallet, balance, or fund-holding entity in the schema", async () => {
    const mod = await import("../src/index.js");
    const forbidden = ["Wallet", "Balance", "Ledger", "FundsHeld", "AccountBalance"];
    for (const name of forbidden) {
      assert.equal(
        name in mod,
        false,
        `${name} must not exist — ClyCites is non-custodial by design (spec §5.14)`,
      );
    }
  });
});

/* ── land tenure ──────────────────────────────────────────────────────── */

describe("plot — spec §5.6", () => {
  test("the schema says held_by, never owned_by", async () => {
    const { Plot } = await import("../src/index.js");
    const shape = (Plot as unknown as { def: { shape: Record<string, unknown> } });
    const keys = Object.keys((shape.def?.shape ?? {}) as Record<string, unknown>);
    assert.equal(keys.includes("owned_by"), false, "ownership is a legal claim we cannot substantiate");
  });
});
