-- Run this once in Supabase → project "transport" → SQL Editor → Run.
-- It installs the bus-assignment function (Phase C, part 7), the booking core
-- (Phase D, parts 1 to 3) and boarding (Phase E, slice 2) in one transaction:
-- all of it applies, or none of it.
-- It also records them in Supabase's migration history so later updates line up.

begin;

-- ====================================================================
-- 20261008075400_scheduling_7_assign_vehicle.sql
-- ====================================================================
-- Phase C: scheduling, part 7 of 7: assigning a bus and copying its seats.
-- Written with create or replace so it is safe to run again.

-- Assigns a bus to a draft journey and copies its published seat layout.
-- On a journey already on sale the bus is changed by the vehicle change
-- procedure (15.1), which re-seats passengers.
create or replace function app.assign_vehicle(p_journey_id uuid, p_vehicle_id uuid, p_reason text default null) returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_journey record;
  v_vehicle record;
  v_layout_id uuid;
  v_buffer int;
  v_assignment_id uuid;
begin
  select * into v_journey from app.journeys where id = p_journey_id for update;
  if not found then
    perform app.fail('That journey does not exist.');
  end if;
  if v_journey.state <> 'DRAFT' then
    perform app.fail('This journey is already on sale. Its bus is changed with the vehicle change procedure, which re-seats passengers.');
  end if;

  select * into v_vehicle from app.vehicles where id = p_vehicle_id;
  if not found then
    perform app.fail('That bus does not exist.');
  end if;
  if v_vehicle.status <> 'active' then
    perform app.fail(format('Bus %s is %s and cannot be assigned.', v_vehicle.registration,
      case v_vehicle.status when 'maintenance' then 'in maintenance' else 'retired' end));
  end if;
  select id into v_layout_id from app.seat_layouts where vehicle_id = p_vehicle_id and status = 'published';
  if v_layout_id is null then
    perform app.fail(format('Bus %s has no published seat layout yet.', v_vehicle.registration));
  end if;

  update app.vehicle_assignments set state = 'REPLACED' where journey_id = p_journey_id and state = 'ACTIVE';

  v_buffer := coalesce(app.setting_int(v_journey.organisation_id, 'fleet.turnaround_minutes'), 60);
  begin
    insert into app.vehicle_assignments (organisation_id, journey_id, vehicle_id, occupied_during, reason, assigned_by)
    values (v_journey.organisation_id, p_journey_id, p_vehicle_id,
            tstzrange(v_journey.scheduled_departure_at, v_journey.scheduled_arrival_at + make_interval(mins => v_buffer)),
            p_reason, app.current_actor_id())
    returning id into v_assignment_id;
  exception when exclusion_violation then
    perform app.fail(format('Bus %s is already on another journey at that time, including the %s-minute turnaround.',
      v_vehicle.registration, v_buffer));
  end;

  delete from app.journey_seats where journey_id = p_journey_id;
  insert into app.journey_seats (organisation_id, journey_id, source_seat_id, seat_number, seat_type, row_number, column_number, position, state)
  select s.organisation_id, p_journey_id, s.id, s.seat_number, s.seat_type, s.row_number, s.column_number, s.position,
         case when s.bookable then 'BOOKABLE' else 'BLOCKED' end
  from app.seats s where s.layout_id = v_layout_id;

  perform app.record_journey_event(p_journey_id, 'vehicle_assigned', coalesce(p_reason, 'Bus ' || v_vehicle.registration));
  return v_assignment_id;
end
$$;

grant execute on function app.assign_vehicle(uuid, uuid, text) to app_runtime;
revoke all on function app.assign_vehicle(uuid, uuid, text) from anon, authenticated;

-- ====================================================================
-- 20261008100000_booking_1_tables.sql
-- ====================================================================
-- Phase D: booking core, part 1 of 3: tables and their own guards
-- (spec 9.3 to 9.7, 10.5, 10.6, 10.10, 11.8, 13, 14.1, 14.2, 17, 18.3a, 18.6).
-- Procedures are in part 2; row-level security, grants and audit in part 3.
--
-- The one place a seat is reserved is a seat claim. The database refuses two
-- active claims on one journey seat whose occupied stop ranges overlap.

-- A random code from an alphabet without look-alike characters (no 0, O, 1, I).
create function app.random_code(p_length int, p_alphabet text default '23456789ABCDEFGHJKLMNPQRSTUVWXYZ') returns text
language plpgsql volatile
set search_path = ''
as $$
declare
  v_bytes bytea;
  v_result text := '';
  v_size int := length(p_alphabet);
  v_byte int;
  i int;
begin
  while length(v_result) < p_length loop
    v_bytes := uuid_send(gen_random_uuid());
    for i in 0..15 loop
      continue when i in (6, 8); -- version and variant bits are not random
      v_byte := get_byte(v_bytes, i);
      -- Skip the biased tail so every character is equally likely.
      continue when v_byte >= 256 - (256 % v_size);
      exit when length(v_result) >= p_length;
      v_result := v_result || substr(p_alphabet, v_byte % v_size + 1, 1);
    end loop;
  end loop;
  return v_result;
end
$$;

-- New settings (decision log) for this phase, added to every organisation.
insert into app.setting_definitions (key, decision, description, value_type, default_value) values
  ('concession.academic_year_end', 'D25', 'Student concessions end on this day each year (MM-DD), or after 12 months if sooner', 'string', '"07-31"'),
  ('booking.max_holds_per_address_per_hour', null, 'New holds allowed from one network address per hour (spec 11.6)', 'number', '20'),
  ('payments.attempt_window_minutes', 'D3', 'A payment attempt with no result is treated as expired after this long', 'number', '10');

insert into app.settings (organisation_id, key, value)
select o.id, d.key, d.default_value
from app.organisations o
cross join app.setting_definitions d
where d.key in ('concession.academic_year_end', 'booking.max_holds_per_address_per_hour', 'payments.attempt_window_minutes')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Concession verification (D25)
-- ---------------------------------------------------------------------------

create table app.concession_verifications (
  id uuid primary key default app.uuid_v7(),
  organisation_id uuid not null,
  -- Null: a guest, matched by phone.
  user_id uuid,
  phone text not null check (phone ~ '^\+[1-9][0-9]{7,14}$'),
  concession_type_id uuid not null,
  -- For example the student number.
  reference text not null check (length(trim(reference)) between 2 and 40),
  -- Null: not given.
  institution text check (length(institution) <= 120),
  source text not null check (source in ('self_declared', 'institution_list', 'id_checked_at_boarding', 'account_verified')),
  verified_at timestamptz not null default now(),
  expires_at timestamptz not null,
  status text not null default 'VALID' check (status in ('VALID', 'EXPIRED', 'REVOKED')),
  created_at timestamptz not null default now(),
  unique (organisation_id, id),
  foreign key (organisation_id, user_id) references app.users (organisation_id, id),
  foreign key (organisation_id, concession_type_id) references app.concession_types (organisation_id, id),
  check (expires_at > verified_at)
);

create index concession_verifications_by_phone on app.concession_verifications (organisation_id, phone, concession_type_id) where status = 'VALID';

-- ---------------------------------------------------------------------------
-- Bookings, passengers and booked seats (9.3, 9.4, 10.5, 10.10)
-- ---------------------------------------------------------------------------

create table app.bookings (
  id uuid primary key default app.uuid_v7(),
  organisation_id uuid not null,
  journey_id uuid not null,
  route_id uuid not null,
  -- Null for a guest booking (D9).
  user_id uuid,
  -- Shown to people. Random and non-guessable.
  reference text not null check (reference ~ '^[2-9A-HJ-NP-Z]{8}$'),
  purchaser_name text not null check (length(trim(purchaser_name)) between 1 and 120),
  purchaser_phone text not null check (purchaser_phone ~ '^\+[1-9][0-9]{7,14}$'),
  -- Null: no email given (D30 uses a placeholder for the provider).
  purchaser_email text check (purchaser_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  state text not null default 'PENDING'
    check (state in ('PENDING', 'PAYMENT_PENDING', 'CONFIRMED', 'EXPIRED', 'CANCELLED', 'COMPLETED')),
  -- Release 1 sells one trip per booking: every seat shares these stops.
  origin_stop_id uuid not null,
  destination_stop_id uuid not null,
  subtotal_pesewas bigint not null check (subtotal_pesewas >= 0),
  fees_pesewas bigint not null check (fees_pesewas >= 0),
  total_pesewas bigint not null check (total_pesewas > 0),
  currency char(3) not null,
  source text not null check (source in ('passenger_app', 'station', 'support')),
  channel text not null check (channel in ('online', 'station')),
  -- The price as sold, in the order of spec 13.4a. Never recalculated.
  price_breakdown jsonb not null,
  first_held_at timestamptz not null default now(),
  -- Set while PENDING or PAYMENT_PENDING: when the hold ends.
  expires_at timestamptz,
  -- Hash of the token given to the browser that made a guest booking. Null when not issued.
  access_token_hash bytea unique,
  -- Null: not made through a web request.
  created_from_address inet,
  -- Null: made by the passenger; otherwise the staff member who made it.
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organisation_id, id),
  unique (organisation_id, journey_id, id),
  unique (organisation_id, reference),
  foreign key (organisation_id, route_id, journey_id) references app.journeys (organisation_id, route_id, id),
  foreign key (organisation_id, route_id, origin_stop_id) references app.route_stops (organisation_id, route_id, id),
  foreign key (organisation_id, route_id, destination_stop_id) references app.route_stops (organisation_id, route_id, id),
  foreign key (organisation_id, user_id) references app.users (organisation_id, id),
  foreign key (organisation_id, created_by) references app.users (organisation_id, id),
  check (total_pesewas = subtotal_pesewas + fees_pesewas),
  check ((state in ('PENDING', 'PAYMENT_PENDING')) = (expires_at is not null))
);

create index bookings_by_user on app.bookings (user_id, created_at) where user_id is not null;
create index bookings_by_journey_state on app.bookings (journey_id, state);
create index bookings_open_by_expiry on app.bookings (expires_at) where state in ('PENDING', 'PAYMENT_PENDING');
create index bookings_open_by_phone on app.bookings (organisation_id, purchaser_phone) where state in ('PENDING', 'PAYMENT_PENDING');

create table app.booking_passengers (
  id uuid primary key default app.uuid_v7(),
  organisation_id uuid not null,
  booking_id uuid not null,
  full_name text not null check (length(trim(full_name)) between 1 and 120),
  phone text not null check (phone ~ '^\+[1-9][0-9]{7,14}$'),
  -- Null: not given.
  email text check (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  -- Null: the standard fare.
  concession_type_id uuid,
  -- The verification the concession price relied on. Null with the standard fare.
  concession_verification_id uuid,
  -- Null: no emergency contact given.
  emergency_contact text check (length(emergency_contact) <= 120),
  created_at timestamptz not null default now(),
  unique (organisation_id, id),
  unique (organisation_id, booking_id, id),
  foreign key (organisation_id, booking_id) references app.bookings (organisation_id, id),
  foreign key (organisation_id, concession_type_id) references app.concession_types (organisation_id, id),
  foreign key (organisation_id, concession_verification_id) references app.concession_verifications (organisation_id, id),
  check ((concession_type_id is null) = (concession_verification_id is null))
);

create table app.booked_seats (
  id uuid primary key default app.uuid_v7(),
  organisation_id uuid not null,
  booking_id uuid not null,
  journey_id uuid not null,
  route_id uuid not null,
  journey_seat_id uuid not null,
  passenger_id uuid not null,
  origin_stop_id uuid not null,
  destination_stop_id uuid not null,
  seat_type text not null check (seat_type in ('standard', 'premium', 'accessible')),
  -- Null: the standard fare.
  concession_type_id uuid,
  -- The components and their total, as sold (13.4a). Never recalculated.
  base_pesewas bigint not null check (base_pesewas > 0),
  concession_pesewas bigint not null default 0 check (concession_pesewas >= 0),
  fee_share_pesewas bigint not null default 0 check (fee_share_pesewas >= 0),
  amount_pesewas bigint not null check (amount_pesewas >= 0),
  state text not null default 'HELD' check (state in ('HELD', 'CONFIRMED', 'BOARDED', 'NO_SHOW', 'CANCELLED', 'EXPIRED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organisation_id, id),
  unique (organisation_id, journey_id, id),
  -- The seat is on the booking's journey, the passenger on the booking, the stops on the route (11.8 #2, #14).
  foreign key (organisation_id, journey_id, booking_id) references app.bookings (organisation_id, journey_id, id),
  foreign key (organisation_id, journey_id, journey_seat_id) references app.journey_seats (organisation_id, journey_id, id),
  foreign key (organisation_id, booking_id, passenger_id) references app.booking_passengers (organisation_id, booking_id, id),
  foreign key (organisation_id, route_id, journey_id) references app.journeys (organisation_id, route_id, id),
  foreign key (organisation_id, route_id, origin_stop_id) references app.route_stops (organisation_id, route_id, id),
  foreign key (organisation_id, route_id, destination_stop_id) references app.route_stops (organisation_id, route_id, id),
  foreign key (organisation_id, concession_type_id) references app.concession_types (organisation_id, id),
  check (concession_pesewas <= base_pesewas),
  check (amount_pesewas = base_pesewas - concession_pesewas + fee_share_pesewas)
);

-- A second guard in release 1: one live booked seat per journey seat.
create unique index booked_seats_one_live on app.booked_seats (journey_seat_id) where state in ('HELD', 'CONFIRMED');
create index booked_seats_by_booking on app.booked_seats (booking_id);

-- ---------------------------------------------------------------------------
-- Seat claims: the one place a seat is reserved (9.5, 11)
-- ---------------------------------------------------------------------------

create table app.seat_claims (
  id uuid primary key default app.uuid_v7(),
  organisation_id uuid not null,
  journey_id uuid not null,
  journey_seat_id uuid not null,
  booked_seat_id uuid not null,
  -- Stop sequences the claim occupies. Release 1 (D1): always the whole journey.
  occupied_from_seq int not null check (occupied_from_seq >= 1),
  occupied_to_seq int not null,
  state text not null check (state in ('HELD', 'CONFIRMED', 'RELEASED')),
  held_at timestamptz not null default now(),
  -- Set while HELD.
  expires_at timestamptz,
  -- Set once RELEASED.
  released_at timestamptz,
  release_reason text check (release_reason in ('expired', 'cancelled', 'remapped', 'payment_failed', 'reseated')),
  unique (organisation_id, id),
  -- The claim's seat and booked seat belong to the same journey (11.8 #2).
  foreign key (organisation_id, journey_id, journey_seat_id) references app.journey_seats (organisation_id, journey_id, id),
  foreign key (organisation_id, journey_id, booked_seat_id) references app.booked_seats (organisation_id, journey_id, id),
  check (occupied_from_seq < occupied_to_seq),
  check ((state = 'HELD') = (expires_at is not null)),
  check ((state = 'RELEASED') = (released_at is not null)),
  check ((state = 'RELEASED') = (release_reason is not null)),
  -- No two active claims on one journey seat overlap (11.8 #1).
  constraint seat_claims_no_overlap
    exclude using gist (journey_seat_id with =, int4range(occupied_from_seq, occupied_to_seq) with &&)
    where (state in ('HELD', 'CONFIRMED'))
);

create index seat_claims_by_seat_state on app.seat_claims (journey_seat_id, state);
create index seat_claims_held_by_expiry on app.seat_claims (expires_at) where state = 'HELD';
create index seat_claims_by_booked_seat on app.seat_claims (booked_seat_id);

-- ---------------------------------------------------------------------------
-- Tickets and credentials (9.7, 14.1, 14.2)
-- ---------------------------------------------------------------------------

create table app.tickets (
  id uuid primary key default app.uuid_v7(),
  organisation_id uuid not null,
  booked_seat_id uuid not null unique,
  journey_id uuid not null,
  ticket_number text not null check (ticket_number ~ '^T[2-9A-HJ-NP-Z]{9}$'),
  state text not null default 'VALID' check (state in ('VALID', 'BOARDED', 'CANCELLED', 'EXPIRED', 'REPLACED')),
  issued_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organisation_id, id),
  unique (organisation_id, ticket_number),
  foreign key (organisation_id, journey_id, booked_seat_id) references app.booked_seats (organisation_id, journey_id, id)
);

-- Only hashes are stored. The QR token, ticket-link token and boarding code are
-- derived on the server from a secret and the credential id, so none is stored.
create table app.ticket_credentials (
  id uuid primary key default app.uuid_v7(),
  organisation_id uuid not null,
  ticket_id uuid not null,
  token_hash bytea not null unique check (length(token_hash) = 32),
  link_token_hash bytea not null unique check (length(link_token_hash) = 32),
  boarding_code_hash bytea not null check (length(boarding_code_hash) = 32),
  issued_at timestamptz not null default now(),
  -- Null while current.
  revoked_at timestamptz,
  -- Null while current.
  revoke_reason text check (length(revoke_reason) <= 200),
  unique (organisation_id, id),
  foreign key (organisation_id, ticket_id) references app.tickets (organisation_id, id),
  check ((revoked_at is null) = (revoke_reason is null))
);

-- One current credential per ticket; rotation revokes the old one first.
create unique index ticket_credentials_one_current on app.ticket_credentials (ticket_id) where revoked_at is null;

-- ---------------------------------------------------------------------------
-- Payments (9.6, 10.6, 13)
-- ---------------------------------------------------------------------------

create table app.payment_attempts (
  -- This id is the reference sent to the provider.
  id uuid primary key default app.uuid_v7(),
  organisation_id uuid not null,
  booking_id uuid not null,
  provider text not null check (provider in ('fake', 'paystack')),
  method text not null check (method in ('mobile_money', 'card', 'any')),
  -- Null until the provider accepts.
  provider_reference text,
  amount_pesewas bigint not null check (amount_pesewas > 0),
  currency char(3) not null,
  state text not null default 'INITIATED' check (state in ('INITIATED', 'PENDING', 'SUCCEEDED', 'FAILED', 'EXPIRED')),
  started_at timestamptz not null default now(),
  -- Set once SUCCEEDED, FAILED or EXPIRED.
  ended_at timestamptz,
  -- Null unless FAILED or EXPIRED.
  failure_reason text check (length(failure_reason) <= 300),
  -- Where the passenger completes the payment. Null until the provider accepts.
  checkout_url text,
  -- Null until the server has asked the provider for the status.
  last_checked_at timestamptz,
  unique (organisation_id, id),
  unique (provider, provider_reference),
  foreign key (organisation_id, booking_id) references app.bookings (organisation_id, id),
  check ((state in ('SUCCEEDED', 'FAILED', 'EXPIRED')) = (ended_at is not null))
);

create index payment_attempts_open on app.payment_attempts (started_at) where state in ('INITIATED', 'PENDING');
create index payment_attempts_by_booking on app.payment_attempts (booking_id);

create table app.payments (
  id uuid primary key default app.uuid_v7(),
  organisation_id uuid not null,
  booking_id uuid not null,
  -- One payment per successful attempt (11.8 #7).
  attempt_id uuid not null unique,
  amount_pesewas bigint not null check (amount_pesewas > 0),
  currency char(3) not null,
  provider_fee_pesewas bigint not null default 0 check (provider_fee_pesewas >= 0),
  -- Approved, processing and completed refunds. Never above the amount (11.8 #8).
  refunded_pesewas bigint not null default 0,
  state text not null default 'RECEIVED' check (state in ('RECEIVED', 'REVERSED')),
  received_at timestamptz not null default now(),
  unique (organisation_id, id),
  foreign key (organisation_id, booking_id) references app.bookings (organisation_id, id),
  foreign key (organisation_id, attempt_id) references app.payment_attempts (organisation_id, id),
  constraint payments_refund_within_amount check (refunded_pesewas between 0 and amount_pesewas)
);

create index payments_by_booking on app.payments (booking_id);

create table app.refunds (
  id uuid primary key default app.uuid_v7(),
  organisation_id uuid not null,
  payment_id uuid not null,
  booking_id uuid not null,
  -- Null: the whole booking.
  booked_seat_id uuid,
  kind text not null check (kind in ('passenger_cancellation', 'operator_cancellation', 'late_payment',
                                     'duplicate_payment', 'goodwill', 'correction')),
  amount_pesewas bigint not null check (amount_pesewas > 0),
  currency char(3) not null,
  reason text not null check (length(trim(reason)) between 2 and 500),
  state text not null default 'REQUESTED'
    check (state in ('REQUESTED', 'APPROVED', 'PROCESSING', 'COMPLETED', 'FAILED', 'REJECTED')),
  -- How the money goes back (D32). Null until chosen.
  route text check (route in ('paystack_refund', 'paystack_transfer', 'manual')),
  -- The routes tried, in order, with why each failed.
  route_attempts jsonb not null default '[]',
  -- Null until the provider accepts the refund.
  provider_reference text,
  -- Null: requested by the system.
  requested_by uuid,
  -- Null: approved by the system (automatic kinds) or not yet approved.
  approved_by uuid,
  requested_at timestamptz not null default now(),
  -- Null until approved.
  approved_at timestamptz,
  -- Null until completed or failed.
  processed_at timestamptz,
  unique (organisation_id, id),
  foreign key (organisation_id, payment_id) references app.payments (organisation_id, id),
  foreign key (organisation_id, booking_id) references app.bookings (organisation_id, id),
  foreign key (organisation_id, booked_seat_id) references app.booked_seats (organisation_id, id),
  foreign key (organisation_id, requested_by) references app.users (organisation_id, id),
  foreign key (organisation_id, approved_by) references app.users (organisation_id, id),
  -- A person cannot approve a refund they requested (11.8 #15).
  check (requested_by is null or approved_by is null or requested_by <> approved_by)
);

create index refunds_by_payment on app.refunds (payment_id);
create index refunds_open on app.refunds (state) where state in ('REQUESTED', 'APPROVED', 'PROCESSING', 'FAILED');

-- Every provider callback, stored exactly as received before any processing (20.8).
create table app.webhook_events (
  id uuid primary key default app.uuid_v7(),
  organisation_id uuid not null references app.organisations (id),
  provider text not null check (provider in ('fake', 'paystack')),
  provider_event_id text not null,
  raw_body text not null,
  signature_ok boolean not null,
  received_at timestamptz not null default now(),
  -- Null until processed.
  processed_at timestamptz,
  -- Null until processed.
  outcome text check (outcome in ('applied', 'duplicate', 'stale', 'rejected', 'ignored', 'error')),
  attempts int not null default 0,
  -- Null unless processing failed.
  last_error text,
  -- One stored event per provider event (11.8 #9).
  unique (provider, provider_event_id)
);

create index webhook_events_unprocessed on app.webhook_events (received_at) where processed_at is null;

-- A repeated key returns the first result; a repeated key with a different request is refused (11.8 #10, 20.4).
create table app.idempotency_keys (
  id uuid primary key default app.uuid_v7(),
  organisation_id uuid not null references app.organisations (id),
  operation text not null,
  key text not null check (length(key) between 8 and 100),
  request_hash text not null,
  -- Null while the first request is still running.
  response jsonb,
  -- Null while the first request is still running.
  response_status int,
  created_at timestamptz not null default now(),
  -- Null while the first request is still running.
  completed_at timestamptz,
  unique (organisation_id, operation, key)
);

-- ---------------------------------------------------------------------------
-- Messages (10.7, 17)
-- ---------------------------------------------------------------------------

-- Written in the same transaction as the change that caused it (17.3 rule 2).
create table app.outbox (
  id uuid primary key default app.uuid_v7(),
  organisation_id uuid not null references app.organisations (id),
  event_type text not null,
  -- Ids only, never tokens or codes.
  payload jsonb not null,
  -- The same event never produces two messages (17.3 rule 3).
  dedupe_key text not null,
  created_at timestamptz not null default now(),
  -- Null until every delivery is settled.
  processed_at timestamptz,
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  -- Null unless the last attempt failed.
  last_error text,
  unique (organisation_id, id),
  unique (organisation_id, dedupe_key)
);

create index outbox_due on app.outbox (next_attempt_at) where processed_at is null;

create table app.notification_deliveries (
  id uuid primary key default app.uuid_v7(),
  organisation_id uuid not null,
  outbox_id uuid not null,
  channel text not null check (channel in ('sms')),
  recipient text not null check (recipient ~ '^\+[1-9][0-9]{7,14}$'),
  -- The message template; the text itself is not stored because it can carry a ticket link.
  template text not null,
  state text not null default 'PENDING' check (state in ('PENDING', 'SENT', 'FAILED')),
  -- Null until the provider accepts.
  provider_reference text,
  attempts int not null default 0,
  -- Null unless an attempt failed.
  last_error text,
  -- Null until sent.
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  unique (organisation_id, id),
  unique (outbox_id, channel, recipient),
  foreign key (organisation_id, outbox_id) references app.outbox (organisation_id, id)
);

-- ---------------------------------------------------------------------------
-- The ledger (18.3, 18.3a). Append-only; every posting sums to zero.
-- ---------------------------------------------------------------------------

create table app.ledger_entries (
  id uuid primary key default app.uuid_v7(),
  organisation_id uuid not null references app.organisations (id),
  -- All lines of one event share it.
  posting_id uuid not null,
  account text not null check (account in ('PROVIDER_CLEARING', 'BANK', 'CASH_ON_HAND', 'DEFERRED_FARES',
    'REFUNDS_PAYABLE', 'FARE_REVENUE', 'FEE_REVENUE', 'PROVIDER_FEES', 'CASH_VARIANCE')),
  -- Signed: debits positive, credits negative.
  amount_pesewas bigint not null check (amount_pesewas <> 0),
  currency char(3) not null,
  description text not null,
  -- The cause. Null when not about that thing.
  booking_id uuid,
  payment_id uuid,
  refund_id uuid,
  entry_date date not null default current_date,
  -- Set only by a correcting entry.
  corrects_entry_id uuid references app.ledger_entries (id),
  created_at timestamptz not null default now(),
  foreign key (organisation_id, booking_id) references app.bookings (organisation_id, id),
  foreign key (organisation_id, payment_id) references app.payments (organisation_id, id),
  foreign key (organisation_id, refund_id) references app.refunds (organisation_id, id)
);

create index ledger_entries_by_posting on app.ledger_entries (posting_id);
create index ledger_entries_by_date on app.ledger_entries (organisation_id, entry_date, account);

-- Checked when the transaction commits, so all lines of a posting are in (11.8 #11).
create function app.ledger_posting_balances() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_sum bigint;
begin
  select sum(amount_pesewas) into v_sum from app.ledger_entries where posting_id = new.posting_id;
  if v_sum <> 0 then
    raise exception 'Ledger posting % does not balance (sum %)', new.posting_id, v_sum using errcode = 'P0001';
  end if;
  return null;
end
$$;

create constraint trigger ledger_entries_balance after insert on app.ledger_entries
  deferrable initially deferred
  for each row execute function app.ledger_posting_balances();

-- ---------------------------------------------------------------------------
-- The exception queue (9.11, 18.6)
-- ---------------------------------------------------------------------------

create table app.exceptions (
  id uuid primary key default app.uuid_v7(),
  organisation_id uuid not null references app.organisations (id),
  kind text not null check (kind ~ '^[a-z_]+$'),
  severity text not null check (severity in ('critical', 'high', 'normal')),
  state text not null default 'OPEN' check (state in ('OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS', 'RESOLVED', 'DISMISSED')),
  -- The same cause never opens two exceptions.
  dedupe_key text not null,
  -- What it concerns. Null when not about that thing.
  booking_id uuid,
  journey_id uuid,
  payment_id uuid,
  refund_id uuid,
  summary text not null,
  recommended_action text not null,
  -- Null means unassigned, shown as such.
  owner_id uuid,
  due_at timestamptz not null,
  -- Required to resolve or dismiss.
  resolution text,
  -- Null until resolved or dismissed.
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organisation_id, id),
  unique (organisation_id, dedupe_key),
  foreign key (organisation_id, booking_id) references app.bookings (organisation_id, id),
  foreign key (organisation_id, journey_id) references app.journeys (organisation_id, id),
  foreign key (organisation_id, payment_id) references app.payments (organisation_id, id),
  foreign key (organisation_id, refund_id) references app.refunds (organisation_id, id),
  foreign key (organisation_id, owner_id) references app.users (organisation_id, id),
  check ((state in ('RESOLVED', 'DISMISSED')) = (resolved_at is not null)),
  check (state not in ('RESOLVED', 'DISMISSED') or resolution is not null)
);

create index exceptions_open on app.exceptions (organisation_id, severity, due_at) where state not in ('RESOLVED', 'DISMISSED');

-- ====================================================================
-- 20261008100100_booking_2_procedures.sql
-- ====================================================================
-- Phase D: booking core, part 2 of 3: state guards and procedures
-- (spec 9.1, 11.3, 11.3a, 11.4, 11.5, 12.1, 12.4, 13.3, 13.2a, 18.3a, 18.6).
-- Every state below changes only through these procedures; the guards
-- refuse illegal moves as a second line of defence (9.1 rules 2 and 3).

-- ---------------------------------------------------------------------------
-- State guards
-- ---------------------------------------------------------------------------

create function app.is_late_payment_for(p_booking_id uuid) returns boolean
language sql stable
set search_path = ''
as $$ select app.request_setting('late_payment') = p_booking_id::text $$;

create function app.bookings_before_update() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_allowed text[];
begin
  if (new.journey_id, new.route_id, new.reference, new.origin_stop_id, new.destination_stop_id, new.subtotal_pesewas,
      new.fees_pesewas, new.total_pesewas, new.currency, new.price_breakdown, new.source, new.channel, new.first_held_at)
     is distinct from
     (old.journey_id, old.route_id, old.reference, old.origin_stop_id, old.destination_stop_id, old.subtotal_pesewas,
      old.fees_pesewas, old.total_pesewas, old.currency, old.price_breakdown, old.source, old.channel, old.first_held_at) then
    perform app.fail('A booking''s journey, stops and prices are kept as sold and cannot change.');
  end if;
  if old.user_id is not null and new.user_id is distinct from old.user_id then
    perform app.fail('A booking cannot move to another account.');
  end if;
  if new.state is distinct from old.state then
    v_allowed := case old.state
      when 'PENDING' then array['PAYMENT_PENDING', 'CONFIRMED', 'EXPIRED', 'CANCELLED']
      when 'PAYMENT_PENDING' then array['CONFIRMED', 'PENDING', 'EXPIRED']
      when 'CONFIRMED' then array['COMPLETED', 'CANCELLED']
      -- A payment that arrives after the hold ended may still confirm it (12.4).
      when 'EXPIRED' then case when app.is_late_payment_for(old.id) then array['CONFIRMED'] else array[]::text[] end
      else array[]::text[]
    end;
    if not new.state = any(v_allowed) then
      perform app.fail(format('A booking cannot go from %s to %s.', old.state, new.state));
    end if;
  end if;
  return new;
end
$$;

create function app.booked_seats_before_write() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_allowed text[];
  v_fare bigint;
  v_seat record;
  v_origin int;
  v_destination int;
begin
  if tg_op = 'INSERT' then
    if new.state <> 'HELD' then
      perform app.fail('A booked seat starts as held.');
    end if;
    select seat_type, state into v_seat from app.journey_seats where id = new.journey_seat_id;
    if v_seat.state <> 'BOOKABLE' then
      perform app.fail('That seat is not for sale.');
    end if;
    if v_seat.seat_type <> new.seat_type then
      perform app.fail('The seat type does not match the seat.');
    end if;
    select sequence into v_origin from app.route_stops where id = new.origin_stop_id;
    select sequence into v_destination from app.route_stops where id = new.destination_stop_id;
    if v_destination <= v_origin then
      perform app.fail('The destination must come after the boarding point.');
    end if;
    -- The base fare is the journey's fare snapshot, never a client's figure (13.4a step 1).
    select amount_pesewas into v_fare from app.journey_fares
      where journey_id = new.journey_id and origin_stop_id = new.origin_stop_id
        and destination_stop_id = new.destination_stop_id and seat_type = new.seat_type;
    if v_fare is null then
      perform app.fail(format('There is no %s fare for this trip.', new.seat_type));
    end if;
    if v_fare <> new.base_pesewas then
      perform app.fail('The price has changed. Please review it again.');
    end if;
    return new;
  end if;

  if (new.booking_id, new.journey_id, new.passenger_id, new.origin_stop_id, new.destination_stop_id, new.seat_type,
      new.concession_type_id, new.base_pesewas, new.concession_pesewas, new.fee_share_pesewas, new.amount_pesewas)
     is distinct from
     (old.booking_id, old.journey_id, old.passenger_id, old.origin_stop_id, old.destination_stop_id, old.seat_type,
      old.concession_type_id, old.base_pesewas, old.concession_pesewas, old.fee_share_pesewas, old.amount_pesewas) then
    perform app.fail('A booked seat is kept as sold and cannot change.');
  end if;
  if new.journey_seat_id <> old.journey_seat_id and not app.is_late_payment_for(old.booking_id)
     and app.request_setting('remap') is distinct from old.journey_id::text then
    perform app.fail('A passenger is moved to another seat only by the re-seat or remap procedures.');
  end if;
  if new.state is distinct from old.state then
    v_allowed := case old.state
      when 'HELD' then array['CONFIRMED', 'EXPIRED', 'CANCELLED']
      when 'CONFIRMED' then array['BOARDED', 'NO_SHOW', 'CANCELLED']
      when 'EXPIRED' then case when app.is_late_payment_for(old.booking_id) then array['CONFIRMED'] else array[]::text[] end
      else array[]::text[]
    end;
    if not new.state = any(v_allowed) then
      perform app.fail(format('A booked seat cannot go from %s to %s.', old.state, new.state));
    end if;
  end if;
  return new;
end
$$;

create function app.seat_claims_before_write() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.state not in ('HELD', 'CONFIRMED') then
      perform app.fail('A seat claim starts as held or confirmed.');
    end if;
    return new;
  end if;
  if (new.journey_id, new.journey_seat_id, new.booked_seat_id, new.occupied_from_seq, new.occupied_to_seq, new.held_at)
     is distinct from
     (old.journey_id, old.journey_seat_id, old.booked_seat_id, old.occupied_from_seq, old.occupied_to_seq, old.held_at) then
    perform app.fail('A seat claim cannot be moved; release it and make a new one.');
  end if;
  if new.state is distinct from old.state and not (
    (old.state = 'HELD' and new.state in ('CONFIRMED', 'RELEASED')) or (old.state = 'CONFIRMED' and new.state = 'RELEASED')
  ) then
    perform app.fail(format('A seat claim cannot go from %s to %s.', old.state, new.state));
  end if;
  return new;
end
$$;

create function app.tickets_before_update() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.booked_seat_id, new.journey_id, new.ticket_number, new.issued_at)
     is distinct from (old.booked_seat_id, old.journey_id, old.ticket_number, old.issued_at) then
    perform app.fail('A ticket cannot be changed; only its status moves.');
  end if;
  if new.state is distinct from old.state and not (old.state = 'VALID' and new.state in ('BOARDED', 'CANCELLED', 'EXPIRED', 'REPLACED')) then
    perform app.fail(format('A ticket cannot go from %s to %s.', old.state, new.state));
  end if;
  return new;
end
$$;

create function app.ticket_credentials_before_update() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.revoked_at is not null
     or (new.ticket_id, new.token_hash, new.link_token_hash, new.boarding_code_hash, new.issued_at)
        is distinct from (old.ticket_id, old.token_hash, old.link_token_hash, old.boarding_code_hash, old.issued_at) then
    perform app.fail('A ticket credential can only be revoked, once.');
  end if;
  return new;
end
$$;

create function app.payment_attempts_before_update() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.booking_id, new.provider, new.amount_pesewas, new.currency, new.started_at)
     is distinct from (old.booking_id, old.provider, old.amount_pesewas, old.currency, old.started_at) then
    perform app.fail('A payment attempt''s booking, provider and amount cannot change.');
  end if;
  if old.provider_reference is not null and new.provider_reference is distinct from old.provider_reference then
    perform app.fail('A payment attempt''s provider reference cannot change.');
  end if;
  if new.state is distinct from old.state and not (
    (old.state = 'INITIATED' and new.state in ('PENDING', 'FAILED', 'EXPIRED', 'SUCCEEDED'))
    or (old.state = 'PENDING' and new.state in ('SUCCEEDED', 'FAILED', 'EXPIRED'))
    -- Mobile money can succeed after we gave up waiting (12.4).
    or (old.state in ('FAILED', 'EXPIRED') and new.state = 'SUCCEEDED')
  ) then
    perform app.fail(format('A payment attempt cannot go from %s to %s.', old.state, new.state));
  end if;
  return new;
end
$$;

create function app.payments_before_update() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.booking_id, new.attempt_id, new.amount_pesewas, new.currency, new.received_at)
     is distinct from (old.booking_id, old.attempt_id, old.amount_pesewas, old.currency, old.received_at) then
    perform app.fail('A payment record cannot be changed.');
  end if;
  if new.state is distinct from old.state and not (old.state = 'RECEIVED' and new.state = 'REVERSED') then
    perform app.fail(format('A payment cannot go from %s to %s.', old.state, new.state));
  end if;
  if new.provider_fee_pesewas < old.provider_fee_pesewas then
    perform app.fail('A provider fee, once recorded, is corrected with a ledger entry, not an edit.');
  end if;
  return new;
end
$$;

-- Refunds reserve their amount on the payment while approved, processing or
-- completed. The payment's check keeps the total within the amount, and the
-- row lock on the payment serialises concurrent refunds (11.8 #8).
create function app.refund_counts(p_state text) returns boolean
language sql immutable
set search_path = ''
as $$ select p_state in ('APPROVED', 'PROCESSING', 'COMPLETED') $$;

create function app.refunds_before_write() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_delta bigint := 0;
begin
  if tg_op = 'UPDATE' then
    if (new.payment_id, new.booking_id, new.booked_seat_id, new.kind, new.amount_pesewas, new.currency, new.requested_at)
       is distinct from (old.payment_id, old.booking_id, old.booked_seat_id, old.kind, old.amount_pesewas, old.currency, old.requested_at) then
      perform app.fail('A refund''s payment, kind and amount cannot change.');
    end if;
    if new.state is distinct from old.state and not (
      (old.state = 'REQUESTED' and new.state in ('APPROVED', 'REJECTED'))
      or (old.state = 'APPROVED' and new.state in ('PROCESSING', 'COMPLETED', 'FAILED'))
      or (old.state = 'PROCESSING' and new.state in ('COMPLETED', 'FAILED'))
      or (old.state = 'FAILED' and new.state in ('PROCESSING', 'APPROVED'))
    ) then
      perform app.fail(format('A refund cannot go from %s to %s.', old.state, new.state));
    end if;
    if app.refund_counts(new.state) and not app.refund_counts(old.state) then
      v_delta := new.amount_pesewas;
    elsif app.refund_counts(old.state) and not app.refund_counts(new.state) then
      v_delta := -old.amount_pesewas;
    end if;
  elsif app.refund_counts(new.state) then
    v_delta := new.amount_pesewas;
  end if;

  if v_delta <> 0 then
    begin
      update app.payments set refunded_pesewas = refunded_pesewas + v_delta where id = new.payment_id;
    exception when check_violation then
      perform app.fail('This refund would return more than was paid.');
    end;
  end if;
  return new;
end
$$;

create function app.webhook_events_before_update() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.organisation_id, new.provider, new.provider_event_id, new.raw_body, new.signature_ok, new.received_at)
     is distinct from (old.organisation_id, old.provider, old.provider_event_id, old.raw_body, old.signature_ok, old.received_at) then
    perform app.fail('A stored provider callback is kept exactly as received.');
  end if;
  return new;
end
$$;

create function app.idempotency_keys_before_update() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.completed_at is not null
     or (new.operation, new.key, new.request_hash, new.created_at) is distinct from (old.operation, old.key, old.request_hash, old.created_at) then
    perform app.fail('An idempotency key records its first result once.');
  end if;
  return new;
end
$$;

create trigger bookings_before_update before update on app.bookings
  for each row execute function app.bookings_before_update();
create trigger booked_seats_before_write before insert or update on app.booked_seats
  for each row execute function app.booked_seats_before_write();
create trigger seat_claims_before_write before insert or update on app.seat_claims
  for each row execute function app.seat_claims_before_write();
create trigger tickets_before_update before update on app.tickets
  for each row execute function app.tickets_before_update();
create trigger ticket_credentials_before_update before update on app.ticket_credentials
  for each row execute function app.ticket_credentials_before_update();
create trigger payment_attempts_before_update before update on app.payment_attempts
  for each row execute function app.payment_attempts_before_update();
create trigger payments_before_update before update on app.payments
  for each row execute function app.payments_before_update();
create trigger refunds_before_write before insert or update on app.refunds
  for each row execute function app.refunds_before_write();
create trigger webhook_events_before_update before update on app.webhook_events
  for each row execute function app.webhook_events_before_update();
create trigger idempotency_keys_before_update before update on app.idempotency_keys
  for each row execute function app.idempotency_keys_before_update();

-- ---------------------------------------------------------------------------
-- Messages, exceptions and the ledger
-- ---------------------------------------------------------------------------

-- Queues a message in the same transaction as its cause; the same key never queues twice.
create function app.enqueue_message(p_organisation_id uuid, p_event_type text, p_payload jsonb, p_dedupe_key text) returns void
language sql
set search_path = ''
as $$
  insert into app.outbox (organisation_id, event_type, payload, dedupe_key)
  values (p_organisation_id, p_event_type, p_payload, p_dedupe_key)
  on conflict (organisation_id, dedupe_key) do nothing
$$;

-- Opens an exception for a person to handle (18.6). The same cause never opens two.
create function app.raise_exception(
  p_organisation_id uuid,
  p_kind text,
  p_severity text,
  p_dedupe_key text,
  p_summary text,
  p_recommended_action text,
  p_booking_id uuid default null,
  p_journey_id uuid default null,
  p_payment_id uuid default null,
  p_refund_id uuid default null
) returns void
language plpgsql
set search_path = ''
as $$
declare
  v_times jsonb;
  v_minutes int;
begin
  select value into v_times from app.settings where organisation_id = p_organisation_id and key = 'exceptions.response_minutes';
  -- Response times from D27.
  v_minutes := case
    when p_kind in ('payment_after_seat_released', 'payment_amount_mismatch') then (v_times ->> 'money_taken_no_ticket')::int
    when p_kind in ('duplicate_payment', 'failed_refund') then (v_times ->> 'failed_refund')::int
    when p_kind = 'reconciliation_mismatch' then (v_times ->> 'reconciliation_mismatch')::int
    else 24 * 60
  end;
  insert into app.exceptions (organisation_id, kind, severity, dedupe_key, booking_id, journey_id, payment_id, refund_id,
                              summary, recommended_action, due_at)
  values (p_organisation_id, p_kind, p_severity, p_dedupe_key, p_booking_id, p_journey_id, p_payment_id, p_refund_id,
          p_summary, p_recommended_action, now() + make_interval(mins => coalesce(v_minutes, 24 * 60)))
  on conflict (organisation_id, dedupe_key) do nothing;
end
$$;

-- Writes one balanced posting. p_lines: [{"account": "...", "amount": signed pesewas}].
create function app.post_ledger(
  p_organisation_id uuid,
  p_description text,
  p_lines jsonb,
  p_currency text,
  p_booking_id uuid default null,
  p_payment_id uuid default null,
  p_refund_id uuid default null
) returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_posting_id uuid := app.uuid_v7();
begin
  insert into app.ledger_entries (organisation_id, posting_id, account, amount_pesewas, currency, description,
                                  booking_id, payment_id, refund_id, entry_date)
  select p_organisation_id, v_posting_id, line ->> 'account', (line ->> 'amount')::bigint, p_currency, p_description,
         p_booking_id, p_payment_id, p_refund_id,
         (now() at time zone (select timezone from app.organisations where id = p_organisation_id))::date
  from jsonb_array_elements(p_lines) as line
  where (line ->> 'amount')::bigint <> 0;
  return v_posting_id;
end
$$;

-- An automatic refund (late payment, duplicate payment, operator cancellation):
-- approved by the system at once (9.6) and moved to refunds payable (18.3a).
create function app.create_system_refund(p_payment_id uuid, p_kind text, p_amount bigint, p_reason text, p_booked_seat_id uuid default null)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_payment record;
  v_journey_state text;
  v_refund_id uuid;
begin
  select p.*, b.journey_id into v_payment from app.payments p join app.bookings b on b.id = p.booking_id where p.id = p_payment_id;
  insert into app.refunds (organisation_id, payment_id, booking_id, booked_seat_id, kind, amount_pesewas, currency, reason,
                           state, approved_at)
  values (v_payment.organisation_id, p_payment_id, v_payment.booking_id, p_booked_seat_id, p_kind, p_amount, v_payment.currency,
          p_reason, 'APPROVED', now())
  returning id into v_refund_id;

  select state into v_journey_state from app.journeys where id = v_payment.journey_id;
  perform app.post_ledger(v_payment.organisation_id, 'Refund approved: ' || p_kind,
    jsonb_build_array(
      jsonb_build_object('account', case when v_journey_state = 'COMPLETED' then 'FARE_REVENUE' else 'DEFERRED_FARES' end, 'amount', p_amount),
      jsonb_build_object('account', 'REFUNDS_PAYABLE', 'amount', -p_amount)),
    v_payment.currency, v_payment.booking_id, p_payment_id, v_refund_id);
  return v_refund_id;
end
$$;

-- The next end of the academic year (setting concession.academic_year_end, MM-DD), for D25.
create function app.next_academic_year_end(p_organisation_id uuid) returns timestamptz
language plpgsql stable
set search_path = ''
as $$
declare
  v_md text;
  v_tz text;
  v_today date;
  v_end date;
begin
  select value #>> '{}' into v_md from app.settings where organisation_id = p_organisation_id and key = 'concession.academic_year_end';
  select timezone into v_tz from app.organisations where id = p_organisation_id;
  v_today := (now() at time zone v_tz)::date;
  v_end := make_date(extract(year from v_today)::int, split_part(coalesce(v_md, '07-31'), '-', 1)::int, split_part(coalesce(v_md, '07-31'), '-', 2)::int);
  if v_end <= v_today then
    v_end := (v_end + interval '1 year')::date;
  end if;
  return (v_end + 1) at time zone v_tz;
end
$$;

-- ---------------------------------------------------------------------------
-- Holds (11.3, 11.3a, 11.4, 11.6)
-- ---------------------------------------------------------------------------

-- Ends one booking's hold if its time has passed. Safe to repeat.
create function app.expire_booking(p_booking_id uuid) returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_booking record;
begin
  select * into v_booking from app.bookings where id = p_booking_id for update;
  if v_booking.state not in ('PENDING', 'PAYMENT_PENDING') or v_booking.expires_at > now() then
    return false;
  end if;
  update app.seat_claims c set state = 'RELEASED', expires_at = null, released_at = now(), release_reason = 'expired'
    from app.booked_seats s
    where s.booking_id = p_booking_id and c.booked_seat_id = s.id and c.state = 'HELD';
  update app.booked_seats set state = 'EXPIRED' where booking_id = p_booking_id and state = 'HELD';
  update app.bookings set state = 'EXPIRED', expires_at = null where id = p_booking_id;
  return true;
end
$$;

-- Releases expired holds on the given journey seats (11.3a step 3).
create function app.release_expired_claims(p_journey_seat_ids uuid[]) returns int
language plpgsql
set search_path = ''
as $$
declare
  v_booking_id uuid;
  v_count int := 0;
begin
  for v_booking_id in
    select distinct s.booking_id
    from app.seat_claims c join app.booked_seats s on s.id = c.booked_seat_id
    where c.journey_seat_id = any(p_journey_seat_ids) and c.state = 'HELD' and c.expires_at <= now()
    order by s.booking_id
  loop
    if app.expire_booking(v_booking_id) then
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end
$$;

-- The background job (11.4): correctness never depends on it running on time.
create function app.expire_holds() returns int
language plpgsql
set search_path = ''
as $$
declare
  v_booking_id uuid;
  v_count int := 0;
begin
  for v_booking_id in
    select id from app.bookings where state in ('PENDING', 'PAYMENT_PENDING') and expires_at <= now() order by expires_at
  loop
    if app.expire_booking(v_booking_id) then
      v_count := v_count + 1;
    end if;
  end loop;
  update app.payment_attempts a set state = 'EXPIRED', ended_at = now(), failure_reason = 'No result before the payment window ended'
    where a.state in ('INITIATED', 'PENDING')
      and a.started_at + make_interval(mins => coalesce(app.setting_int(a.organisation_id, 'payments.attempt_window_minutes'), 10)) <= now();
  return v_count;
end
$$;

-- Holds seats for a new booking (11.3, 11.3a). All or nothing: if any seat is
-- taken, nothing is held. Prices come from the server (13.4a); the base fare is
-- checked against the journey's fare snapshot by the booked-seat guard.
--
-- p_booking: {purchaserName, purchaserPhone, purchaserEmail, userId, source, channel,
--             subtotal, fees, total, currency, breakdown, accessTokenHash (hex), address}
-- p_seats:   [{journeySeatId, seatType, passenger: {fullName, phone, email, emergencyContact,
--              concessionTypeId, verificationId}, base, concession, feeShare, amount}]
create function app.hold_seats(p_journey_id uuid, p_origin_stop_id uuid, p_destination_stop_id uuid, p_booking jsonb, p_seats jsonb)
returns table (booking_id uuid, reference text, expires_at timestamptz)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_journey record;
  v_close_minutes int;
  v_hold_minutes int;
  v_max_seats int;
  v_max_holds int;
  v_max_per_address int;
  v_open int;
  v_seat_ids uuid[];
  v_found int;
  v_taken text;
  v_last_seq int;
  v_booking_id uuid;
  v_reference text;
  v_expires timestamptz;
  v_seat jsonb;
  v_passenger_id uuid;
  v_booked_seat_id uuid;
  v_user_id uuid := nullif(p_booking ->> 'userId', '')::uuid;
  v_phone text := p_booking ->> 'purchaserPhone';
  v_address inet := nullif(p_booking ->> 'address', '')::inet;
begin
  -- 1. The journey is on sale and booking is open (D5, D23).
  select * into v_journey from app.journeys where id = p_journey_id for share;
  if not found or v_journey.state <> 'SCHEDULED' then
    perform app.fail('This journey is not on sale.');
  end if;
  if v_journey.booking_opens_at > now() then
    perform app.fail(format('Booking for this journey opens on %s.', to_char(v_journey.booking_opens_at at time zone 'Africa/Accra', 'FMDD Mon YYYY')));
  end if;
  v_close_minutes := case when p_booking ->> 'channel' = 'station' then 0
                          else coalesce(app.setting_int(v_journey.organisation_id, 'booking.online_close_minutes'), 30) end;
  if now() >= v_journey.scheduled_departure_at - make_interval(mins => v_close_minutes) then
    perform app.fail('Online booking for this journey has closed.');
  end if;

  -- 2. Limits (D6, D7, 11.6).
  v_max_seats := coalesce(app.setting_int(v_journey.organisation_id, 'booking.max_seats'), 6);
  if jsonb_array_length(p_seats) < 1 or jsonb_array_length(p_seats) > v_max_seats then
    perform app.fail(format('A booking can have 1 to %s seats.', v_max_seats));
  end if;
  v_max_holds := coalesce(app.setting_int(v_journey.organisation_id, 'booking.max_active_holds'), 2);
  select count(*) into v_open from app.bookings b
    where b.organisation_id = v_journey.organisation_id and b.state in ('PENDING', 'PAYMENT_PENDING') and b.expires_at > now()
      and (b.purchaser_phone = v_phone or (v_user_id is not null and b.user_id = v_user_id));
  if v_open >= v_max_holds then
    perform app.fail(format('You already have %s unpaid bookings waiting. Pay for one or let it expire (holds last %s minutes) before holding more seats.',
      v_open, coalesce(app.setting_int(v_journey.organisation_id, 'hold.minutes'), 10)));
  end if;
  if v_address is not null then
    v_max_per_address := coalesce(app.setting_int(v_journey.organisation_id, 'booking.max_holds_per_address_per_hour'), 20);
    select count(*) into v_open from app.bookings b
      where b.organisation_id = v_journey.organisation_id and b.created_from_address = v_address and b.created_at > now() - interval '1 hour';
    if v_open >= v_max_per_address then
      perform app.fail('Too many seats have been held from this network recently. Please try again later.');
    end if;
  end if;

  -- 3. Lock the seats in id order so overlapping requests cannot deadlock (11.3a step 2).
  select array_agg((s ->> 'journeySeatId')::uuid order by (s ->> 'journeySeatId')::uuid) into v_seat_ids
    from jsonb_array_elements(p_seats) s;
  if (select count(distinct x) from unnest(v_seat_ids) x) <> cardinality(v_seat_ids) then
    perform app.fail('The same seat was chosen twice.');
  end if;
  select count(*) into v_found from (
    select id from app.journey_seats where id = any(v_seat_ids) and journey_id = p_journey_id and state = 'BOOKABLE'
    order by id for update
  ) locked;
  if v_found <> cardinality(v_seat_ids) then
    perform app.fail('One of the chosen seats is not for sale.');
  end if;

  -- 4. Release holds on these seats whose time has passed (11.3a step 3).
  perform app.release_expired_claims(v_seat_ids);

  -- 5. Any live claim on a requested seat fails the whole request (11.3a step 4).
  select string_agg(js.seat_number, ', ' order by js.seat_number) into v_taken
    from app.journey_seats js
    where js.id = any(v_seat_ids)
      and exists (select 1 from app.seat_claims c where c.journey_seat_id = js.id and c.state in ('HELD', 'CONFIRMED'));
  if v_taken is not null then
    perform app.fail(format('Sorry, seat %s was just taken by someone else. Please choose another.', v_taken));
  end if;

  -- 6. Insert the booking, passengers, booked seats and claims (11.3a step 5).
  v_hold_minutes := coalesce(app.setting_int(v_journey.organisation_id, 'hold.minutes'), 10);
  v_expires := now() + make_interval(mins => v_hold_minutes);
  select max(sequence) into v_last_seq from app.route_stops where route_id = v_journey.route_id;

  loop
    v_reference := app.random_code(8);
    exit when not exists (select 1 from app.bookings where organisation_id = v_journey.organisation_id and reference = v_reference);
  end loop;

  insert into app.bookings (organisation_id, journey_id, route_id, user_id, reference, purchaser_name, purchaser_phone,
                            purchaser_email, origin_stop_id, destination_stop_id, subtotal_pesewas, fees_pesewas,
                            total_pesewas, currency, source, channel, price_breakdown, expires_at, access_token_hash,
                            created_from_address, created_by)
  values (v_journey.organisation_id, p_journey_id, v_journey.route_id, v_user_id, v_reference,
          p_booking ->> 'purchaserName', v_phone, nullif(p_booking ->> 'purchaserEmail', ''),
          p_origin_stop_id, p_destination_stop_id, (p_booking ->> 'subtotal')::bigint, (p_booking ->> 'fees')::bigint,
          (p_booking ->> 'total')::bigint, p_booking ->> 'currency', p_booking ->> 'source', p_booking ->> 'channel',
          p_booking -> 'breakdown', v_expires, decode(nullif(p_booking ->> 'accessTokenHash', ''), 'hex'), v_address,
          nullif(p_booking ->> 'createdBy', '')::uuid)
  returning id into v_booking_id;

  for v_seat in select * from jsonb_array_elements(p_seats) loop
    insert into app.booking_passengers (organisation_id, booking_id, full_name, phone, email, concession_type_id,
                                        concession_verification_id, emergency_contact)
    values (v_journey.organisation_id, v_booking_id, v_seat -> 'passenger' ->> 'fullName', v_seat -> 'passenger' ->> 'phone',
            nullif(v_seat -> 'passenger' ->> 'email', ''), nullif(v_seat -> 'passenger' ->> 'concessionTypeId', '')::uuid,
            nullif(v_seat -> 'passenger' ->> 'verificationId', '')::uuid, nullif(v_seat -> 'passenger' ->> 'emergencyContact', ''))
    returning id into v_passenger_id;

    insert into app.booked_seats (organisation_id, booking_id, journey_id, route_id, journey_seat_id, passenger_id,
                                  origin_stop_id, destination_stop_id, seat_type, concession_type_id, base_pesewas,
                                  concession_pesewas, fee_share_pesewas, amount_pesewas)
    values (v_journey.organisation_id, v_booking_id, p_journey_id, v_journey.route_id, (v_seat ->> 'journeySeatId')::uuid,
            v_passenger_id, p_origin_stop_id, p_destination_stop_id, v_seat ->> 'seatType',
            nullif(v_seat -> 'passenger' ->> 'concessionTypeId', '')::uuid, (v_seat ->> 'base')::bigint,
            (v_seat ->> 'concession')::bigint, (v_seat ->> 'feeShare')::bigint, (v_seat ->> 'amount')::bigint)
    returning id into v_booked_seat_id;

    -- Release 1 (D1): the claim covers the whole journey whatever stops are travelled.
    insert into app.seat_claims (organisation_id, journey_id, journey_seat_id, booked_seat_id, occupied_from_seq,
                                 occupied_to_seq, state, expires_at)
    values (v_journey.organisation_id, p_journey_id, (v_seat ->> 'journeySeatId')::uuid, v_booked_seat_id, 1, v_last_seq,
            'HELD', v_expires);
  end loop;

  if (select sum(amount_pesewas) from app.booked_seats where booked_seats.booking_id = v_booking_id) <> (p_booking ->> 'total')::bigint then
    perform app.fail('The seat amounts do not add up to the booking total.');
  end if;

  return query select v_booking_id, v_reference, v_expires;
end
$$;

-- ---------------------------------------------------------------------------
-- Payment attempts (12.6, 11.5)
-- ---------------------------------------------------------------------------

-- The provider accepted the attempt: it is PENDING and the hold is extended to
-- 10 minutes after the attempt began, never beyond 20 minutes from first selection (D3).
create function app.begin_payment_attempt(p_attempt_id uuid, p_provider_reference text, p_checkout_url text) returns timestamptz
language plpgsql
set search_path = ''
as $$
declare
  v_attempt record;
  v_booking record;
  v_expires timestamptz;
begin
  select * into v_attempt from app.payment_attempts where id = p_attempt_id for update;
  select * into v_booking from app.bookings where id = v_attempt.booking_id for update;
  if v_attempt.state <> 'INITIATED' then
    perform app.fail('This payment has already started.');
  end if;
  update app.payment_attempts set state = 'PENDING', provider_reference = p_provider_reference, checkout_url = p_checkout_url
    where id = p_attempt_id;
  if v_booking.state not in ('PENDING', 'PAYMENT_PENDING') then
    return null;
  end if;
  v_expires := greatest(v_booking.expires_at, least(
    v_attempt.started_at + make_interval(mins => coalesce(app.setting_int(v_booking.organisation_id, 'hold.payment_extension_minutes'), 10)),
    v_booking.first_held_at + make_interval(mins => coalesce(app.setting_int(v_booking.organisation_id, 'hold.max_total_minutes'), 20))));
  update app.bookings set state = 'PAYMENT_PENDING', expires_at = v_expires where id = v_booking.id;
  update app.seat_claims c set expires_at = v_expires
    from app.booked_seats s where s.booking_id = v_booking.id and c.booked_seat_id = s.id and c.state = 'HELD';
  return v_expires;
end
$$;

-- The provider refused or the passenger's payment failed. The hold keeps its expiry (11.5).
create function app.fail_payment_attempt(p_attempt_id uuid, p_reason text) returns text
language plpgsql
set search_path = ''
as $$
declare
  v_attempt record;
begin
  select * into v_attempt from app.payment_attempts where id = p_attempt_id for update;
  if v_attempt.state not in ('INITIATED', 'PENDING') then
    return 'stale';
  end if;
  update app.payment_attempts set state = 'FAILED', ended_at = now(), failure_reason = left(p_reason, 300) where id = p_attempt_id;
  update app.bookings b set state = 'PENDING'
    where b.id = v_attempt.booking_id and b.state = 'PAYMENT_PENDING'
      and not exists (select 1 from app.payment_attempts a where a.booking_id = b.id and a.state in ('INITIATED', 'PENDING'));
  return 'failed';
end
$$;

-- ---------------------------------------------------------------------------
-- Confirming, tickets and the late-payment procedure (12.1, 12.4)
-- ---------------------------------------------------------------------------

-- One ticket per confirmed seat (14.1). Credentials are added by the server in the same transaction.
create function app.issue_tickets(p_booking_id uuid) returns int
language plpgsql
set search_path = ''
as $$
declare
  v_seat record;
  v_number text;
  v_count int := 0;
begin
  for v_seat in
    select s.* from app.booked_seats s
    where s.booking_id = p_booking_id and s.state = 'CONFIRMED'
      and not exists (select 1 from app.tickets t where t.booked_seat_id = s.id)
    order by s.id
  loop
    loop
      v_number := 'T' || app.random_code(9);
      exit when not exists (select 1 from app.tickets where organisation_id = v_seat.organisation_id and ticket_number = v_number);
    end loop;
    insert into app.tickets (organisation_id, booked_seat_id, journey_id, ticket_number)
    values (v_seat.organisation_id, v_seat.id, v_seat.journey_id, v_number);
    v_count := v_count + 1;
  end loop;
  return v_count;
end
$$;

create function app.confirm_booking(p_booking_id uuid, p_message text) returns void
language plpgsql
set search_path = ''
as $$
declare
  v_booking record;
begin
  select * into v_booking from app.bookings where id = p_booking_id;
  update app.seat_claims c set state = 'CONFIRMED', expires_at = null
    from app.booked_seats s where s.booking_id = p_booking_id and c.booked_seat_id = s.id and c.state = 'HELD';
  update app.booked_seats set state = 'CONFIRMED' where booking_id = p_booking_id and state in ('HELD', 'EXPIRED');
  update app.bookings set state = 'CONFIRMED', expires_at = null where id = p_booking_id;
  perform app.issue_tickets(p_booking_id);
  perform app.enqueue_message(v_booking.organisation_id, p_message,
    jsonb_build_object('bookingId', p_booking_id), p_message || ':' || p_booking_id::text);
end
$$;

-- Places a booking whose hold ended (12.4 steps 1 and 2): the same seats if
-- still free, otherwise (if the setting allows) free seats of the same class.
-- Returns the number of passengers moved, or raises BR001 if any seat cannot be placed.
create function app.place_late_booking(p_booking_id uuid) returns int
language plpgsql
set search_path = ''
as $$
declare
  v_booking record;
  v_seat record;
  v_original record;
  v_candidate uuid;
  v_last_seq int;
  v_reseat boolean;
  v_moved int := 0;
  v_chosen uuid[] := '{}';
begin
  select * into v_booking from app.bookings where id = p_booking_id;
  -- Lock the journey's seats in id order, as every seat acquisition does (11.3a).
  perform 1 from (select id from app.journey_seats where journey_id = v_booking.journey_id order by id for update) locked;
  perform app.release_expired_claims(array(select id from app.journey_seats where journey_id = v_booking.journey_id));
  select max(sequence) into v_last_seq from app.route_stops where route_id = v_booking.route_id;
  select (value #>> '{}')::boolean into v_reseat from app.settings
    where organisation_id = v_booking.organisation_id and key = 'booking.auto_reseat_late_payment';

  for v_seat in select * from app.booked_seats where booking_id = p_booking_id order by id loop
    select * into v_original from app.journey_seats where id = v_seat.journey_seat_id;
    if v_original.state = 'BOOKABLE' and not exists (
      select 1 from app.seat_claims c where c.journey_seat_id = v_original.id and c.state in ('HELD', 'CONFIRMED')
    ) then
      v_candidate := v_original.id;
    elsif coalesce(v_reseat, false) then
      -- Same class only, never a dearer seat: the fare is by seat type, so the price is the same (D24).
      select js.id into v_candidate
      from app.journey_seats js
      where js.journey_id = v_booking.journey_id and js.state = 'BOOKABLE' and js.seat_type = v_seat.seat_type
        and js.id <> all(v_chosen)
        and not exists (select 1 from app.seat_claims c where c.journey_seat_id = js.id and c.state in ('HELD', 'CONFIRMED'))
      order by abs(js.row_number - v_original.row_number), abs(js.column_number - v_original.column_number), js.seat_number
      limit 1;
      if v_candidate is null then
        perform app.fail('No seat of the same class is free.');
      end if;
      update app.booked_seats set journey_seat_id = v_candidate where id = v_seat.id;
      v_moved := v_moved + 1;
    else
      perform app.fail('The seat was sold and re-seating is switched off.');
    end if;
    v_chosen := v_chosen || v_candidate;
    insert into app.seat_claims (organisation_id, journey_id, journey_seat_id, booked_seat_id, occupied_from_seq, occupied_to_seq, state)
    values (v_booking.organisation_id, v_booking.journey_id, v_candidate, v_seat.id, 1, v_last_seq, 'CONFIRMED');
  end loop;
  return v_moved;
end
$$;

-- Applies a provider's result for an attempt (12.1, 12.4, 13.2a, 13.3).
-- Idempotent: a repeated, late or out-of-order result changes nothing after the
-- first success. Returns what happened.
create function app.apply_payment_result(
  p_attempt_id uuid,
  p_status text,
  p_amount bigint default null,
  p_currency text default null,
  p_provider_fee bigint default 0,
  p_provider_reference text default null
) returns text
language plpgsql
set search_path = ''
as $$
declare
  v_attempt record;
  v_booking record;
  v_payment_id uuid;
  v_moved int;
  v_placed boolean := true;
  v_live_claims int;
  v_seats int;
begin
  select * into v_attempt from app.payment_attempts where id = p_attempt_id for update;
  if not found then
    return 'unknown_attempt';
  end if;
  select * into v_booking from app.bookings where id = v_attempt.booking_id for update;

  if p_status = 'failed' then
    return app.fail_payment_attempt(p_attempt_id, 'The payment provider reported a failure');
  end if;
  if p_status <> 'success' then
    -- Pending, abandoned or unknown: never confirms anything (13.2a).
    return 'no_change';
  end if;

  if v_attempt.state = 'SUCCEEDED' then
    return 'duplicate';
  end if;
  if p_amount is distinct from v_attempt.amount_pesewas or p_currency is distinct from v_attempt.currency then
    perform app.raise_exception(v_booking.organisation_id, 'payment_amount_mismatch', 'critical', 'amount_mismatch:' || p_attempt_id,
      format('Booking %s: the provider reported %s %s but %s %s was expected.', v_booking.reference, p_currency, p_amount,
             v_attempt.currency, v_attempt.amount_pesewas),
      'Contact the provider, then refund or correct.', v_booking.id, v_booking.journey_id);
    return 'amount_mismatch';
  end if;

  -- The money is ours: record it once (11.8 #7) and post it (18.3a).
  update app.payment_attempts
    set state = 'SUCCEEDED', ended_at = now(), failure_reason = null,
        provider_reference = coalesce(provider_reference, p_provider_reference)
    where id = p_attempt_id;
  insert into app.payments (organisation_id, booking_id, attempt_id, amount_pesewas, currency, provider_fee_pesewas)
  values (v_booking.organisation_id, v_booking.id, p_attempt_id, p_amount, p_currency, coalesce(p_provider_fee, 0))
  returning id into v_payment_id;
  perform app.post_ledger(v_booking.organisation_id, 'Payment received',
    jsonb_build_array(jsonb_build_object('account', 'PROVIDER_CLEARING', 'amount', p_amount),
                      jsonb_build_object('account', 'DEFERRED_FARES', 'amount', -p_amount)),
    p_currency, v_booking.id, v_payment_id);
  if coalesce(p_provider_fee, 0) > 0 then
    perform app.post_ledger(v_booking.organisation_id, 'Provider fee',
      jsonb_build_array(jsonb_build_object('account', 'PROVIDER_FEES', 'amount', p_provider_fee),
                        jsonb_build_object('account', 'PROVIDER_CLEARING', 'amount', -p_provider_fee)),
      p_currency, v_booking.id, v_payment_id);
  end if;

  -- Already paid by another attempt: refund this one automatically (13.3 rule 6).
  if v_booking.state in ('CONFIRMED', 'COMPLETED') then
    perform app.create_system_refund(v_payment_id, 'duplicate_payment', p_amount, 'The booking was already paid');
    perform app.raise_exception(v_booking.organisation_id, 'duplicate_payment', 'high', 'duplicate_payment:' || v_payment_id,
      format('Booking %s was paid twice. The second payment is being refunded automatically.', v_booking.reference),
      'Confirm the automatic refund.', v_booking.id, v_booking.journey_id, v_payment_id);
    perform app.enqueue_message(v_booking.organisation_id, 'duplicate_payment_refunded',
      jsonb_build_object('bookingId', v_booking.id, 'paymentId', v_payment_id), 'duplicate_payment_refunded:' || v_payment_id);
    return 'duplicate_payment_refunded';
  end if;

  -- The normal path: the hold is still in place (even if its time just passed, nobody else can have the seats).
  if v_booking.state in ('PENDING', 'PAYMENT_PENDING') then
    select count(*) filter (where c.state = 'HELD'), count(distinct s.id) into v_live_claims, v_seats
      from app.booked_seats s left join app.seat_claims c on c.booked_seat_id = s.id
      where s.booking_id = v_booking.id;
    if v_live_claims = v_seats then
      perform app.confirm_booking(v_booking.id, 'booking_confirmed');
      return 'confirmed';
    end if;
    perform app.expire_booking(v_booking.id);
  end if;

  -- Success after the hold ended (12.4): same seats, else same class, else a full refund.
  perform set_config('app.late_payment', v_booking.id::text, true);
  begin
    v_moved := app.place_late_booking(v_booking.id);
  exception when sqlstate 'BR001' then
    v_placed := false;
  end;

  if v_placed and v_booking.state <> 'CANCELLED' then
    perform app.confirm_booking(v_booking.id, case when v_moved > 0 then 'late_payment_reseated' else 'booking_confirmed' end);
    perform set_config('app.late_payment', '', true);
    if v_moved > 0 then
      perform app.raise_exception(v_booking.organisation_id, 'payment_after_seat_released', 'critical', 'late_payment:' || v_booking.id,
        format('Booking %s was paid after its hold ended. %s passenger(s) were moved to a seat of the same class.', v_booking.reference, v_moved),
        'Confirm the re-seat.', v_booking.id, v_booking.journey_id, v_payment_id);
      return 'confirmed_reseated';
    end if;
    return 'confirmed_late';
  end if;

  perform set_config('app.late_payment', '', true);
  perform app.create_system_refund(v_payment_id, 'late_payment', p_amount, 'The seats were sold before the payment arrived');
  perform app.raise_exception(v_booking.organisation_id, 'payment_after_seat_released', 'critical', 'late_payment:' || v_booking.id,
    format('Booking %s was paid after its hold ended and no seat of the same class was free. A full refund has been approved.', v_booking.reference),
    'Complete the refund.', v_booking.id, v_booking.journey_id, v_payment_id);
  perform app.enqueue_message(v_booking.organisation_id, 'late_payment_refunded',
    jsonb_build_object('bookingId', v_booking.id, 'paymentId', v_payment_id), 'late_payment_refunded:' || v_booking.id);
  return 'refunded_late';
end
$$;

-- ====================================================================
-- 20261008100200_booking_3_security.sql
-- ====================================================================
-- Phase D: booking core, part 3 of 3: timestamps, never-delete rules, the
-- immutable ledger, audit, row-level security and grants for the new tables.

do $$
declare
  v_table text;
begin
  foreach v_table in array array['bookings', 'booked_seats', 'tickets', 'exceptions'] loop
    execute format('create trigger %1$s_updated_at before update on app.%1$I for each row execute function app.set_updated_at()', v_table);
  end loop;

  -- Money, tickets, boarding, callbacks and messages are never deleted (10.9).
  foreach v_table in array array['concession_verifications', 'bookings', 'booking_passengers', 'booked_seats', 'seat_claims',
                                 'tickets', 'ticket_credentials', 'payment_attempts', 'payments', 'refunds', 'webhook_events',
                                 'idempotency_keys', 'outbox', 'notification_deliveries', 'exceptions'] loop
    execute format('create trigger %1$s_no_delete before delete on app.%1$I for each row execute function app.refuse_delete()', v_table);
  end loop;

  -- Audited: privileged changes, payment state changes, ticket issue, refunds (19.8).
  foreach v_table in array array['payments', 'refunds', 'tickets', 'exceptions'] loop
    execute format('create trigger %1$s_audit after insert or update on app.%1$I for each row execute function app.audit_row_change()', v_table);
  end loop;

  foreach v_table in array array['concession_verifications', 'bookings', 'booking_passengers', 'booked_seats', 'seat_claims',
                                 'tickets', 'ticket_credentials', 'payment_attempts', 'payments', 'refunds', 'webhook_events',
                                 'idempotency_keys', 'outbox', 'notification_deliveries', 'ledger_entries', 'exceptions'] loop
    execute format('alter table app.%I enable row level security', v_table);
    execute format(
      'create policy org_boundary on app.%I to app_runtime using (organisation_id = app.current_organisation_id()) with check (organisation_id = app.current_organisation_id())',
      v_table);
    execute format('grant select, insert on app.%I to app_runtime', v_table);
  end loop;
end
$$;

-- Bookings carry personal data: mask it in audit values (19.4).
create trigger bookings_audit after insert or update on app.bookings
  for each row execute function app.audit_row_change('purchaser_name', 'purchaser_phone', 'purchaser_email', 'access_token_hash');

-- The ledger is append-only for every role, including the owner (10.9).
create trigger ledger_entries_immutable before update or delete on app.ledger_entries
  for each row execute function app.refuse_change();
create trigger ledger_entries_no_truncate before truncate on app.ledger_entries
  for each statement execute function app.refuse_change();

grant update on app.concession_verifications, app.bookings, app.booked_seats, app.seat_claims, app.tickets,
  app.ticket_credentials, app.payment_attempts, app.payments, app.refunds, app.webhook_events, app.idempotency_keys,
  app.outbox, app.notification_deliveries, app.exceptions to app_runtime;

grant execute on function
  app.random_code(int, text), app.is_late_payment_for(uuid), app.next_academic_year_end(uuid), app.bookings_before_update(), app.booked_seats_before_write(),
  app.seat_claims_before_write(), app.tickets_before_update(), app.ticket_credentials_before_update(),
  app.payment_attempts_before_update(), app.payments_before_update(), app.refund_counts(text), app.refunds_before_write(),
  app.webhook_events_before_update(), app.idempotency_keys_before_update(), app.ledger_posting_balances(),
  app.enqueue_message(uuid, text, jsonb, text), app.raise_exception(uuid, text, text, text, text, text, uuid, uuid, uuid, uuid),
  app.post_ledger(uuid, text, jsonb, text, uuid, uuid, uuid), app.create_system_refund(uuid, text, bigint, text, uuid),
  app.expire_booking(uuid), app.release_expired_claims(uuid[]), app.expire_holds(),
  app.hold_seats(uuid, uuid, uuid, jsonb, jsonb), app.begin_payment_attempt(uuid, text, text),
  app.fail_payment_attempt(uuid, text), app.issue_tickets(uuid), app.confirm_booking(uuid, text),
  app.place_late_booking(uuid), app.apply_payment_result(uuid, text, bigint, text, bigint, text)
to app_runtime;

revoke all on all tables in schema app from anon, authenticated;
revoke all on all functions in schema app from anon, authenticated;

-- Holds are released every minute (11.4). Correctness never depends on it:
-- every availability check treats an expired hold as free.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('expire-holds', '* * * * *', 'select app.expire_holds()');
  end if;
end
$$;

-- ====================================================================
-- 20261008120000_boarding.sql
-- ====================================================================
-- Phase E, slice 2: boarding (spec 14.3 to 14.7, 9.7, 10.9, 11.8 #5 and #6).
-- One boarding record per ticket, ever. Boarding is one function that checks in
-- the order of 14.3, writes the record and moves the ticket and seat in one
-- transaction. Refused attempts, duplicates included, go to the audit log.

insert into app.setting_definitions (key, decision, description, value_type, default_value) values
  ('boarding.opens_minutes_before', 'D13', 'Boarding can be started this long before departure', 'number', '120'),
  ('boarding.manifest_export_hours', 'D28', 'A paper manifest can be exported this long before departure', 'number', '24');

insert into app.settings (organisation_id, key, value)
select o.id, d.key, d.default_value
from app.organisations o
cross join app.setting_definitions d
where d.key in ('boarding.opens_minutes_before', 'boarding.manifest_export_hours')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Paper manifests (14.7, D28): numbered, audited, entered after the trip
-- ---------------------------------------------------------------------------

create table app.manifest_exports (
  id uuid primary key default app.uuid_v7(),
  organisation_id uuid not null,
  journey_id uuid not null,
  -- Printed on the sheet. Counts up per organisation.
  sheet_number int not null check (sheet_number > 0),
  ticket_count int not null check (ticket_count >= 0),
  exported_by uuid not null,
  exported_at timestamptz not null default now(),
  -- Null until the conductor says every paper boarding on the sheet has been entered.
  entered_at timestamptz,
  -- Null until entered.
  entered_by uuid,
  updated_at timestamptz not null default now(),
  unique (organisation_id, id),
  unique (organisation_id, journey_id, id),
  unique (organisation_id, sheet_number),
  foreign key (organisation_id, journey_id) references app.journeys (organisation_id, id),
  foreign key (organisation_id, exported_by) references app.users (organisation_id, id),
  foreign key (organisation_id, entered_by) references app.users (organisation_id, id),
  check ((entered_at is null) = (entered_by is null))
);

create index manifest_exports_open on app.manifest_exports (organisation_id, journey_id) where entered_at is null;

-- ---------------------------------------------------------------------------
-- Boarding records (10.4, 10.5): at most one per ticket, never changed
-- ---------------------------------------------------------------------------

create table app.boarding_records (
  id uuid primary key default app.uuid_v7(),
  organisation_id uuid not null,
  -- At most one boarding record per ticket, ever (11.8 #5).
  ticket_id uuid not null unique,
  journey_id uuid not null,
  booked_seat_id uuid not null,
  boarded_by uuid not null,
  -- The passenger's boarding stop.
  boarding_location_id uuid not null,
  method text not null check (method in ('scan', 'manual', 'override', 'manual_offline')),
  -- The server's clock.
  boarded_at timestamptz not null default now(),
  -- Only for manual_offline: the time written on the paper sheet, as entered.
  device_recorded_at timestamptz,
  -- Only for manual_offline: the sheet it came from.
  manifest_export_id uuid,
  -- Only for override: why the failed check was overridden.
  reason text check (length(reason) between 5 and 500),
  -- Null: not made through a web request.
  device text,
  unique (organisation_id, id),
  foreign key (organisation_id, ticket_id) references app.tickets (organisation_id, id),
  foreign key (organisation_id, journey_id, booked_seat_id) references app.booked_seats (organisation_id, journey_id, id),
  foreign key (organisation_id, journey_id, manifest_export_id) references app.manifest_exports (organisation_id, journey_id, id),
  foreign key (organisation_id, boarded_by) references app.users (organisation_id, id),
  foreign key (organisation_id, boarding_location_id) references app.locations (organisation_id, id),
  check ((method = 'manual_offline') = (device_recorded_at is not null)),
  check ((method = 'manual_offline') = (manifest_export_id is not null)),
  check ((method = 'override') = (reason is not null))
);

create index boarding_records_by_journey on app.boarding_records (journey_id, boarded_at);

-- Boarding records are evidence: no role may change or remove one (10.9, 11.8 #11).
create trigger boarding_records_immutable before update or delete on app.boarding_records
  for each row execute function app.refuse_change();
create trigger boarding_records_no_truncate before truncate on app.boarding_records
  for each statement execute function app.refuse_change();

create trigger manifest_exports_updated_at before update on app.manifest_exports
  for each row execute function app.set_updated_at();
create trigger manifest_exports_no_delete before delete on app.manifest_exports
  for each row execute function app.refuse_delete();

create trigger boarding_records_audit after insert on app.boarding_records
  for each row execute function app.audit_row_change();
create trigger manifest_exports_audit after insert or update on app.manifest_exports
  for each row execute function app.audit_row_change();

-- A ticket becomes BOARDED only together with its boarding record (14.3a).
create function app.tickets_boarded_check() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.state = 'BOARDED' and old.state <> 'BOARDED'
     and app.request_setting('boarding') is distinct from new.id::text then
    perform app.fail('A ticket is boarded only through the boarding function.');
  end if;
  return new;
end
$$;

create trigger tickets_boarded_check before update on app.tickets
  for each row execute function app.tickets_boarded_check();

-- ---------------------------------------------------------------------------
-- Journey status from the bus (journey.update.status)
-- ---------------------------------------------------------------------------

-- Start boarding, record departure, record arrival. Boarding opens only within
-- the setting's window before departure.
create function app.update_journey_status(p_journey_id uuid, p_to_state text) returns void
language plpgsql
set search_path = ''
as $$
declare
  v_journey record;
  v_window int;
begin
  select * into v_journey from app.journeys where id = p_journey_id;
  if not found then
    perform app.fail('That journey does not exist.');
  end if;
  if p_to_state not in ('BOARDING', 'DEPARTED', 'COMPLETED') then
    perform app.fail('Staff on the bus can only start boarding, record departure or record arrival.');
  end if;
  if p_to_state = 'BOARDING' then
    if v_journey.state not in ('SCHEDULED', 'SALES_CLOSED') then
      perform app.fail(case v_journey.state
        when 'BOARDING' then 'Boarding has already started.'
        when 'DRAFT' then 'This journey is not on sale yet, so boarding cannot start.'
        when 'CANCELLED' then 'This journey was cancelled.'
        else 'This journey has left.' end);
    end if;
    v_window := coalesce(app.setting_int(v_journey.organisation_id, 'boarding.opens_minutes_before'), 120);
    if now() < v_journey.scheduled_departure_at - make_interval(mins => v_window) then
      perform app.fail(format('Boarding can start from %s.',
        to_char((v_journey.scheduled_departure_at - make_interval(mins => v_window)) at time zone 'Africa/Accra', 'HH24:MI "on" DD Mon')));
    end if;
  elsif p_to_state = 'DEPARTED' and v_journey.state <> 'BOARDING' then
    perform app.fail('Start boarding before recording departure.');
  elsif p_to_state = 'COMPLETED' and v_journey.state <> 'DEPARTED' then
    perform app.fail('Record departure before recording arrival.');
  end if;
  perform app.move_journey(p_journey_id, p_to_state);
end
$$;

-- ---------------------------------------------------------------------------
-- Boarding (14.3, 14.3a, 14.4, 14.7)
-- ---------------------------------------------------------------------------

-- A short description of a journey for staff: "Accra to Cape Coast, 08 Oct 07:00".
create function app.journey_label(p_journey_id uuid) returns text
language sql stable
set search_path = ''
as $$
  select r.name || ', ' || to_char(j.scheduled_departure_at at time zone 'Africa/Accra', 'DD Mon HH24:MI')
  from app.journeys j join app.routes r on r.id = j.route_id where j.id = p_journey_id
$$;

-- What a conductor sees about a ticket: no more personal data than boarding needs (14.5).
create function app.boarding_view(p_ticket_id uuid) returns jsonb
language sql stable
set search_path = ''
as $$
  select jsonb_build_object(
    'ticketId', t.id,
    'ticketNumber', t.ticket_number,
    'reference', b.reference,
    'passengerName', p.full_name,
    'seatNumber', js.seat_number,
    'boardingStop', lo.name,
    'destination', ld.name,
    'fareType', coalesce(ct.name, 'Standard'),
    'checkStudentId', coalesce(ct.check_at_boarding, false))
  from app.tickets t
  join app.booked_seats s on s.id = t.booked_seat_id
  join app.bookings b on b.id = s.booking_id
  join app.booking_passengers p on p.id = s.passenger_id
  join app.journey_seats js on js.id = s.journey_seat_id
  join app.route_stops so on so.id = s.origin_stop_id
  join app.locations lo on lo.id = so.location_id
  join app.route_stops sd on sd.id = s.destination_stop_id
  join app.locations ld on ld.id = sd.location_id
  left join app.concession_types ct on ct.id = s.concession_type_id
  where t.id = p_ticket_id
$$;

-- Checks a ticket for boarding on a journey in the order of 14.3 and, unless
-- p_check_only, boards it. Never raises for a refused check: it records the
-- refusal in the audit log and returns it, so the record survives.
--   p_ticket_id null: the scanned credential matched no current ticket.
--   p_method: scan, manual, override (reason in app.reason) or manual_offline.
-- Returns {outcome: ok | boarded | refused, code, message, ticket}.
create function app.board_ticket(
  p_journey_id uuid,
  p_ticket_id uuid,
  p_method text,
  p_check_only boolean default false,
  p_device_time timestamptz default null,
  p_manifest_export_id uuid default null
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_journey record;
  v_ticket app.tickets;
  v_seat record;
  v_booking app.bookings;
  v_export app.manifest_exports;
  v_code text;
  v_message text;
  v_prior record;
  v_location uuid;
  v_view jsonb;
  v_rows int;
begin
  if p_method not in ('scan', 'manual', 'override', 'manual_offline') then
    perform app.fail('Unknown boarding method.');
  end if;
  select * into v_journey from app.journeys where id = p_journey_id;
  if not found then
    perform app.fail('That journey does not exist.');
  end if;
  if p_method = 'override' and app.request_setting('reason') is null then
    perform app.fail('Give a reason for boarding against a failed check.');
  end if;
  if p_method = 'manual_offline' and not p_check_only then
    if p_device_time is null then
      perform app.fail('Enter the time written on the sheet.');
    end if;
    select * into v_export from app.manifest_exports where id = p_manifest_export_id and journey_id = p_journey_id;
    if not found then
      perform app.fail('That paper manifest is not for this journey.');
    end if;
  end if;

  -- The ticket row lock serialises every attempt on one ticket (14.3a).
  if p_ticket_id is not null then
    select * into v_ticket from app.tickets where id = p_ticket_id for update;
  end if;

  if v_ticket.id is null then
    v_code := 'invalid';
    v_message := 'This ticket is not valid.';
  elsif v_ticket.journey_id <> p_journey_id then
    v_code := 'wrong_journey';
    v_message := 'This ticket is for a different journey: ' || app.journey_label(v_ticket.journey_id) || '.';
  elsif v_journey.state = 'CANCELLED' then
    v_code := 'journey_cancelled';
    v_message := 'This journey was cancelled. Send the passenger to the station desk.';
  elsif p_method = 'manual_offline' and v_journey.state not in ('BOARDING', 'DEPARTED', 'COMPLETED') then
    v_code := 'not_open';
    v_message := 'Paper boardings are entered once boarding has started.';
  elsif p_method in ('scan', 'manual') and v_journey.state in ('DRAFT', 'SCHEDULED', 'SALES_CLOSED') then
    v_code := 'not_open';
    v_message := 'Boarding has not opened.';
  elsif p_method in ('scan', 'manual') and v_journey.state in ('DEPARTED', 'COMPLETED') then
    v_code := 'journey_left';
    v_message := 'This journey has left.';
  elsif p_method = 'override' and v_journey.state in ('DRAFT', 'COMPLETED') then
    v_code := 'journey_left';
    v_message := 'This journey cannot take boardings.';
  elsif v_ticket.state = 'BOARDED' then
    select r.boarded_at, coalesce(split_part(u.full_name, ' ', 1), 'another staff member') as by_name
      into v_prior
      from app.boarding_records r join app.users u on u.id = r.boarded_by where r.ticket_id = v_ticket.id;
    v_code := 'already_boarded';
    v_message := format('Already boarded at %s by %s.', to_char(v_prior.boarded_at at time zone 'Africa/Accra', 'HH24:MI'), v_prior.by_name);
  elsif v_ticket.state = 'CANCELLED' then
    if p_method = 'manual_offline' and v_export.id is not null and v_ticket.updated_at > v_export.exported_at then
      v_code := 'cancelled_after_export';
      v_message := 'This ticket was cancelled after the paper manifest was printed. It has been flagged for review.';
      if not p_check_only then
        select b.* into v_booking from app.booked_seats s join app.bookings b on b.id = s.booking_id where s.id = v_ticket.booked_seat_id;
        perform app.raise_exception(v_journey.organisation_id, 'boarded_after_cancellation', 'high',
          'boarded_after_cancellation:' || v_ticket.id::text,
          format('Ticket %s was boarded from a paper manifest after it had been cancelled.', v_ticket.ticket_number),
          'Check whether the passenger travelled and whether a refund was paid for this seat.',
          v_booking.id, p_journey_id);
      end if;
    else
      v_code := 'ticket_cancelled';
      v_message := 'This ticket was cancelled.';
    end if;
  elsif v_ticket.state <> 'VALID' then
    v_code := 'ticket_not_valid';
    v_message := 'This ticket is not valid.';
  else
    select s.*, so.location_id as boarding_location_id into v_seat
      from app.booked_seats s join app.route_stops so on so.id = s.origin_stop_id where s.id = v_ticket.booked_seat_id;
    select * into v_booking from app.bookings where id = v_seat.booking_id;
    if p_method <> 'override' and (
         v_seat.state <> 'CONFIRMED'
         or v_booking.state not in ('CONFIRMED', 'COMPLETED')
         or exists (select 1 from app.payments where booking_id = v_booking.id and state = 'REVERSED')
         or not exists (select 1 from app.payments where booking_id = v_booking.id and state = 'RECEIVED')) then
      v_code := 'payment_attention';
      v_message := 'Payment needs attention. Send the passenger to the station desk.';
    end if;
  end if;

  if v_ticket.id is not null and v_ticket.journey_id = p_journey_id then
    v_view := app.boarding_view(v_ticket.id);
  end if;

  if v_code is not null then
    perform app.write_audit('ticket.board_refused', 'ticket', v_ticket.id::text, null,
      jsonb_build_object('journeyId', p_journey_id, 'method', p_method, 'code', v_code, 'checkOnly', p_check_only));
    return jsonb_build_object('outcome', 'refused', 'code', v_code, 'message', v_message, 'ticket', v_view);
  end if;

  if p_check_only then
    return jsonb_build_object('outcome', 'ok', 'code', null, 'message', null, 'ticket', v_view);
  end if;

  perform set_config('app.boarding', v_ticket.id::text, true);
  update app.tickets set state = 'BOARDED' where id = v_ticket.id and state = 'VALID';
  get diagnostics v_rows = row_count;
  perform set_config('app.boarding', '', true);
  if v_rows <> 1 then
    perform app.fail('The ticket was changed by someone else. Scan it again.');
  end if;
  update app.booked_seats set state = 'BOARDED' where id = v_seat.id and state = 'CONFIRMED';

  insert into app.boarding_records (organisation_id, ticket_id, journey_id, booked_seat_id, boarded_by, boarding_location_id,
                                    method, device_recorded_at, manifest_export_id, reason, device)
  values (v_ticket.organisation_id, v_ticket.id, p_journey_id, v_seat.id, app.current_actor_id(), v_seat.boarding_location_id,
          p_method,
          case when p_method = 'manual_offline' then p_device_time end,
          case when p_method = 'manual_offline' then p_manifest_export_id end,
          case when p_method = 'override' then app.request_setting('reason') end,
          app.request_setting('device'));

  return jsonb_build_object('outcome', 'boarded', 'code', null, 'message', null, 'ticket', v_view);
end
$$;

-- Numbers and records a paper manifest export (14.7). Returns the export.
create function app.export_manifest(p_journey_id uuid) returns app.manifest_exports
language plpgsql
set search_path = ''
as $$
declare
  v_journey record;
  v_hours int;
  v_number int;
  v_count int;
  v_export app.manifest_exports;
begin
  select * into v_journey from app.journeys where id = p_journey_id;
  if not found then
    perform app.fail('That journey does not exist.');
  end if;
  if v_journey.state in ('DRAFT', 'CANCELLED', 'COMPLETED') then
    perform app.fail('A manifest can be printed only for a journey that is on sale or boarding.');
  end if;
  v_hours := coalesce(app.setting_int(v_journey.organisation_id, 'boarding.manifest_export_hours'), 24);
  if now() < v_journey.scheduled_departure_at - make_interval(hours => v_hours) then
    perform app.fail(format('The manifest can be printed from %s hours before departure.', v_hours));
  end if;
  -- Sheet numbers count up per organisation; the lock keeps them unique and gap-free.
  perform pg_advisory_xact_lock(hashtext('manifest_exports:' || v_journey.organisation_id::text));
  select coalesce(max(sheet_number), 0) + 1 into v_number from app.manifest_exports where organisation_id = v_journey.organisation_id;
  select count(*) into v_count from app.tickets where journey_id = p_journey_id and state in ('VALID', 'BOARDED');
  insert into app.manifest_exports (organisation_id, journey_id, sheet_number, ticket_count, exported_by)
  values (v_journey.organisation_id, p_journey_id, v_number, v_count, app.current_actor_id())
  returning * into v_export;
  return v_export;
end
$$;

-- The conductor confirms every paper boarding on a sheet has been entered.
create function app.close_manifest_export(p_export_id uuid) returns void
language plpgsql
set search_path = ''
as $$
declare
  v_rows int;
begin
  update app.manifest_exports set entered_at = now(), entered_by = app.current_actor_id()
    where id = p_export_id and entered_at is null;
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    perform app.fail('That sheet has already been marked as entered.');
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Row-level security and grants
-- ---------------------------------------------------------------------------

alter table app.manifest_exports enable row level security;
alter table app.boarding_records enable row level security;
create policy org_boundary on app.manifest_exports to app_runtime
  using (organisation_id = app.current_organisation_id()) with check (organisation_id = app.current_organisation_id());
create policy org_boundary on app.boarding_records to app_runtime
  using (organisation_id = app.current_organisation_id()) with check (organisation_id = app.current_organisation_id());

grant select, insert on app.manifest_exports, app.boarding_records to app_runtime;
grant update on app.manifest_exports to app_runtime;

grant execute on function
  app.tickets_boarded_check(), app.update_journey_status(uuid, text), app.journey_label(uuid), app.boarding_view(uuid),
  app.board_ticket(uuid, uuid, text, boolean, timestamptz, uuid), app.export_manifest(uuid), app.close_manifest_export(uuid)
to app_runtime;

revoke all on app.manifest_exports, app.boarding_records from anon, authenticated;
revoke all on function
  app.tickets_boarded_check(), app.update_journey_status(uuid, text), app.journey_label(uuid), app.boarding_view(uuid),
  app.board_ticket(uuid, uuid, text, boolean, timestamptz, uuid), app.export_manifest(uuid), app.close_manifest_export(uuid)
from anon, authenticated;

insert into supabase_migrations.schema_migrations (version, name) values
  ('20261008075400', 'scheduling_7_assign_vehicle'),
  ('20261008100000', 'booking_1_tables'),
  ('20261008100100', 'booking_2_procedures'),
  ('20261008100200', 'booking_3_security'),
  ('20261008120000', 'boarding')
on conflict (version) do nothing;

commit;
