# Provenance and the trust ladder

**What it prevents: a lender treating a farmer's own estimate and a weighbridge
ticket as the same number.**

Both are "1,400 kg" in a spreadsheet. One was read off a certified scale; the
other was somebody looking at a heap and saying it looked like fourteen bags.
Averaged together they produce a figure that is worse than either, because the
uncertainty has been thrown away and cannot be recovered.

## Two questions, kept separate

Provenance in this kernel answers two different questions and never conflates
them:

1. **Who says so?** — `asserted_by`, `on_behalf_of`, `delegation`.
2. **How was it measured?** — `measurement_method`, on the quantity itself.

A cooperative officer with impeccable authority can assert a figure he eyeballed.
Authority and measurement are independent, and a system that collapses them will
over-trust an authoritative guess.

## The trust ladder

`measurement_method` is a closed vocabulary, ordered. The exact values are in
the [Enumerations reference](../reference/enumerations.md); what matters is the
ordering and the threshold:

- `self_reported` — the party's own account
- `field_estimated` — somebody's judgement on site
- `coop_weighed` — weighed on the cooperative's scale
- `counterparty_confirmed` — the other side agreed the figure
- `third_party_verified` — an independent party attested it

**`coop_weighed` is the underwritable threshold.** Anything below it is flagged
`measurement_below_underwritable`: usable for operations, not for lending
against. The threshold is a product decision with a test pinning it, not a
constant somebody can nudge.

There is deliberately **no value for model output**. Not `model_estimated`, not
`predicted`, not `inferred`. A test asserts those strings can never be
measurement methods, because a model's guess entering the fact log as a
measurement is the failure the
[inference quarantine](inference-quarantine.md) exists to prevent, and it would
enter here if a value allowed it.

## A blended figure inherits its weakest component

When several quantities are combined, the result takes the *lowest* method on
the ladder, not the highest and not the average. A lot assembled from one
weighbridge ticket and one farmer's estimate is a lot resting on a farmer's
estimate. Anything else lets a single good measurement launder several bad ones.

## Delegation

Somebody acting for another party must point at a delegation that was **live at
the moment the event occurred** — not live now. A mandate that expired last
month cannot retroactively authorise last year's records, and a mandate granted
today cannot authorise what happened before it existed. Delegations are resolved
at ingest, against `occurred_at`.

Delegation basis is itself part of the evidence:

| Basis | What it means |
|---|---|
| `in_person_signature` | Signed in front of somebody |
| `ussd_confirmation` | Confirmed from the party's own handset with a PIN |
| `witnessed` | Attested by a third party |
| `organisational_bylaw` | The cooperative's own rules, not an individual mandate |

`organisational_bylaw` is the weak one, and everything asserted under it carries
`delegated_by_organisational_bylaw` for life. It is how a cooperative can record
for a member who has no phone — necessary, and not the same as that member
saying so.

That distinction becomes load-bearing in
[two-sided confirmation](../flows/confirmation.md), where a delegated
confirmation is valid but explicitly not *independent*, and the lender view says
which it was.

## What provenance does not do

It does not make a record true. A cooperative officer with a valid delegation,
using a certified scale, can still write down the wrong number — and if he
does, the kernel stores it, flags nothing, and shows a lender a clean record.

What provenance buys is that the claim is **attributable**. Somebody's name is
on it, the basis of their authority is recorded, and the correction chain will
show if it was changed. That is the difference between a figure a lender can
argue with and a figure a lender can only accept or refuse.
