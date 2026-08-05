-- What an objection actually did, recorded where the application can read it.
--
-- FINDING, fixed here: an objection that stops nothing is not an error. It
-- appears in no error rate and in no alert, and the only place it was visible
-- was the audit log — which the application role deliberately cannot read
-- (0025), so a metric sourced from there fails with `permission denied for
-- table entry` and would have had to be given a grant that undoes the point of
-- the audit log.
--
-- So it is stored on the objection itself. This is a derived value frozen at
-- lodging time on purpose: the effect is a function of the records that existed
-- at that moment, and recomputing it later would answer a different question
-- from the one the subject was answered with.
--
-- A rising count of `stopped_nothing_consent_only` means people are being
-- offered a button marked "I object" when the act that would work is
-- withdrawal. That is a misleading interface operating at scale, and this
-- column is where it becomes visible.
--
-- SECOND FINDING, from writing this. The first attempt resolved the objection
-- after inserting it and filled this column with an UPDATE. The application
-- role refused: `permission denied for table objection`. That is invariant 1
-- doing its job — the objection table is append-only, and a column recording
-- what a subject was told is exactly the kind of thing that must not be
-- editable afterwards. The service now resolves before it inserts and writes
-- the row complete. The column stays nullable only for rows lodged before it
-- existed; nothing writes null.

alter table kernel.objection
  add column effect text null;

comment on column kernel.objection.effect is
  'What this objection stopped, as told to the subject at the time. Null on '
  'rows lodged before this column existed; never recomputed.';

alter table kernel.objection
  add constraint objection_effect_known check (
    effect is null or effect in (
      'stopped_some',
      'stopped_nothing_no_records',
      'stopped_nothing_out_of_scope',
      'stopped_nothing_consent_only',
      'stopped_nothing_exempt'
    )
  );

create index objection_by_effect on kernel.objection (effect, dataset)
  where effect is not null;
