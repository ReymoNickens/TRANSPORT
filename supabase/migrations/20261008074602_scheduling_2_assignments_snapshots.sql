-- Phase C: scheduling, part 2 of 7 (spec 9.1, 9.2, 9.8, 10.4, 10.10, 15.1, 23.1, D16, D23).
-- Row-level security, grants and audit for these tables are set in part 6.

-- ---------------------------------------------------------------------------
-- Vehicle assignments (9.8, 10.4, invariants 11.8 #3 and #4)
-- ---------------------------------------------------------------------------

create table app.vehicle_assignments (
  id uuid primary key default app.uuid_v7(),
  organisation_id uuid not null,
  journey_id uuid not null,
  vehicle_id uuid not null,
  state text not null default 'ACTIVE' check (state in ('ACTIVE', 'REPLACED', 'CANCELLED')),
  -- The bus is busy from departure until arrival plus the turnaround buffer (D16).
  occupied_during tstzrange not null check (not isempty(occupied_during)),
  -- Null: no reason given (for example the schedule's default bus).
  reason text check (length(reason) <= 300),
  -- Null: assigned by the system.
  assigned_by uuid,
  assigned_at timestamptz not null default now(),
  -- Null while ACTIVE.
  ended_at timestamptz,
  unique (organisation_id, id),
  foreign key (organisation_id, journey_id) references app.journeys (organisation_id, id),
  foreign key (organisation_id, vehicle_id) references app.vehicles (organisation_id, id),
  foreign key (organisation_id, assigned_by) references app.users (organisation_id, id),
  check ((state = 'ACTIVE') = (ended_at is null)),
  -- No bus is ever on two journeys at once, turnaround included.
  constraint vehicle_assignments_no_overlap
    exclude using gist (vehicle_id with =, occupied_during with &&) where (state = 'ACTIVE')
);

-- A journey has at most one ACTIVE assignment.
create unique index vehicle_assignments_one_active on app.vehicle_assignments (journey_id) where state = 'ACTIVE';

create function app.vehicle_assignments_before_update() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.state <> 'ACTIVE' then
    perform app.fail('A replaced or cancelled bus assignment cannot change.');
  end if;
  if new.journey_id <> old.journey_id or new.vehicle_id <> old.vehicle_id then
    perform app.fail('Assign a different bus instead of editing an assignment.');
  end if;
  if new.state <> 'ACTIVE' then
    new.ended_at := coalesce(new.ended_at, now());
  end if;
  return new;
end
$$;

create trigger vehicle_assignments_before_update before update on app.vehicle_assignments
  for each row execute function app.vehicle_assignments_before_update();

-- ---------------------------------------------------------------------------
-- Seat and fare snapshots (10.4, 10.10)
-- ---------------------------------------------------------------------------

create table app.journey_seats (
  id uuid primary key default app.uuid_v7(),
  organisation_id uuid not null,
  journey_id uuid not null,
  -- The layout seat it was copied from, kept for traceability.
  source_seat_id uuid,
  seat_number text not null,
  seat_type text not null check (seat_type in ('standard', 'premium', 'accessible')),
  row_number int not null check (row_number >= 1),
  column_number int not null check (column_number >= 1),
  -- Null: not specified on the layout.
  position text check (position in ('window', 'aisle', 'middle')),
  -- BOOKABLE or BLOCKED only. A reservation is never stored here (seat claims, phase D).
  state text not null check (state in ('BOOKABLE', 'BLOCKED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organisation_id, id),
  unique (organisation_id, journey_id, id),
  unique (journey_id, seat_number),
  unique (journey_id, row_number, column_number),
  foreign key (organisation_id, journey_id) references app.journeys (organisation_id, id),
  foreign key (organisation_id, source_seat_id) references app.seats (organisation_id, id)
);

-- Seats are copied while the journey is a draft. After that only a seat's
-- BOOKABLE/BLOCKED state may change, until the journey is finished.
create function app.journey_seats_guard() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_state text;
begin
  select state into v_state from app.journeys where id = coalesce(new.journey_id, old.journey_id);
  if tg_op in ('INSERT', 'DELETE') then
    if v_state <> 'DRAFT' then
      perform app.fail('The seat map of a journey on sale cannot be replaced. Change its bus with the vehicle change procedure.');
    end if;
    return coalesce(new, old);
  end if;
  if (new.journey_id, new.source_seat_id, new.seat_number, new.seat_type, new.row_number, new.column_number, new.position)
     is distinct from
     (old.journey_id, old.source_seat_id, old.seat_number, old.seat_type, old.row_number, old.column_number, old.position) then
    perform app.fail('A journey''s seats are a snapshot. Only blocking or unblocking a seat is allowed.');
  end if;
  if v_state in ('DEPARTED', 'COMPLETED', 'CANCELLED') then
    perform app.fail('Seats cannot be blocked or unblocked after the journey has left.');
  end if;
  return new;
end
$$;

create trigger journey_seats_guard before insert or update or delete on app.journey_seats
  for each row execute function app.journey_seats_guard();

create table app.journey_fares (
  id uuid primary key default app.uuid_v7(),
  organisation_id uuid not null,
  journey_id uuid not null,
  route_id uuid not null,
  origin_stop_id uuid not null,
  destination_stop_id uuid not null,
  seat_type text not null check (seat_type in ('standard', 'premium', 'accessible')),
  amount_pesewas bigint not null check (amount_pesewas > 0),
  currency char(3) not null,
  -- The fare table and rule copied from, kept for traceability.
  source_template_id uuid not null,
  source_fare_rule_id uuid not null,
  created_at timestamptz not null default now(),
  unique (organisation_id, id),
  unique (journey_id, origin_stop_id, destination_stop_id, seat_type),
  foreign key (organisation_id, route_id, journey_id) references app.journeys (organisation_id, route_id, id),
  foreign key (organisation_id, route_id, origin_stop_id) references app.route_stops (organisation_id, route_id, id),
  foreign key (organisation_id, route_id, destination_stop_id) references app.route_stops (organisation_id, route_id, id),
  foreign key (organisation_id, route_id, source_template_id) references app.fare_templates (organisation_id, route_id, id),
  foreign key (organisation_id, source_fare_rule_id) references app.fare_rules (organisation_id, id)
);

-- Fare snapshots are written once, when the journey goes on sale, and never changed (spec 27.4).
create trigger journey_fares_immutable before update or delete on app.journey_fares
  for each row execute function app.refuse_change();

create function app.journey_fares_before_insert() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (select state from app.journeys where id = new.journey_id) <> 'DRAFT' then
    perform app.fail('Fares are copied once, when the journey goes on sale.');
  end if;
  return new;
end
$$;

create trigger journey_fares_before_insert before insert on app.journey_fares
  for each row execute function app.journey_fares_before_insert();

-- ---------------------------------------------------------------------------
-- Journey staff (10.4): nobody is on two journeys that overlap in time.
-- ---------------------------------------------------------------------------

create table app.journey_staff (
  id uuid primary key default app.uuid_v7(),
  organisation_id uuid not null,
  journey_id uuid not null,
  user_id uuid not null,
  staff_role text not null check (staff_role in ('driver', 'conductor')),
  -- The journey's scheduled time, so overlapping duties are refused.
  occupied_during tstzrange not null check (not isempty(occupied_during)),
  -- Null: assigned by the system.
  assigned_by uuid,
  assigned_at timestamptz not null default now(),
  -- Null while on the journey.
  removed_at timestamptz,
  -- Null: not removed, or removed by the system.
  removed_by uuid,
  unique (organisation_id, id),
  foreign key (organisation_id, journey_id) references app.journeys (organisation_id, id),
  foreign key (organisation_id, user_id) references app.users (organisation_id, id),
  foreign key (organisation_id, assigned_by) references app.users (organisation_id, id),
  foreign key (organisation_id, removed_by) references app.users (organisation_id, id),
  constraint journey_staff_no_overlap
    exclude using gist (user_id with =, occupied_during with &&) where (removed_at is null)
);

create unique index journey_staff_once_per_journey on app.journey_staff (journey_id, user_id) where removed_at is null;
create index journey_staff_by_user on app.journey_staff (user_id) where removed_at is null;

create function app.journey_staff_before_write() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if not exists (select 1 from app.users where id = new.user_id and kind = 'staff' and status = 'active') then
      perform app.fail('Only active staff can be put on a journey.');
    end if;
    return new;
  end if;
  if old.removed_at is not null then
    perform app.fail('A removed crew assignment cannot change.');
  end if;
  if new.journey_id <> old.journey_id or new.user_id <> old.user_id or new.staff_role <> old.staff_role then
    perform app.fail('Remove the person and assign again instead of editing the assignment.');
  end if;
  return new;
end
$$;

create trigger journey_staff_before_write before insert or update on app.journey_staff
  for each row execute function app.journey_staff_before_write();

