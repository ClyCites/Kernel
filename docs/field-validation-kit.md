# ClyCites — Field Validation Kit

**For:** four cooperative visits + one lender conversation
**Timebox:** two weeks
**Purpose:** find out whether the fourteen entities describe anything real, and produce the
conversion data the kernel cannot invent.

---

## What this is for

Spec §13 says the schema is a hypothesis and should not be frozen from a desk. This is how you
test it. Three outputs:

1. **Photographs of the paper** — every field on a form someone already fills in by hand is an
   input that cleared a much higher bar than one we imagined.
2. **Measured conversion factors** — real weights for local units, so `UnitConversion` rows can
   carry `basis: "measured"` instead of `assumed_default`.
3. **Answers to four open decisions** — D2 (duplicates), D5 (seasons), D7 (delegation scope),
   D8 (observation types).

You are not selling. You are not demoing. See §7.

## 1. Who to visit

Four cooperatives. The selection matters more than the count.

| Criterion | Why |
| --- | --- |
| Four **different districts** | Conversion factors and season calendars vary regionally. Four coops in Wakiso tell you about Wakiso. |
| At least **two different commodities** | A bag of maize is not a bag of beans. Coffee, matoke, and grain have different handling entirely. |
| At least **one badly run coop** | Well-organised coops are unrepresentative. The messy one tells you what the schema has to tolerate. |
| At least **one that already sells to a formal buyer** | WFP, a processor, an exporter. That is where Agreements and two-sided confirmation actually exist on paper. |

Use whatever warm intros you have — that beats cold-calling a better-fitting coop. District
agricultural officers and existing farmer-group networks are the usual route in.

## 2. What to photograph

Ask for everything, photograph what they'll let you. The layout, the crossings-out, and the
margin notes are data — a field people keep correcting is a field that matters.

- **Delivery / receiving book** — the single most important document
- **Member register**
- **Weighbridge or scale slips**
- **Input loan or credit cards**
- **Any contract or offtake agreement**
- **Payment records** — how they record that a farmer was paid
- **Store or stock cards**
- **Anything taped to the wall.** Price boards, conversion charts, grading posters. Wall
  artefacts are the coop's real reference data.

For each form, note: who fills it in, when, who else sees it, and what happens when it is wrong.

**Privacy.** These pages carry farmers' names, phone numbers, and sometimes NINs. Under the Data
Protection and Privacy Act you need a lawful basis to hold that. Practical approach: ask the
coop manager's permission explicitly, photograph blank or old forms where possible, blur names
before the images leave your phone, and do not upload anything to a shared drive. If a form is
only useful with real data on it, note the *field names* rather than keeping the image.

## 3. The weighing exercise — do not skip this

This is the part that directly unblocks the kernel.

**Bring a hanging scale.** A 200kg digital crane scale is inexpensive and is the single most
valuable object in your bag.

At each site, for each local unit in use:

- Weigh **at least ten** filled containers, not one
- Record every weight, not the average — the **variance** is the finding
- Note the commodity, the container type, and the local name for it
- Note whether it was packed loose or tight, and whether it had been dried

| Field | Example |
| --- | --- |
| District | |
| Commodity | maize grain |
| Unit as spoken | kaveera |
| Unit type | bag |
| Weights (10+) | 96, 103, 99, 101, … |
| Packed | tight / loose |
| Dried | yes / no / partly |
| Who says this is standard | coop manager / buyer / nobody |

Ten weights per unit per commodity per district gives you `UnitConversion` rows with
`basis: "measured"` and a defensible factor. Everything else in the registry stays
`assumed_default`, and the metric on `/metrics` tells you how much of your tonnage rests on
guesses.

Ask separately: **has the bag weight changed in the last few years?** If yes, you need
`valid_from` / `valid_to` populated, not just a factor.

## 4. Interview guide

Eight questions. Ask them conversationally, not as a form. Follow tangents — the tangents are
usually where the finding is.

**1. Walk me through what happens when a farmer arrives with produce.**
Open, first, and do not interrupt. You are looking for steps that are not in the schema.

**2. Who is allowed to sign or record for a farmer, and how does that person get that
authority?** *(Open decision D7.)*
If the answer is "it's just understood" or "whoever is at the desk," then `Delegation` as
specified invents a ceremony nobody performs, and the model needs rework.

**3. What happens when two farmers have the same name?** *(D2.)*
Their existing practice tells you whether to merge or link. If they use a member number, ask to
see how it is assigned and whether it is ever reused.

**4. What do you call the growing seasons here, and when do they start?** *(D5.)*
Whether there is a shared vocabulary, and whether it is regional.

**5. When the weights don't add up at the end of the season, what do you do?**
The realistic mass-balance discrepancy, and whether losses are recorded at all or just absorbed.

**6. Show me a time this record was wrong. What happened next?**
The correction workflow. This tests supersession against reality.

**7. What do you measure that isn't on any of these forms?** *(D8.)*
Moisture, colour, insect damage, dryness by bite test. Candidate `observation_type` entries.

**8. If a bank asked you to vouch for a farmer's production, what would you show them?**
The most important question in the set. It tells you what a coop believes is credible evidence,
which is the whole thesis in one answer.

## 5. The lender conversation

Separate visit. One credit officer at a SACCO, microfinance institution, or an agri-lending bank.

Bring a printed copy of the Appendix A delivery record from the spec. Ask exactly this:

> **Would you lend against this? If not, what is missing?**

Then shut up and write down everything they say.

Follow-ups if the conversation allows:

- What do you do today to assess a farmer?
- What does it cost you when you get it wrong?
- Would a guarantor still be required if you had two years of this?

**If the answer is "we'd need a guarantor regardless of the data," the credit thesis needs
rework**, and finding that out in August is worth more than the entire kernel.

## 6. What to bring

- Hanging scale (200kg) and a spare battery
- Phone with plenty of storage, plus a power bank
- Printed Appendix A record for the lender
- Notebook — write down what people say, not your interpretation
- Something for the coop's time: transport reimbursement, or lunch. Do not turn up empty-handed.

## 7. What not to do

- **Do not demo the software.** You will get politeness instead of information, and they will
  start describing what they think you want.
- **Do not pitch.** You are asking for help understanding their work.
- **Do not promise anything** — not a pilot, not a payment, not a feature. A promise you cannot
  keep costs you the relationship and the district.
- **Do not correct them** when their practice contradicts the schema. That contradiction is the
  finding. Write it down and move on.
- **Do not collect farmer personal data** you have no lawful basis to hold. §2.

## 8. What to bring back

One document per coop, plus one summary:

- Photographs, organised by coop and form type
- The weighing table, raw weights included
- Answers to the eight questions, quoted where possible
- **A field list**: every field appearing on their forms, marked as appearing at 4, 3, 2, or 1
  of the sites

Then apply the §13 test:

| Appears at | Verdict |
| --- | --- |
| All four | Core |
| Two or three | Extension |
| One | Extension, low priority |
| None — but is in our spec | **Justify or cut** |

That last row is the one to be honest about. A field in spec v0.2 that appears on no real form
is a field we invented, and the burden is on us.

---

## Then

Two more things only you can do, both cheap and both parallel:

- **One lawyer's hour** on D3 (erasure versus append-only) and D9 (legal weight of Agreement).
  Both can force schema changes, and both are expensive to guess.
- **The resourcing question.** Fourteen entities, offline sync, and seven applications is not a
  nights-and-weekends scope. Grant, raise, or cofounder — the funding shape decides whether you
  build for a pilot or for a standard, and it is a design input, not an afterthought.
