-- 0034 - Field-client confirmation requests and privacy-safe product signals.
--
-- Confirmation requests are mutable delivery bookkeeping for an external USSD
-- worker. Field events are append-only counters with a closed vocabulary and
-- cannot carry names, phone numbers, record ids, or free text.

create table kernel.confirmation_request (
  id            uuid primary key,
  delivery      uuid not null,
  requested_by  uuid not null,
  client_id     text not null,
  dataset       text not null default 'live',
  status        text not null default 'queued',
  attempts      integer not null default 0,
  last_error    text null,
  requested_at  timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint confirmation_request_dataset_known
    check (dataset in ('live', 'seed')),
  constraint confirmation_request_status_known
    check (status in ('queued', 'sent', 'failed')),
  constraint confirmation_request_attempts_nonnegative check (attempts >= 0),
  constraint confirmation_request_error_bounded
    check (last_error is null or length(last_error) <= 500),
  unique (delivery, requested_by, dataset)
);

comment on table kernel.confirmation_request is
  'Operational outbox for a USSD worker. It never contains or receives a farmer PIN.';

create index confirmation_request_pending
  on kernel.confirmation_request (status, requested_at)
  where status in ('queued', 'failed');

create table kernel.field_event (
  id          uuid primary key,
  client_id   text not null,
  acting_for  uuid not null,
  event       text not null,
  choice      text not null,
  flow        text null,
  step        text null,
  recorded_at timestamptz not null default now(),

  constraint field_event_known check (
    event in (
      'delegation_basis', 'name_collision', 'season_label',
      'missing_field', 'flow_abandoned'
    )
  ),
  constraint field_event_choice_known check (
    choice in (
      'witnessed_in_person', 'ussd_confirmation', 'organisational_bylaw',
      'created_separate', 'same_as_linked', 'kept_separate',
      'registry_label', 'officer_label', 'no_label',
      'unsupported', 'abandoned'
    )
  ),
  constraint field_event_flow_known check (
    flow is null or flow in (
      'enrolment', 'delivery', 'confirmation', 'calibration', 'media', 'sync'
    )
  ),
  constraint field_event_step_bounded check (
    step is null or (length(step) between 1 and 80 and step ~ '^[a-z0-9_]+$')
  ),
  constraint field_event_shape check (
    (event = 'delegation_basis' and choice in (
      'witnessed_in_person', 'ussd_confirmation', 'organisational_bylaw'
    ) and flow is null and step is null)
    or (event = 'name_collision' and choice in (
      'created_separate', 'same_as_linked', 'kept_separate'
    ) and flow is null and step is null)
    or (event = 'season_label' and choice in (
      'registry_label', 'officer_label', 'no_label'
    ) and flow is null and step is null)
    or (event = 'missing_field' and choice = 'unsupported'
      and flow is not null and step is not null)
    or (event = 'flow_abandoned' and choice = 'abandoned'
      and flow is not null and step is not null)
  )
);

comment on table kernel.field_event is
  'Bounded field-client product signals. The schema deliberately has no payload or free-text column.';

create index field_event_metric
  on kernel.field_event (event, choice, flow, step);

grant select, insert, update on kernel.confirmation_request to kernel_app;
revoke delete, truncate on kernel.confirmation_request from kernel_app;

grant select, insert on kernel.field_event to kernel_app;
revoke update, delete, truncate on kernel.field_event from kernel_app;

create trigger field_event_append_only
  before update or delete on kernel.field_event
  for each row execute function kernel.client_append_only();