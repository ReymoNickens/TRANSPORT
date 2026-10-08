-- Phase B: network, fleet and fares (spec 10.2, 10.3, 13.4a).
--
-- Things that are sold against (route stops, seat layouts, fare tables) are
-- edited only while they are drafts. To change a live one, copy it to a new
-- draft and publish that. So a published layout or fare table never changes
-- underneath a journey (spec 27.3, 27.4), and every version stays on record.

-- Business-rule violations carry SQLSTATE BR001 and a plain-English message
-- that the server may show to a manager as it is.
create function app.fail(p_message text) returns void
language plpgsql
set search_path = ''
as $$
begin
  raise exception using errcode = 'BR001', message = p_message;
end
$$;

-- ---------------------------------------------------------------------------
-- Locations: the controlled list of terminals, stations and stops (10.2)
-- ---------------------------------------------------------------------------

create table app.locations (
  id uuid primary key default app.uuid_v7(),
  organisation_id uuid not null references app.organisations (id),
  name text not null check (length(trim(name)) between 2 and 120),
  location_type text not null check (location_type in ('terminal', 'station', 'stop')),
  city text not null check (length(trim(city)) between 2 and 80),
  region text not null check (length(trim(region)) between 2 and 80),
  -- Null: no street address recorded.
  address text check (length(address) <= 300),
  -- Null (both): no map position recorded.
  latitude numeric(9, 6) check (latitude between -90 and 90),
  longitude numeric(9, 6) check (longitude between -180 and 180),
  -- Null: no description for passengers.
  description text check (length(description) <= 1000),
  -- Null: no contact number for this location.
  contact_phone text check (contact_phone ~ '^\+[1-9][0-9]{7,14}$'),
  status text not null default 'active' check (status in ('active', 'inactive')),
  -- Null: created by the system.
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organisation_id, id),
  foreign key (organisation_id, created_by) references app.users (organisation_id, id),
  check ((latitude is null) = (longitude is null))
);

create unique index locations_name_per_organisation on app.locations (organisation_id, lower(name));
create index locations_by_city on app.locations (organisation_id, lower(city)) where status = 'active';

-- ---------------------------------------------------------------------------
-- Routes and their ordered stops (10.2)
-- ---------------------------------------------------------------------------

create table app.routes (
  id uuid primary key default app.uuid_v7(),
  organisation_id uuid not null references app.organisations (id),
  name text not null check (length(trim(name)) between 2 and 120),
  origin_location_id uuid not null,
  destination_location_id uuid not null,
  -- Null: distance not measured. Duration is not stored: it is the last stop's arrival offset.
  distance_km numeric(7, 1) check (distance_km > 0),
  status text not null default 'draft' check (status in ('draft', 'active', 'archived')),
  -- Null: not activated yet.
  activated_at timestamptz,
  -- Null: not archived.
  archived_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organisation_id, id),
  foreign key (organisation_id, origin_location_id) references app.locations (organisation_id, id),
  foreign key (organisation_id, destination_location_id) references app.locations (organisation_id, id),
  foreign key (organisation_id, created_by) references app.users (organisation_id, id),
  check (origin_location_id <> destination_location_id),
  check ((status = 'draft') = (activated_at is null) or status = 'archived'),
  check ((status = 'archived') = (archived_at is not null))
);

create unique index routes_name_per_organisation on app.routes (organisation_id, lower(name)) where status <> 'archived';

create table app.route_stops (
  id uuid primary key default app.uuid_v7(),
  organisation_id uuid not null,
  route_id uuid not null,
  location_id uuid not null,
  sequence int not null check (sequence >= 1),
  -- Minutes after the journey's departure from the first stop.
  arrival_offset_minutes int not null check (arrival_offset_minutes between 0 and 2880),
  departure_offset_minutes int not null check (departure_offset_minutes between 0 and 2880),
  boarding_allowed boolean not null,
  dropoff_allowed boolean not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organisation_id, id),
  unique (organisation_id, route_id, id),
  -- Deferred so stops can be renumbered within one transaction.
  unique (route_id, sequence) deferrable initially deferred,
  unique (route_id, location_id),
  foreign key (organisation_id, route_id) references app.routes (organisation_id, id),
  foreign key (organisation_id, location_id) references app.locations (organisation_id, id),
  check (departure_offset_minutes >= arrival_offset_minutes),
  check (boarding_allowed or dropoff_allowed)
);

-- Stops change only while their route is a draft.
create function app.route_stops_guard() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_status text;
begin
  select status into v_status from app.routes where id = coalesce(new.route_id, old.route_id);
  if v_status <> 'draft' then
    perform app.fail('Stops can only be changed while the route is a draft. Copy the route to make changes to a live one.');
  end if;
  if tg_op = 'UPDATE' and new.route_id <> old.route_id then
    perform app.fail('A stop cannot move to another route.');
  end if;
  return coalesce(new, old);
end
$$;

create trigger route_stops_guard before insert or update or delete on app.route_stops
  for each row execute function app.route_stops_guard();

-- Route life cycle: draft → active → archived, or draft → archived. Activation
-- checks the stops (spec 10.2): the first stop is the origin and only boards,
-- the last is the destination and only drops off, sequences run 1..n and
-- times never go backwards.
create function app.routes_before_update() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_count int;
  v_max_sequence int;
  v_first record;
  v_last record;
  v_backwards int;
begin
  if old.status = 'archived' then
    perform app.fail('An archived route cannot be changed.');
  end if;
  if old.status <> 'draft' and (new.origin_location_id <> old.origin_location_id
      or new.destination_location_id <> old.destination_location_id) then
    perform app.fail('The origin and destination of a live route cannot change. Create a new route instead.');
  end if;
  if new.status = 'draft' and old.status <> 'draft' then
    perform app.fail('A live route cannot go back to draft.');
  end if;

  if new.status = 'active' and old.status = 'draft' then
    select count(*), max(sequence) into v_count, v_max_sequence from app.route_stops where route_id = new.id;
    if v_count < 2 then
      perform app.fail('A route needs at least two stops before it can go live.');
    end if;
    if v_max_sequence <> v_count then
      perform app.fail('Stop numbers must run 1, 2, 3 … without gaps.');
    end if;
    select * into v_first from app.route_stops where route_id = new.id and sequence = 1;
    select * into v_last from app.route_stops where route_id = new.id and sequence = v_count;
    if v_first.location_id <> new.origin_location_id then
      perform app.fail('The first stop must be the route''s origin.');
    end if;
    if v_last.location_id <> new.destination_location_id then
      perform app.fail('The last stop must be the route''s destination.');
    end if;
    if v_first.arrival_offset_minutes <> 0 then
      perform app.fail('The first stop''s time must be 0 minutes: it is where the journey starts.');
    end if;
    if not v_first.boarding_allowed or v_first.dropoff_allowed then
      perform app.fail('Passengers can only board at the first stop, not get off.');
    end if;
    if not v_last.dropoff_allowed or v_last.boarding_allowed then
      perform app.fail('Passengers can only get off at the last stop, not board.');
    end if;
    select count(*) into v_backwards
    from app.route_stops s
    join app.route_stops prev on prev.route_id = s.route_id and prev.sequence = s.sequence - 1
    where s.route_id = new.id and s.arrival_offset_minutes < prev.departure_offset_minutes;
    if v_backwards > 0 then
      perform app.fail('Each stop''s arrival time must be at or after the previous stop''s departure time.');
    end if;
    new.activated_at := now();
  end if;

  if new.status = 'archived' and old.status <> 'archived' then
    new.archived_at := now();
  end if;
  return new;
end
$$;

create trigger routes_before_update before update on app.routes
  for each row execute function app.routes_before_update();

-- ---------------------------------------------------------------------------
-- Vehicles, versioned seat layouts and seats (10.2)
-- ---------------------------------------------------------------------------

create table app.vehicles (
  id uuid primary key default app.uuid_v7(),
  organisation_id uuid not null references app.organisations (id),
  -- Stored upper case without spaces, for example GR-1234-22.
  registration text not null check (registration ~ '^[A-Z0-9][A-Z0-9-]{2,14}$'),
  -- Null: the organisation does not number this vehicle.
  fleet_number text check (length(trim(fleet_number)) between 1 and 20),
  -- Null: no nickname.
  name text check (length(trim(name)) between 1 and 60),
  vehicle_type text not null check (vehicle_type in ('coach', 'bus', 'minibus')),
  -- Null: not recorded.
  make text check (length(make) <= 60),
  -- Null: not recorded.
  model text check (length(model) <= 60),
  -- Null: not recorded.
  year int check (year between 1980 and 2100),
  -- Physical passenger seats. A published layout may not offer more bookable seats than this.
  capacity int not null check (capacity between 1 and 100),
  status text not null default 'active' check (status in ('active', 'maintenance', 'retired')),
  -- Null: no notes.
  notes text check (length(notes) <= 2000),
  -- Null: not retired.
  retired_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organisation_id, id),
  unique (organisation_id, registration),
  foreign key (organisation_id, created_by) references app.users (organisation_id, id),
  check ((status = 'retired') = (retired_at is not null))
);

create unique index vehicles_fleet_number on app.vehicles (organisation_id, fleet_number) where fleet_number is not null;

-- Retirement is final. Phase C adds: not while the vehicle has future journeys (spec 15.1).
create function app.vehicles_before_update() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status = 'retired' and new.status <> 'retired' then
    perform app.fail('A retired vehicle cannot return to service. Add it again as a new vehicle if needed.');
  end if;
  if new.capacity < old.capacity and exists (
    select 1 from app.seat_layouts l
    where l.vehicle_id = new.id and l.status = 'published'
      and (select count(*) from app.seats s where s.layout_id = l.id and s.bookable) > new.capacity
  ) then
    perform app.fail('The capacity cannot be lower than the bookable seats in the published seat layout.');
  end if;
  if new.status = 'retired' and old.status <> 'retired' then
    new.retired_at := now();
  end if;
  return new;
end
$$;

create table app.seat_layouts (
  id uuid primary key default app.uuid_v7(),
  organisation_id uuid not null,
  vehicle_id uuid not null,
  -- 1, 2, 3 … per vehicle, assigned by the database.
  version int not null check (version >= 1),
  name text not null check (length(trim(name)) between 1 and 60),
  row_count int not null check (row_count between 1 and 30),
  column_count int not null check (column_count between 1 and 8),
  status text not null default 'draft' check (status in ('draft', 'published', 'retired')),
  -- Null: never published.
  published_at timestamptz,
  -- Null: not retired.
  retired_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organisation_id, id),
  unique (vehicle_id, version),
  foreign key (organisation_id, vehicle_id) references app.vehicles (organisation_id, id),
  foreign key (organisation_id, created_by) references app.users (organisation_id, id),
  check ((status = 'draft') = (published_at is null)),
  check ((status = 'retired') = (retired_at is not null))
);

-- A vehicle has at most one published (current) layout and one draft.
create unique index seat_layouts_one_published on app.seat_layouts (vehicle_id) where status = 'published';
create unique index seat_layouts_one_draft on app.seat_layouts (vehicle_id) where status = 'draft';

create table app.seats (
  id uuid primary key default app.uuid_v7(),
  organisation_id uuid not null,
  layout_id uuid not null,
  -- What passengers see, for example 1A or 14.
  seat_number text not null check (seat_number ~ '^[A-Z0-9]{1,4}$'),
  row_number int not null check (row_number >= 1),
  column_number int not null check (column_number >= 1),
  -- The seat's class. Re-seating never moves a passenger to a different class (D24).
  seat_type text not null default 'standard' check (seat_type in ('standard', 'premium', 'accessible')),
  -- Null: not specified.
  position text check (position in ('window', 'aisle', 'middle')),
  -- False for crew or blocked seats that are never sold.
  bookable boolean not null default true,
  created_at timestamptz not null default now(),
  unique (organisation_id, id),
  unique (organisation_id, layout_id, id),
  unique (layout_id, seat_number),
  unique (layout_id, row_number, column_number),
  foreign key (organisation_id, layout_id) references app.seat_layouts (organisation_id, id)
);

create function app.seat_layouts_before_write() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_vehicle record;
  v_bookable int;
  v_outside int;
begin
  if tg_op = 'INSERT' then
    select coalesce(max(version), 0) + 1 into new.version from app.seat_layouts where vehicle_id = new.vehicle_id;
    if new.status <> 'draft' then
      perform app.fail('A new seat layout starts as a draft.');
    end if;
    return new;
  end if;

  if old.status = 'retired' then
    perform app.fail('A retired seat layout cannot be changed.');
  end if;
  if old.status = 'draft' and new.status = 'retired' then
    perform app.fail('A draft layout cannot be retired. Edit it, or publish it.');
  end if;
  if old.status = 'published' and new.status not in ('published', 'retired') then
    perform app.fail('A published seat layout can only be retired.');
  end if;
  if old.status <> 'draft' and (new.row_count <> old.row_count or new.column_count <> old.column_count
      or new.name <> old.name or new.vehicle_id <> old.vehicle_id) then
    perform app.fail('A published seat layout cannot change. Create a new version instead.');
  end if;

  if new.status = 'published' and old.status = 'draft' then
    select * into v_vehicle from app.vehicles where id = new.vehicle_id;
    if v_vehicle.status = 'retired' then
      perform app.fail('A layout cannot be published for a retired vehicle.');
    end if;
    select count(*) filter (where bookable),
           count(*) filter (where row_number > new.row_count or column_number > new.column_count)
      into v_bookable, v_outside
      from app.seats where layout_id = new.id;
    if v_bookable = 0 then
      perform app.fail('A seat layout needs at least one bookable seat.');
    end if;
    if v_outside > 0 then
      perform app.fail('Some seats are outside the layout''s rows and columns.');
    end if;
    if v_bookable > v_vehicle.capacity then
      perform app.fail(format('The layout has %s bookable seats but the vehicle''s capacity is %s.', v_bookable, v_vehicle.capacity));
    end if;
    -- The previous current layout is retired; journeys keep their own seat snapshots.
    update app.seat_layouts set status = 'retired', retired_at = now()
      where vehicle_id = new.vehicle_id and status = 'published' and id <> new.id;
    new.published_at := now();
  end if;

  if new.status = 'retired' and old.status <> 'retired' then
    new.retired_at := now();
  end if;
  return new;
end
$$;

create trigger seat_layouts_before_write before insert or update on app.seat_layouts
  for each row execute function app.seat_layouts_before_write();

-- Seats change only while their layout is a draft, and stay inside its grid.
create function app.seats_guard() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_layout record;
begin
  select * into v_layout from app.seat_layouts where id = coalesce(new.layout_id, old.layout_id);
  if v_layout.status <> 'draft' then
    perform app.fail('Seats can only be changed while the layout is a draft. Create a new layout version to change seats.');
  end if;
  if tg_op <> 'DELETE' then
    if tg_op = 'UPDATE' and new.layout_id <> old.layout_id then
      perform app.fail('A seat cannot move to another layout.');
    end if;
    if new.row_number > v_layout.row_count or new.column_number > v_layout.column_count then
      perform app.fail(format('Seat %s is outside the layout''s %s rows and %s columns.', new.seat_number, v_layout.row_count, v_layout.column_count));
    end if;
  end if;
  return coalesce(new, old);
end
$$;

create trigger seats_guard before insert or update or delete on app.seats
  for each row execute function app.seats_guard();

-- ---------------------------------------------------------------------------
-- Fares (10.3)
-- ---------------------------------------------------------------------------

create table app.fare_templates (
  id uuid primary key default app.uuid_v7(),
  organisation_id uuid not null,
  route_id uuid not null,
  name text not null check (length(trim(name)) between 2 and 120),
  currency char(3) not null default 'GHS' check (currency ~ '^[A-Z]{3}$'),
  status text not null default 'draft' check (status in ('draft', 'active', 'archived')),
  -- Null: never activated.
  activated_at timestamptz,
  -- Null: not archived.
  archived_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organisation_id, id),
  unique (organisation_id, route_id, id),
  foreign key (organisation_id, route_id) references app.routes (organisation_id, id),
  foreign key (organisation_id, created_by) references app.users (organisation_id, id),
  check ((status = 'archived') = (archived_at is not null))
);

-- One active fare table per route: the default plan new journeys are priced from.
create unique index fare_templates_one_active on app.fare_templates (route_id) where status = 'active';

create table app.fare_rules (
  id uuid primary key default app.uuid_v7(),
  organisation_id uuid not null,
  template_id uuid not null,
  -- Carried so the foreign keys below prove both stops belong to the template's route.
  route_id uuid not null,
  origin_stop_id uuid not null,
  destination_stop_id uuid not null,
  seat_type text not null check (seat_type in ('standard', 'premium', 'accessible')),
  amount_pesewas bigint not null check (amount_pesewas > 0 and amount_pesewas <= 100000000),
  currency char(3) not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organisation_id, id),
  unique (template_id, origin_stop_id, destination_stop_id, seat_type),
  foreign key (organisation_id, route_id, template_id) references app.fare_templates (organisation_id, route_id, id),
  foreign key (organisation_id, route_id, origin_stop_id) references app.route_stops (organisation_id, route_id, id),
  foreign key (organisation_id, route_id, destination_stop_id) references app.route_stops (organisation_id, route_id, id),
  check (origin_stop_id <> destination_stop_id)
);

create index fare_rules_by_template on app.fare_rules (template_id);

create function app.fare_rules_guard() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_template record;
  v_origin record;
  v_destination record;
begin
  select * into v_template from app.fare_templates where id = coalesce(new.template_id, old.template_id);
  if v_template.status <> 'draft' then
    perform app.fail('Fares can only be changed while the fare table is a draft. Copy it to a new draft to change prices.');
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  if new.currency <> v_template.currency then
    perform app.fail(format('Fares in this table must be in %s.', v_template.currency));
  end if;
  select * into v_origin from app.route_stops where id = new.origin_stop_id;
  select * into v_destination from app.route_stops where id = new.destination_stop_id;
  if v_destination.sequence <= v_origin.sequence then
    perform app.fail('The destination stop must come after the origin stop.');
  end if;
  if not v_origin.boarding_allowed then
    perform app.fail('Passengers cannot board at the chosen origin stop.');
  end if;
  if not v_destination.dropoff_allowed then
    perform app.fail('Passengers cannot get off at the chosen destination stop.');
  end if;
  return new;
end
$$;

create trigger fare_rules_guard before insert or update or delete on app.fare_rules
  for each row execute function app.fare_rules_guard();

-- Fare table life cycle: draft → active → archived. Activation needs a live
-- route and a standard fare for every stop pair a passenger can travel, so no
-- journey is ever on sale without a price. The previous active table is archived.
create function app.fare_templates_before_update() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_route_status text;
  v_missing int;
begin
  if old.status = 'archived' then
    perform app.fail('An archived fare table cannot be changed.');
  end if;
  if new.status = 'draft' and old.status <> 'draft' then
    perform app.fail('A live fare table cannot go back to draft.');
  end if;
  if new.route_id <> old.route_id or new.currency <> old.currency then
    perform app.fail('A fare table''s route and currency cannot change.');
  end if;

  if new.status = 'active' and old.status = 'draft' then
    select status into v_route_status from app.routes where id = new.route_id;
    if v_route_status <> 'active' then
      perform app.fail('The route must be live before its fares can go live.');
    end if;
    select count(*) into v_missing
    from app.route_stops o
    join app.route_stops d on d.route_id = o.route_id and d.sequence > o.sequence
    where o.route_id = new.route_id and o.boarding_allowed and d.dropoff_allowed
      and not exists (
        select 1 from app.fare_rules r
        where r.template_id = new.id and r.origin_stop_id = o.id and r.destination_stop_id = d.id
          and r.seat_type = 'standard'
      );
    if v_missing > 0 then
      perform app.fail(format('%s stop pairs have no standard fare yet. Every trip a passenger can take needs a price.', v_missing));
    end if;
    update app.fare_templates set status = 'archived', archived_at = now()
      where route_id = new.route_id and status = 'active' and id <> new.id;
    new.activated_at := now();
  end if;

  if new.status = 'archived' and old.status <> 'archived' then
    new.archived_at := now();
  end if;
  return new;
end
$$;

create trigger fare_templates_before_update before update on app.fare_templates
  for each row execute function app.fare_templates_before_update();

-- Copies a fare table (any status) into a new draft for the same route.
create function app.copy_fare_template(p_template_id uuid, p_name text) returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_source record;
  v_new_id uuid;
begin
  select * into v_source from app.fare_templates where id = p_template_id;
  if not found then
    perform app.fail('That fare table does not exist.');
  end if;
  insert into app.fare_templates (organisation_id, route_id, name, currency, created_by)
  values (v_source.organisation_id, v_source.route_id, p_name, v_source.currency, app.current_actor_id())
  returning id into v_new_id;
  insert into app.fare_rules (organisation_id, template_id, route_id, origin_stop_id, destination_stop_id, seat_type, amount_pesewas, currency)
  select organisation_id, v_new_id, route_id, origin_stop_id, destination_stop_id, seat_type, amount_pesewas, currency
  from app.fare_rules where template_id = p_template_id;
  return v_new_id;
end
$$;

-- Concession types, for example Student (10.3, D10, D25). Applied by the
-- server; a passenger's claim is never trusted for the price on its own.
create table app.concession_types (
  id uuid primary key default app.uuid_v7(),
  organisation_id uuid not null references app.organisations (id),
  name text not null check (length(trim(name)) between 2 and 60),
  code text not null check (code ~ '^[a-z][a-z0-9_]{1,30}$'),
  discount_kind text not null check (discount_kind in ('percent', 'fixed')),
  -- Percent discounts in basis points (1000 = 10%). Null for fixed discounts.
  discount_basis_points int check (discount_basis_points between 1 and 10000),
  -- Fixed discounts per seat. Null for percent discounts.
  discount_pesewas bigint check (discount_pesewas > 0),
  -- The passenger must give a reference, for example a student number.
  requires_reference boolean not null default true,
  -- The conductor checks proof (for example a student ID) at boarding.
  check_at_boarding boolean not null default true,
  status text not null default 'active' check (status in ('active', 'archived')),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organisation_id, id),
  unique (organisation_id, code),
  foreign key (organisation_id, created_by) references app.users (organisation_id, id),
  check (
    (discount_kind = 'percent' and discount_basis_points is not null and discount_pesewas is null)
    or (discount_kind = 'fixed' and discount_pesewas is not null and discount_basis_points is null)
  )
);

-- Service fees and levies (10.3, 13.4, 13.4a). Applied once per booking,
-- rounded once to the pesewa, half up, and shown to the passenger.
create table app.fee_rules (
  id uuid primary key default app.uuid_v7(),
  organisation_id uuid not null references app.organisations (id),
  name text not null check (length(trim(name)) between 2 and 60),
  -- booking_fee: the organisation's service fee. tax: a levy the organisation must charge.
  category text not null check (category in ('booking_fee', 'tax')),
  calculation text not null check (calculation in ('fixed', 'percent')),
  -- Fixed fees per booking. Null for percent fees.
  amount_pesewas bigint check (amount_pesewas > 0),
  -- Percent of the discounted seat total, in basis points. Null for fixed fees.
  basis_points int check (basis_points between 1 and 10000),
  applies_to text not null default 'all' check (applies_to in ('all', 'online', 'station')),
  status text not null default 'active' check (status in ('active', 'archived')),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organisation_id, id),
  foreign key (organisation_id, created_by) references app.users (organisation_id, id),
  check (
    (calculation = 'fixed' and amount_pesewas is not null and basis_points is null)
    or (calculation = 'percent' and basis_points is not null and amount_pesewas is null)
  )
);

-- Archiving is final for concessions and fees: an archived rule is kept for history.
create function app.archive_is_final() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status = 'archived' and new.status <> 'archived' then
    perform app.fail('An archived item cannot be brought back. Create a new one instead.');
  end if;
  return new;
end
$$;

create trigger concession_types_archive_is_final before update on app.concession_types
  for each row execute function app.archive_is_final();
create trigger fee_rules_archive_is_final before update on app.fee_rules
  for each row execute function app.archive_is_final();

-- ---------------------------------------------------------------------------
-- Station scope for staff roles now has something to point at (spec 5).
-- ---------------------------------------------------------------------------

create function app.user_roles_scope_check() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.scope_type = 'station' and not exists (
    select 1 from app.locations
    where organisation_id = new.organisation_id and id = new.scope_id and location_type in ('terminal', 'station')
  ) then
    perform app.fail('A station role must point at one of the organisation''s terminals or stations.');
  end if;
  return new;
end
$$;

create trigger user_roles_scope_check before insert or update on app.user_roles
  for each row execute function app.user_roles_scope_check();

-- ---------------------------------------------------------------------------
-- Shared plumbing: timestamps, no-delete, audit, row-level security, grants
-- ---------------------------------------------------------------------------

do $$
declare
  v_table text;
begin
  foreach v_table in array array['locations', 'routes', 'route_stops', 'vehicles', 'seat_layouts',
                                 'fare_templates', 'fare_rules', 'concession_types', 'fee_rules'] loop
    execute format('create trigger %1$s_updated_at before update on app.%1$I for each row execute function app.set_updated_at()', v_table);
  end loop;

  -- Records that history refers to are archived or retired, never deleted.
  foreach v_table in array array['locations', 'routes', 'vehicles', 'seat_layouts', 'fare_templates',
                                 'concession_types', 'fee_rules'] loop
    execute format('create trigger %1$s_no_delete before delete on app.%1$I for each row execute function app.refuse_delete()', v_table);
  end loop;

  foreach v_table in array array['locations', 'routes', 'route_stops', 'vehicles', 'seat_layouts', 'seats',
                                 'fare_templates', 'fare_rules', 'concession_types', 'fee_rules'] loop
    execute format('create trigger %1$s_audit after insert or update or delete on app.%1$I for each row execute function app.audit_row_change()', v_table);
    execute format('alter table app.%I enable row level security', v_table);
    execute format(
      'create policy org_boundary on app.%I to app_runtime using (organisation_id = app.current_organisation_id()) with check (organisation_id = app.current_organisation_id())',
      v_table);
    execute format('grant select, insert, update on app.%I to app_runtime', v_table);
  end loop;
end
$$;

-- Vehicle triggers are created after the seat tables they read exist.
create trigger vehicles_before_update before update on app.vehicles
  for each row execute function app.vehicles_before_update();

-- Draft-only children may be removed while their parent is a draft (the guards enforce it).
grant delete on app.route_stops, app.seats, app.fare_rules to app_runtime;

-- Contact details of a location are not personal data; nothing to mask here.
grant execute on function
  app.fail(text), app.route_stops_guard(), app.routes_before_update(), app.vehicles_before_update(),
  app.seat_layouts_before_write(), app.seats_guard(), app.fare_rules_guard(), app.fare_templates_before_update(),
  app.copy_fare_template(uuid, text), app.archive_is_final(), app.user_roles_scope_check()
to app_runtime;

revoke all on all tables in schema app from anon, authenticated;
revoke all on all functions in schema app from anon, authenticated;
