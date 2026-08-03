# Data sources

Where the seed corpus gets its numbers, and — more importantly — where it does
not.

The seed is fabricated data. Public statistics make it *realistic*; they do not
make it *verified*, and nothing in this file changes the fact that every record
the seed writes carries `dataset: 'seed'` and is invisible to a `live` read. See
[0017](decisions/0017-dataset-discriminator.md).

Three rules govern everything below, and they are not style preferences.

1. **No public figure ever becomes `basis: 'measured'`.** `measured` means
   somebody put a container on a scale and the weights are on file;
   `unit_conversion_measured_shows_sample` in migration 0012 enforces the
   sample. A national mean from a publication is
   `published_standard` when there is a citable standards body behind it and
   `assumed_default` otherwise. Synthesising a `sample` array from a published
   mean would be fabricating provenance, which is the exact fraud the schema
   exists to detect.
2. **A distribution nobody can trace back is indistinguishable from an invented
   one.** So the invented ones say so, in this file and in the code.
3. **No source here closes an open decision.** D2, D5, D7 and D8 are questions
   about cooperative practice. No dataset records practice.

## What was actually obtained

Checked on 2026-08-03. "Obtained" means downloaded and parsed in this
repository's toolchain, not "exists on a website".

| Source | Status | Informs |
| --- | --- | --- |
| FAOSTAT QCL bulk (Africa) | **Obtained** | Yield per crop |
| FAO GIEWS Uganda Country Brief | **Obtained** | Season calendar, planting and harvest offsets |
| Uganda National Panel Survey (LSMS-ISA) | **Not obtained** — login required | Nothing |
| UBOS | **Not obtained** — nothing machine-retrievable found | Nothing |
| IFPRI Dataverse | Open, but holds nothing relevant | Nothing |

### FAOSTAT — Crops and livestock products (QCL)

- **Publisher** FAO, Food and Agriculture Organization of the United Nations
- **Retrieved** 2026-08-03, from the bulk download, which needs no key
- **URL** <https://bulks-faostat.fao.org/production/Production_Crops_Livestock_E_Africa.zip>
- **Dataset last updated** 2025-12-23
- **Licence** CC BY 4.0, under the FAO Statistical Database Terms of Use,
  <https://www.fao.org/contact-us/terms/db-terms-of-use/en/>
- **Citation** FAO. 2025. FAOSTAT: Crops and livestock products. Accessed on
  3 August 2026. <https://www.fao.org/faostat/en/#data/QCL> Licence: CC-BY-4.0.

Figures used, Uganda, element `Yield`, unit kg/ha:

| Item | 2022 | 2023 | 2024 |
| --- | --- | --- | --- |
| Maize (corn) | 2199.6 | 2182.3 | **2173.9** |
| Beans, dry | 799.8 | 853.9 | **918.8** |

The 2024 figures are the ones the seed uses. They inform
`NATIONAL_YIELD_KG_PER_HA` in `apps/kernel/src/seed/fixtures.ts`, which sets the
size of every `harvest` record.

**Read this before using the number.** FAOSTAT's `Area harvested` counts area
actually harvested, so land in a bimodal-rainfall district that is cropped and
harvested twice in one year is counted twice. `Production ÷ Area harvested` is
therefore a *per-harvest* yield already, and the seed applies it to a single
season without adjustment. Sense check: 2173.9 kg/ha × 0.404686 ha/acre ≈ 880 kg
per acre, or about nine 100 kg bags — which is where Ugandan smallholder maize is
usually quoted. If that reading is wrong, every harvest in the corpus is out by
roughly a factor of two, and this paragraph is where to start looking.

**Two limits on the figure itself.** It is a national annual mean, so it carries
no district variation — Kapchorwa and Nebbi get the same central value, and the
spread around it is invented. And FAO's additional terms prohibit use "for or in
conjunction with the promotion of a commercial enterprise", which is a live
constraint for a commercial product: it is fine as a seed parameter, and it is
not fine in a sales deck.

### FAO GIEWS — Uganda Country Brief

- **Publisher** FAO Global Information and Early Warning System
- **Reference date** 2026-05-08, retrieved 2026-08-03
- **URL** <https://www.fao.org/giews/countrybrief/country.jsp?code=UGA>,
  PDF at <https://www.fao.org/giews/countrybrief/country/UGA/pdf/UGA.pdf>
- **Licence** CC BY-NC-SA 3.0 IGO (FAO web content terms,
  <https://www.fao.org/contact-us/terms/en/>)

Two statements are used verbatim as calendar facts:

- Bimodal rainfall areas, covering most of the country: first season crops
  "were planted in February and March 2026, and will be harvested in June and
  July". The first rainy season "normally extend[s] from March to June".
- Karamoja, unimodal, in the northeast: the rainy season "normally spans from
  April to August".

These inform `registry.season_calendar` (migration 0018) and the day offsets in
`DAY` in `apps/kernel/src/seed/generate.ts`.

**What is missing and stays missing.** This issue of the brief says nothing
about the second season. So `registry.season_calendar` has no `2026B` row, and
the read API returns nothing for it rather than a plausible guess. That gap is
the point of the table: filling it later is an INSERT with a citation, not a
migration.

### Uganda National Panel Survey (LSMS-ISA) — not obtained

- **Publisher** Uganda Bureau of Statistics, distributed by the World Bank
- **Study** UGA_2019_UNPS_v03_M, National Panel Survey 2019-2020
- **URL** <https://microdata.worldbank.org/index.php/catalog/3902>
- **DOI** <https://doi.org/10.48529/nqzx-f196>

This is by a distance the best source for the parameters that are still
invented: plot area by region, crop mix, household composition, plot-level
yield. It was not obtained. `…/get-microdata` returns "To access data for this
study, user must be logged in", and registration is a manual, approved process
rather than a click-through. The public DDI export
(`/metadata/export/3902/json`) carries the study description only — no
variable-level summary statistics, so there is not even an indirect route to a
mean.

**This is a finding, not a task.** Someone with an account should pull the
agriculture module and revisit the invented distributions below. Until then they
stay marked invented.

### UBOS — not obtained

- **URL** <https://www.ubos.org/explore-statistics/agriculture/>

Reachable, and no agricultural table is retrievable without a browser: the
agriculture landing page links no data files, and site search is client-side.
The Statistical Abstract and the Annual Agricultural Survey are cited widely
enough that they clearly exist; neither was found at a stable URL from here.

### IFPRI Dataverse — open, and not relevant

- **URL** <https://dataverse.harvard.edu/dataverse/IFPRI>

The search API is open and works. Uganda holdings are dominated by ASTI, which
is agricultural *research and development spending* — nothing about plots,
yields or cooperative structure. Recorded so the next person does not spend the
same hour.

## Parameters that are still invented

Every one of these is a number somebody made up, including the spread around the
values that do have a citation. They are listed so that "seeded from public
data" cannot be said about the corpus as a whole.

| Parameter | Where | Why it is invented |
| --- | --- | --- |
| Plot area, and area planted | `generate.ts`, `rng.normalWithin(1.2, 0.6, …)` acres | UNPS is the source and is gated |
| Variation around the national yield | `HARVEST_YIELD_SPREAD` | FAOSTAT publishes a mean, not a distribution |
| Crop mix by region | one commodity per coop, in `COOPS` | No district-level source obtained |
| Cooperative membership size | 20 farmers per coop | No source; chosen to keep the corpus legible |
| Deliveries per farmer, and their size | `rng.int(2, 3)`, `rng.int(3, 14)` bags | No source |
| Confirmation rate, mass-balance drift | `COOPS` | Deliberate fixture defects, per [0023](decisions/0023-adversarial-seed.md) |
| Bag weights and their spread | `COOPS.bagMean`, `bagStddev` | Deliberate fixture defects |
| Proportion of farmers holding a NIN | 0.65 | No source |
| Clock-skew rates | 0.05 and 0.01 | No source |

The adversarial cases in the last three rows are **not** candidates for
replacement with real data. Coop C's factor is wrong by eighteen percent because
a work order says it must be; that is a defect the corpus is built around, not a
distribution to be improved.
