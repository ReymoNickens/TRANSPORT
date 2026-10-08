-- Phase C: scheduling, part 1 of 7 (spec 9.1, 9.2, 9.8, 10.4, 10.10, 15.1, 23.1, D16, D23).
-- Row-level security, grants and audit for these tables are set in part 6.
--
-- A schedule is recurring intent; a journey is a real, dated departure.
-- Journeys are generated from the schedule's current version, at most one per
-- schedule per day. A journey goes on sale (SCHEDULED) only with a bus, a seat
-- snapshot from that bus's published layout and a fare snapshot from the
-- route's live fare table. Snapshots never change once on sale.

-- btree_gist (for the overlap constraints) is installed by the previous migration.

-- A whole-number setting for an organisation.
create function app.setting_int(p_organisation_id uuid, p_key text) returns int
language sql stable
set search_path = ''
as $$
  select (value #>> '{}')::int from app.settings where organisation_id = p_organisation_id and key = p_key
$$;

-- ---------------------------------------------------------------------------
-- Schedules, versions and exceptions (10.4, 23.1)
-- ---------------------------------------------------------------------------

create table app.schedules (
  id uuid primary key default app.uuid_v7(),
  organisation_id uuid not null,
  route_id uuid not null,
  name text not null check (length(trim(name)) between 2 and 120),
  status text not null default 'active' check (status in ('active', 'paused', 'archived')),
  -- The version new journeys are generated from. Set by the database.
  current_version int not null default 0 check (current_version >= 0),
  -- Null: use the organisation's booking.open_days_before setting (D23).
  booking_open_days_before int check (booking_open_days_before between 1 and 365),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organisation_id, id),
  unique (organisation_id, route_id, id),
  foreign key (organisation_id, route_id) references app.routes (organisation_id, id),
  foreign key (organisation_id, created_by) references app.users (organisation_id, id)
);

create unique index schedules_name_per_organisation on app.schedules (organisation_id, lower(name)) where status <> 'archived';

-- Each edit is a new version; versions are never changed (23.1).
create table app.schedule_versions (
  id uuid primary key default app.uuid_v7(),
  organisation_id uuid not null,
  schedule_id uuid not null,
  version int not null check (version >= 1),
  -- Local time in the organisation's time zone.
  departure_time time not null,
  -- ISO days: 1 = Monday … 7 = Sunday.
  days_of_week smallint[] not null
    check (cardinality(days_of_week) between 1 and 7 and days_of_week <@ '{1,2,3,4,5,6,7}'::smallint[]),
  -- Null: no default bus; generated journeys wait as "needs a bus".
  default_vehicle_id uuid,
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (organisation_id, id),
  unique (schedule_id, version),
  foreign key (organisation_id, schedule_id) references app.schedules (organisation_id, id),
  foreign key (organisation_id, default_vehicle_id) references app.vehicles (organisation_id, id),
  foreign key (organisation_id, created_by) references app.users (organisation_id, id)
);

create function app.schedule_versions_before_insert() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  select coalesce(max(version), 0) + 1 into new.version from app.schedule_versions where schedule_id = new.schedule_id;
  return new;
end
$$;

create function app.schedule_versions_after_insert() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  update app.schedules set current_version = new.version where id = new.schedule_id;
  return null;
end
$$;

create trigger schedule_versions_before_insert before insert on app.schedule_versions
  for each row execute function app.schedule_versions_before_insert();
create trigger schedule_versions_after_insert after insert on app.schedule_versions
  for each row execute function app.schedule_versions_after_insert();
create trigger schedule_versions_immutable before update or delete on app.schedule_versions
  for each row execute function app.refuse_change();

create function app.schedules_before_update() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status = 'archived' then
    perform app.fail('An archived schedule cannot be changed.');
  end if;
  if new.route_id <> old.route_id then
    perform app.fail('A schedule cannot move to another route. Create a new schedule instead.');
  end if;
  if new.current_version < old.current_version then
    perform app.fail('A schedule cannot go back to an older version.');
  end if;
  return new;
end
$$;

create trigger schedules_before_update before update on app.schedules
  for each row execute function app.schedules_before_update();

-- Holidays and one-off changes (23.1 rule 4).
create table app.schedule_exceptions (
  id uuid primary key default app.uuid_v7(),
  organisation_id uuid not null,
  schedule_id uuid not null,
  service_date date not null,
  -- skip: no journey that day. move: a different time that day. extra: a run on a day the pattern skips.
  kind text not null check (kind in ('skip', 'move', 'extra')),
  -- Null for skip. The local departure time for move and extra.
  departure_time time,
  reason text not null check (length(trim(reason)) between 2 and 300),
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (organisation_id, id),
  unique (schedule_id, service_date),
  foreign key (organisation_id, schedule_id) references app.schedules (organisation_id, id),
  foreign key (organisation_id, created_by) references app.users (organisation_id, id),
  check ((kind = 'skip') = (departure_time is null))
);

-- ---------------------------------------------------------------------------
-- Journeys (9.2, 10.4, 10.10)
-- ---------------------------------------------------------------------------

create table app.journeys (
  id uuid primary key default app.uuid_v7(),
  organisation_id uuid not null,
  route_id uuid not null,
  -- Null for a one-off journey created by a manager.
  schedule_id uuid,
  -- The schedule version that generated it. Null for a one-off journey.
  schedule_version int,
  -- The date of service in the organisation's time zone.
  service_date date not null,
  scheduled_departure_at timestamptz not null,
  scheduled_arrival_at timestamptz not null,
  -- Null until it happens.
  actual_departure_at timestamptz,
  -- Null until it happens.
  actual_arrival_at timestamptz,
  delay_minutes int not null default 0 check (delay_minutes >= 0),
  -- When online booking opens (D23). Sales close is derived from the setting (D5), not stored.
  booking_opens_at timestamptz not null,
  state text not null default 'DRAFT'
    check (state in ('DRAFT', 'SCHEDULED', 'SALES_CLOSED', 'BOARDING', 'DEPARTED', 'COMPLETED', 'CANCELLED')),
  -- Null: not cancelled.
  cancelled_at timestamptz,
  -- Null: not cancelled.
  cancellation_reason text,
  -- Null: generated by the system.
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organisation_id, id),
  unique (organisation_id, route_id, id),
  foreign key (organisation_id, route_id) references app.routes (organisation_id, id),
  foreign key (organisation_id, schedule_id) references app.schedules (organisation_id, id),
  foreign key (organisation_id, created_by) references app.users (organisation_id, id),
  check (scheduled_arrival_at > scheduled_departure_at),
  check ((schedule_id is null) = (schedule_version is null)),
  check (booking_opens_at <= scheduled_departure_at),
  check ((state = 'CANCELLED') = (cancelled_at is not null)),
  check ((cancelled_at is null) = (cancellation_reason is null))
);

-- Generation can never make two journeys for one schedule on one day.
create unique index journeys_once_per_schedule_day on app.journeys (schedule_id, service_date) where schedule_id is not null;
create index journeys_by_date_state on app.journeys (organisation_id, service_date, state);
create index journeys_by_route_date on app.journeys (route_id, service_date);

-- Every journey move is recorded with who, when and why (9.1 rule 4). Append-only.
create table app.journey_events (
  id uuid primary key default app.uuid_v7(),
  organisation_id uuid not null,
  journey_id uuid not null,
  event_type text not null check (event_type in (
    'created', 'state_changed', 'vehicle_assigned', 'staff_assigned', 'staff_removed',
    'times_changed', 'delayed', 'stop_reached', 'note')),
  -- Null unless the event is a state change.
  from_state text,
  -- Null unless the event is a state change.
  to_state text,
  -- Null unless the event is a delay.
  delay_minutes int check (delay_minutes >= 0),
  -- Null unless the event happened at a stop.
  location_id uuid,
  -- Null: no note or reason.
  notes text check (length(notes) <= 1000),
  -- Null: recorded by the system.
  recorded_by uuid,
  occurred_at timestamptz not null default now(),
  unique (organisation_id, id),
  foreign key (organisation_id, journey_id) references app.journeys (organisation_id, id),
  foreign key (organisation_id, location_id) references app.locations (organisation_id, id),
  foreign key (organisation_id, recorded_by) references app.users (organisation_id, id)
);

create index journey_events_by_journey on app.journey_events (journey_id, occurred_at);

create trigger journey_events_immutable before update or delete on app.journey_events
  for each row execute function app.refuse_change();
create trigger journey_events_no_truncate before truncate on app.journey_events
  for each statement execute function app.refuse_change();

create function app.record_journey_event(
  p_journey_id uuid,
  p_event_type text,
  p_notes text default null,
  p_from_state text default null,
  p_to_state text default null,
  p_delay_minutes int default null,
  p_location_id uuid default null
) returns void
language sql
set search_path = ''
as $$
  insert into app.journey_events (organisation_id, journey_id, event_type, from_state, to_state, delay_minutes, location_id, notes, recorded_by)
  select j.organisation_id, j.id, p_event_type, p_from_state, p_to_state, p_delay_minutes, p_location_id,
         coalesce(p_notes, app.request_setting('reason')), app.current_actor_id()
  from app.journeys j where j.id = p_journey_id
$$;

