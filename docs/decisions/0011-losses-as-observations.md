# 0011 — A declared loss is an Observation, not a field

## Status

Accepted.

## Context

Mass balance across a custody chain does not close. A hundred kilograms leave
the farm and ninety-four arrive at the store. The missing six are real:
moisture, spillage, shrinkage, theft, a bag that split.

The obvious move is a `declared_losses` field on Lot or CustodyTransfer, and it
was proposed. It is the wrong shape.

## Decision

**A declared loss is an `Observation`:**

```json
{
  "type": "observation",
  "subject_type": "lot",
  "subject_ref": "<lot id>",
  "observation_type": "loss.declared",
  "value": { "kind": "quantity", "value": { "raw_value": 6, "raw_unit": "kg", ... } },
  "method": "reported"
}
```

`loss.declared` is registered in `registry.observation_type` with
`value_kind: 'quantity'` and `subject_types: {lot}`.

## Why not a field

**A field has no author.** Every record in the log carries `asserted_by`, an
`occurred_at`, a delegation chain and quality flags. A number in a field on
someone else's record has none of that. A loss is exactly the kind of claim
where *who said so* is the whole question — the transporter and the buyer will
not agree about six kilograms, and both should be able to say so.

**A field has one value.** Two parties can each observe a loss on the same lot,
and both observations stand. A field forces one of them to win at write time,
which is the mutable-state failure this kernel exists to avoid.

**A field cannot be retracted or superseded independently.** With an
Observation, a farmer who mis-stated a loss supersedes that observation and
leaves the harvest record alone. With a field, correcting the loss means
rewriting the record that carries it.

**A field cannot be flagged.** `method: "reported"` on an Observation is
visibly weaker evidence than `field_instrument`. A bare number in a field
carries no such signal, and a reader has no way to tell a weighed loss from a
guessed one.

**A field would need a reason enum, and that enum would be wrong.** Spillage,
theft, moisture and shrinkage are not a closed set, and the kernel does not get
to decide the vocabulary of what goes wrong on a Ugandan farm road.
`observation_type` is a governed namespace and can grow without a schema
version bump.

## Consequences

- **No schema change.** `@clycites/schema` already expresses this. That is a
  point in its favour, not a coincidence.
- **Mass balance reads losses as records.** The balance check sums
  `loss.declared` observations against the custody chain rather than reading a
  field. Deliberately not implemented here — see the mass balance work.
- **A loss is claimed, never inferred.** The kernel does not manufacture a loss
  observation from a shortfall. An unexplained shortfall is a flag
  (`mass_balance_discrepancy`); calling it a loss would be the kernel asserting
  a fact it did not witness, which is the observation/inference boundary.
- **`loss.declared` costs a registry row, not a deploy of the schema package.**
  Adding `loss.spoilage` later is the same.
