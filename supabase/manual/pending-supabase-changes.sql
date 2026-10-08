-- Run this once in Supabase → project "transport" → SQL Editor → Run.
-- It applies every database change not yet on Supabase, in order, in one
-- transaction: all of it applies, or none of it. It also records each change in
-- Supabase's migration history so later updates line up.
-- Included: scheduling_7_assign_vehicle, booking_1_tables, booking_2_procedures, booking_3_security, boarding, operations_dashboard, cancellations_refunds, vehicle_change

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

-- ====================================================================
-- 20261008130000_operations_dashboard.sql
-- ====================================================================
-- Phase E, slice 3, part 1: the needs-attention queue (9.11, 18.6), the checks
-- that raise and clear operational exceptions, and settling journeys after
-- arrival (no-shows). Written to be safe to run twice where it can be.

insert into app.permissions (code, description, high_risk) values
  ('exception.manage',  'Take, work and resolve needs-attention items', false),
  ('exception.dismiss', 'Dismiss a needs-attention item without fixing it, with a reason', true)
on conflict (code) do nothing;

-- The built-in roles that hold the new permissions. A trigger gives them to the
-- roles of every new organisation; existing organisations are updated below.
create function app.builtin_role_permissions_v2() returns table (role_name text, code text)
language sql immutable
set search_path = ''
as $$
  values ('Operations Manager', 'exception.manage'), ('Operations Manager', 'exception.dismiss'),
         ('Finance', 'exception.manage'), ('Finance', 'exception.dismiss'),
         ('Support', 'exception.manage')
$$;

create function app.roles_after_insert() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.is_system then
    insert into app.role_permissions (organisation_id, role_id, permission_code)
    select new.organisation_id, new.id, p.code from app.builtin_role_permissions_v2() p where p.role_name = new.name
    on conflict do nothing;
  end if;
  return null;
end
$$;

create trigger roles_after_insert after insert on app.roles
  for each row execute function app.roles_after_insert();

insert into app.role_permissions (organisation_id, role_id, permission_code)
select r.organisation_id, r.id, p.code
from app.roles r join app.builtin_role_permissions_v2() p on p.role_name = r.name
where r.is_system
on conflict do nothing;

-- New settings for this slice.
insert into app.setting_definitions (key, decision, description, value_type, default_value) values
  ('journeys.bus_missing_alert_hours', 'D27', 'A journey with no bus this close to departure needs attention', 'number', '24'),
  ('boarding.no_show_after_hours', null, 'Hours after arrival when unboarded seats become no-shows, once paper sheets are entered', 'number', '6')
on conflict (key) do nothing;

insert into app.settings (organisation_id, key, value)
select o.id, d.key, d.default_value
from app.organisations o cross join app.setting_definitions d
where d.key in ('journeys.bus_missing_alert_hours', 'boarding.no_show_after_hours')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Exception state machine (9.11). Only app.move_exception changes state.
-- ---------------------------------------------------------------------------

create function app.exceptions_before_update() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_allowed text[];
begin
  if (new.kind, new.severity, new.dedupe_key, new.booking_id, new.journey_id, new.payment_id, new.refund_id, new.created_at)
     is distinct from
     (old.kind, old.severity, old.dedupe_key, old.booking_id, old.journey_id, old.payment_id, old.refund_id, old.created_at) then
    perform app.fail('What a needs-attention item is about cannot change.');
  end if;
  if old.state in ('RESOLVED', 'DISMISSED') then
    perform app.fail('This item is already closed.');
  end if;
  if new.state is distinct from old.state then
    if app.request_setting('state_move') is distinct from 'exception:' || old.id::text then
      perform app.fail('A needs-attention item changes only through its status function.');
    end if;
    v_allowed := case old.state
      when 'OPEN' then array['ACKNOWLEDGED', 'IN_PROGRESS', 'RESOLVED', 'DISMISSED']
      when 'ACKNOWLEDGED' then array['IN_PROGRESS', 'RESOLVED', 'DISMISSED']
      when 'IN_PROGRESS' then array['RESOLVED', 'DISMISSED']
      else array[]::text[]
    end;
    if not new.state = any(v_allowed) then
      perform app.fail(format('A needs-attention item cannot go from %s to %s.', old.state, new.state));
    end if;
    if new.state in ('RESOLVED', 'DISMISSED') then
      new.resolved_at := now();
    end if;
  end if;
  return new;
end
$$;

create trigger exceptions_before_update before update on app.exceptions
  for each row execute function app.exceptions_before_update();

-- Takes, works, resolves or dismisses an item. A resolution or dismissal needs a note.
-- p_owner: who owns it afterwards (null keeps the current owner).
create function app.move_exception(p_exception_id uuid, p_to_state text, p_note text default null, p_owner uuid default null)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_from text;
  v_rows int;
begin
  select state into v_from from app.exceptions where id = p_exception_id for update;
  if v_from is null then
    perform app.fail('That item does not exist.');
  end if;
  if p_to_state in ('RESOLVED', 'DISMISSED') and length(trim(coalesce(p_note, ''))) < 5 then
    perform app.fail(case p_to_state when 'RESOLVED' then 'Say what was done (at least 5 characters).'
                                     else 'Say why it is being dismissed (at least 5 characters).' end);
  end if;
  perform set_config('app.state_move', 'exception:' || p_exception_id::text, true);
  update app.exceptions
    set state = p_to_state,
        owner_id = coalesce(p_owner, owner_id),
        resolution = case when p_to_state in ('RESOLVED', 'DISMISSED') then trim(p_note) else resolution end
    where id = p_exception_id and state = v_from;
  get diagnostics v_rows = row_count;
  perform set_config('app.state_move', '', true);
  if v_rows <> 1 then
    perform app.fail('Someone else changed this item. Refresh and try again.');
  end if;
end
$$;

-- Takes ownership; an OPEN item becomes ACKNOWLEDGED. Ownership changes are audited.
create function app.take_exception(p_exception_id uuid) returns void
language plpgsql
set search_path = ''
as $$
declare
  v_state text;
begin
  select state into v_state from app.exceptions where id = p_exception_id for update;
  if v_state is null then
    perform app.fail('That item does not exist.');
  end if;
  if v_state in ('RESOLVED', 'DISMISSED') then
    perform app.fail('This item is already closed.');
  end if;
  if v_state = 'OPEN' then
    perform app.move_exception(p_exception_id, 'ACKNOWLEDGED', null, app.current_actor_id());
  else
    update app.exceptions set owner_id = app.current_actor_id() where id = p_exception_id;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Causes that open and clear exceptions by themselves (18.6)
-- ---------------------------------------------------------------------------

-- A boarding against a failed check is reviewed by a manager (18.6: Normal).
create function app.boarding_records_after_insert() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_booking uuid;
  v_ticket text;
begin
  if new.method = 'override' then
    select s.booking_id, t.ticket_number into v_booking, v_ticket
      from app.tickets t join app.booked_seats s on s.id = t.booked_seat_id where t.id = new.ticket_id;
    perform app.raise_exception(new.organisation_id, 'boarding_override', 'normal', 'boarding_override:' || new.ticket_id::text,
      format('Ticket %s was boarded against a failed check. Reason given: %s', v_ticket, new.reason),
      'Review the reason given.', v_booking, new.journey_id);
  end if;
  return null;
end
$$;

create trigger boarding_records_after_insert after insert on app.boarding_records
  for each row execute function app.boarding_records_after_insert();

-- Closes an item whose cause has cleared, recording that it closed itself (9.11).
create function app.resolve_exception_automatically(p_dedupe_key text, p_note text) returns void
language plpgsql
set search_path = ''
as $$
declare
  v_id uuid;
begin
  select id into v_id from app.exceptions
    where organisation_id = app.current_organisation_id() and dedupe_key = p_dedupe_key and state not in ('RESOLVED', 'DISMISSED');
  if v_id is not null then
    perform app.move_exception(v_id, 'RESOLVED', p_note);
  end if;
end
$$;

-- Runs every minute from the job: raises "bus missing" and "paper boardings not
-- entered", and clears them once fixed. Returns how many items it opened.
create function app.check_operations() returns int
language plpgsql
set search_path = ''
as $$
declare
  v_org uuid := app.current_organisation_id();
  v_hours int := coalesce(app.setting_int(v_org, 'journeys.bus_missing_alert_hours'), 24);
  v_journey record;
  v_before int;
  v_after int;
begin
  select count(*) into v_before from app.exceptions where organisation_id = v_org;

  for v_journey in
    select j.id, app.journey_label(j.id) as label from app.journeys j
    where j.organisation_id = v_org
      and j.state in ('DRAFT', 'SCHEDULED', 'SALES_CLOSED')
      and j.scheduled_departure_at between now() and now() + make_interval(hours => v_hours)
      and not exists (select 1 from app.vehicle_assignments a where a.journey_id = j.id and a.state = 'ACTIVE')
  loop
    perform app.raise_exception(v_org, 'bus_missing', 'high', 'bus_missing:' || v_journey.id::text,
      'Bus missing: ' || v_journey.label, 'Assign a bus.', null, v_journey.id);
  end loop;

  for v_journey in
    select distinct j.id, app.journey_label(j.id) as label from app.journeys j
    join app.manifest_exports m on m.journey_id = j.id and m.entered_at is null
    where j.organisation_id = v_org and j.state = 'COMPLETED'
  loop
    perform app.raise_exception(v_org, 'paper_boardings_not_entered', 'normal', 'paper_boardings:' || v_journey.id::text,
      'Paper boardings not entered: ' || v_journey.label,
      'Ask the conductor to enter the ticks from the paper sheet and return it.', null, v_journey.id);
  end loop;

  -- Causes that have cleared.
  for v_journey in
    select e.dedupe_key, e.journey_id, e.kind from app.exceptions e
    where e.organisation_id = v_org and e.state not in ('RESOLVED', 'DISMISSED')
      and e.kind in ('bus_missing', 'paper_boardings_not_entered')
  loop
    if v_journey.kind = 'bus_missing' and exists (
         select 1 from app.journeys j where j.id = v_journey.journey_id
         and (j.state = 'CANCELLED' or exists (select 1 from app.vehicle_assignments a where a.journey_id = j.id and a.state = 'ACTIVE'))) then
      perform app.resolve_exception_automatically(v_journey.dedupe_key, 'Closed automatically: a bus was assigned or the journey was cancelled.');
    elsif v_journey.kind = 'paper_boardings_not_entered'
          and not exists (select 1 from app.manifest_exports m where m.journey_id = v_journey.journey_id and m.entered_at is null) then
      perform app.resolve_exception_automatically(v_journey.dedupe_key, 'Closed automatically: every paper sheet was entered.');
    end if;
  end loop;

  select count(*) into v_after from app.exceptions where organisation_id = v_org;
  return v_after - v_before;
end
$$;

-- ---------------------------------------------------------------------------
-- After arrival: no-shows and completed bookings (9.3, 9.4, 9.7)
-- ---------------------------------------------------------------------------

-- Once a journey has arrived, its paper sheets are entered and the waiting
-- time has passed, seats nobody boarded become NO_SHOW, unused tickets
-- EXPIRED, and paid bookings COMPLETED. Returns the number of journeys settled.
create function app.settle_completed_journeys() returns int
language plpgsql
set search_path = ''
as $$
declare
  v_org uuid := app.current_organisation_id();
  v_hours int := coalesce(app.setting_int(v_org, 'boarding.no_show_after_hours'), 6);
  v_journey uuid;
  v_count int := 0;
begin
  for v_journey in
    select j.id from app.journeys j
    where j.organisation_id = v_org and j.state = 'COMPLETED'
      and j.actual_arrival_at < now() - make_interval(hours => v_hours)
      and not exists (select 1 from app.manifest_exports m where m.journey_id = j.id and m.entered_at is null)
      and exists (select 1 from app.bookings b where b.journey_id = j.id and b.state = 'CONFIRMED')
    for update skip locked
  loop
    update app.tickets set state = 'EXPIRED' where journey_id = v_journey and state = 'VALID';
    update app.booked_seats set state = 'NO_SHOW' where journey_id = v_journey and state = 'CONFIRMED';
    update app.bookings set state = 'COMPLETED' where journey_id = v_journey and state = 'CONFIRMED';
    v_count := v_count + 1;
  end loop;
  return v_count;
end
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

grant execute on function
  app.exceptions_before_update(), app.move_exception(uuid, text, text, uuid), app.take_exception(uuid),
  app.boarding_records_after_insert(), app.resolve_exception_automatically(text, text), app.check_operations(),
  app.settle_completed_journeys()
to app_runtime;

grant execute on function app.builtin_role_permissions_v2(), app.roles_after_insert() to app_runtime;

revoke all on function
  app.builtin_role_permissions_v2(), app.roles_after_insert(), app.exceptions_before_update(), app.move_exception(uuid, text, text, uuid),
  app.take_exception(uuid), app.boarding_records_after_insert(), app.resolve_exception_automatically(text, text),
  app.check_operations(), app.settle_completed_journeys()
from anon, authenticated;

-- ====================================================================
-- 20261008140000_cancellations_refunds.sql
-- ====================================================================
-- Phase E, slice 4: cancellations and refunds (spec 15.2, 16, 9.6, 11.8 #8, D14, D32).
-- The refund amount is always worked out here from the policy a booking was
-- sold under; the client never supplies it (16.2 rule 1).

insert into app.setting_definitions (key, decision, description, value_type, default_value) values
  ('refund.approval_threshold_pesewas', null, 'Passenger refunds inside the policy above this amount wait for Finance; 0 means none wait (16.3)', 'number', '0'),
  ('refund.max_attempts', 'D32', 'Provider attempts before a refund is handed to Finance', 'number', '5')
on conflict (key) do nothing;

insert into app.settings (organisation_id, key, value)
select o.id, d.key, d.default_value
from app.organisations o cross join app.setting_definitions d
where d.key in ('refund.approval_threshold_pesewas', 'refund.max_attempts')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- A booking keeps the refund policy shown when it was made (16.1)
-- ---------------------------------------------------------------------------

alter table app.bookings add column refund_policy jsonb;

create function app.bookings_refund_policy() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    select value into new.refund_policy from app.settings where organisation_id = new.organisation_id and key = 'refund.policy';
  elsif new.refund_policy is distinct from old.refund_policy and old.refund_policy is not null then
    perform app.fail('A booking keeps the refund policy it was sold under.');
  end if;
  return new;
end
$$;

create trigger bookings_refund_policy before insert or update on app.bookings
  for each row execute function app.bookings_refund_policy();

-- Bookings made before this change keep today's policy, which is the one they were shown.
update app.bookings b set refund_policy = s.value
  from app.settings s where s.organisation_id = b.organisation_id and s.key = 'refund.policy' and b.refund_policy is null;

-- ---------------------------------------------------------------------------
-- Refund processing columns (16.4, 16.4a)
-- ---------------------------------------------------------------------------

alter table app.refunds
  -- Provider attempts so far; after refund.max_attempts the refund is FAILED and goes to Finance.
  add column attempts int not null default 0 check (attempts >= 0),
  -- When the processor may try again.
  add column next_attempt_at timestamptz not null default now(),
  -- Why the last attempt failed. Null when it has not failed.
  add column last_error text check (length(last_error) <= 500),
  -- For a manual payout: who recorded it. A different person confirms it (16.4a).
  add column manual_recorded_by uuid,
  -- Null until a manual payout is confirmed.
  add column confirmed_by uuid,
  add constraint refunds_manual_recorded_by_fk foreign key (organisation_id, manual_recorded_by) references app.users (organisation_id, id),
  add constraint refunds_confirmed_by_fk foreign key (organisation_id, confirmed_by) references app.users (organisation_id, id),
  add constraint refunds_manual_confirmed_by_other check (manual_recorded_by is null or confirmed_by is null or manual_recorded_by <> confirmed_by);

-- One live refund per seat for a passenger cancellation (16.2 rule 3).
create unique index refunds_one_cancellation_per_seat on app.refunds (booked_seat_id)
  where booked_seat_id is not null and kind in ('passenger_cancellation', 'operator_cancellation') and state <> 'REJECTED';

create index refunds_due on app.refunds (next_attempt_at) where state = 'APPROVED';

-- ---------------------------------------------------------------------------
-- No seat can be claimed on a journey that is not running (closes a late
-- payment for a cancelled or departed journey into a refund, 12.4, 15.2)
-- ---------------------------------------------------------------------------

create function app.seat_claims_journey_running() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (select 1 from app.journeys where id = new.journey_id and state in ('CANCELLED', 'DEPARTED', 'COMPLETED')) then
    perform app.fail('This journey is not running, so its seats cannot be taken.');
  end if;
  return new;
end
$$;

create trigger seat_claims_journey_running before insert on app.seat_claims
  for each row execute function app.seat_claims_journey_running();

-- A journey with passengers is cancelled only through the cancellation procedure (15.2).
create function app.journeys_cancel_guard() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.state = 'CANCELLED' and old.state <> 'CANCELLED'
     and app.request_setting('journey_cancellation') is distinct from new.id::text
     and exists (select 1 from app.bookings b where b.journey_id = new.id and b.state in ('PENDING', 'PAYMENT_PENDING', 'CONFIRMED')) then
    perform app.fail('This journey has passengers. Cancel it through the cancellation steps, which refund everyone.');
  end if;
  return new;
end
$$;

create trigger journeys_cancel_guard before update on app.journeys
  for each row execute function app.journeys_cancel_guard();

-- ---------------------------------------------------------------------------
-- The refund policy, applied (16.1, 16.2)
-- ---------------------------------------------------------------------------

-- What a cancellation of one seat refunds now. p_kind:
--   passenger_cancellation: the booking's policy bands by hours before departure;
--   operator_cancellation: the seat's whole amount, including its share of fees.
-- Returns {amount, percent, feeDeducted, hoursBefore, allowed, reason}.
create function app.refund_quote(p_booked_seat_id uuid, p_kind text) returns jsonb
language plpgsql stable
set search_path = ''
as $$
declare
  v_seat record;
  v_hours numeric;
  v_band jsonb;
  v_percent int;
  v_fare bigint;
  v_fee bigint := 0;
  v_amount bigint;
  v_payment record;
begin
  select s.*, b.refund_policy, b.total_pesewas as booking_total, b.state as booking_state,
         j.scheduled_departure_at + make_interval(mins => o.departure_offset_minutes) as departs_at, j.state as journey_state
    into v_seat
    from app.booked_seats s
    join app.bookings b on b.id = s.booking_id
    join app.journeys j on j.id = s.journey_id
    join app.route_stops o on o.id = s.origin_stop_id
    where s.id = p_booked_seat_id;
  if not found then
    perform app.fail('That seat does not exist.');
  end if;
  if v_seat.state <> 'CONFIRMED' then
    return jsonb_build_object('allowed', false, 'amount', 0, 'percent', 0, 'feeDeducted', 0, 'hoursBefore', null,
      'reason', case v_seat.state when 'BOARDED' then 'This passenger has already boarded.'
                                  when 'CANCELLED' then 'This seat is already cancelled.'
                                  when 'NO_SHOW' then 'This journey has already happened.'
                                  else 'This seat was never paid for, so there is nothing to refund.' end);
  end if;
  v_hours := round(extract(epoch from (v_seat.departs_at - now())) / 3600.0, 1);

  if p_kind = 'operator_cancellation' then
    v_percent := coalesce((v_seat.refund_policy ->> 'operator_cancellation_percent')::int, 100);
    v_amount := case when coalesce((v_seat.refund_policy ->> 'operator_cancellation_includes_fees')::boolean, true)
                     then v_seat.amount_pesewas
                     else v_seat.base_pesewas - v_seat.concession_pesewas end * v_percent / 100;
    return jsonb_build_object('allowed', true, 'amount', v_amount, 'percent', v_percent, 'feeDeducted', 0, 'hoursBefore', v_hours, 'reason', null);
  end if;

  if v_seat.journey_state not in ('SCHEDULED', 'SALES_CLOSED', 'BOARDING') or v_hours <= 0 then
    return jsonb_build_object('allowed', false, 'amount', 0, 'percent', 0, 'feeDeducted', 0, 'hoursBefore', v_hours,
      'reason', 'The bus has already left, so this seat can no longer be cancelled.');
  end if;

  -- The first band whose minimum hours the cancellation meets (bands are listed from the most notice down).
  select band into v_band from jsonb_array_elements(v_seat.refund_policy -> 'bands') band
    where v_hours >= (band ->> 'min_hours_before')::numeric
    order by (band ->> 'min_hours_before')::numeric desc limit 1;
  v_percent := coalesce((v_band ->> 'refund_percent')::int, 0);
  v_fare := v_seat.base_pesewas - v_seat.concession_pesewas;
  v_amount := (v_fare * v_percent + 50) / 100;
  if coalesce((v_band ->> 'deduct_provider_fee')::boolean, false) and v_amount > 0 then
    -- This seat's share of the provider's fee on the payment that paid for it.
    select p.provider_fee_pesewas, p.amount_pesewas into v_payment from app.payments p
      where p.booking_id = v_seat.booking_id and p.state = 'RECEIVED' order by p.received_at limit 1;
    if v_payment.amount_pesewas > 0 then
      v_fee := (v_payment.provider_fee_pesewas * v_seat.amount_pesewas + v_payment.amount_pesewas / 2) / v_payment.amount_pesewas;
    end if;
    v_amount := greatest(v_amount - v_fee, 0);
  end if;
  return jsonb_build_object('allowed', true, 'amount', v_amount, 'percent', v_percent, 'feeDeducted', v_fee, 'hoursBefore', v_hours, 'reason', null);
end
$$;

-- The payment a refund for this booking draws on: the earliest received payment
-- with enough left that has not been refunded.
create function app.refundable_payment(p_booking_id uuid, p_amount bigint) returns uuid
language sql stable
set search_path = ''
as $$
  select id from app.payments
  where booking_id = p_booking_id and state = 'RECEIVED' and amount_pesewas - refunded_pesewas >= p_amount
  order by received_at limit 1
$$;

-- Approves a refund: moves it to APPROVED and posts it to refunds payable (18.3a).
create function app.approve_refund_internal(p_refund_id uuid, p_approver uuid) returns void
language plpgsql
set search_path = ''
as $$
declare
  v_refund record;
  v_journey_state text;
  v_rows int;
begin
  select r.*, b.journey_id into v_refund from app.refunds r join app.bookings b on b.id = r.booking_id where r.id = p_refund_id for update of r;
  update app.refunds set state = 'APPROVED', approved_by = p_approver, approved_at = now(), next_attempt_at = now()
    where id = p_refund_id and state = 'REQUESTED';
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    perform app.fail('This refund is no longer waiting for approval.');
  end if;
  select state into v_journey_state from app.journeys where id = v_refund.journey_id;
  perform app.post_ledger(v_refund.organisation_id, 'Refund approved: ' || v_refund.kind,
    jsonb_build_array(
      jsonb_build_object('account', case when v_journey_state = 'COMPLETED' then 'FARE_REVENUE' else 'DEFERRED_FARES' end, 'amount', v_refund.amount_pesewas),
      jsonb_build_object('account', 'REFUNDS_PAYABLE', 'amount', -v_refund.amount_pesewas)),
    v_refund.currency, v_refund.booking_id, v_refund.payment_id, p_refund_id);
  perform app.enqueue_message(v_refund.organisation_id, 'refund_started',
    jsonb_build_object('bookingId', v_refund.booking_id, 'refundId', p_refund_id), 'refund_started:' || p_refund_id::text);
end
$$;

-- ---------------------------------------------------------------------------
-- Cancelling seats, bookings and journeys (16.2, 15.2)
-- ---------------------------------------------------------------------------

-- Cancels one confirmed seat: ticket cancelled at once, seat back on sale, and
-- the policy's refund created. p_kind: passenger_cancellation or
-- operator_cancellation. Returns the refund id, or null when nothing is refunded.
create function app.cancel_seat(p_booked_seat_id uuid, p_kind text, p_reason text) returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_seat record;
  v_quote jsonb;
  v_amount bigint;
  v_payment uuid;
  v_refund uuid;
  v_threshold bigint;
  v_rows int;
begin
  if p_kind not in ('passenger_cancellation', 'operator_cancellation') then
    perform app.fail('Unknown cancellation.');
  end if;
  select s.*, b.organisation_id as org, b.currency into v_seat
    from app.booked_seats s join app.bookings b on b.id = s.booking_id where s.id = p_booked_seat_id for update of s;
  if not found then
    perform app.fail('That seat does not exist.');
  end if;
  v_quote := app.refund_quote(p_booked_seat_id, p_kind);
  if not (v_quote ->> 'allowed')::boolean then
    perform app.fail(v_quote ->> 'reason');
  end if;
  v_amount := (v_quote ->> 'amount')::bigint;

  update app.booked_seats set state = 'CANCELLED' where id = p_booked_seat_id and state = 'CONFIRMED';
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    perform app.fail('This seat was changed by someone else. Refresh and try again.');
  end if;
  -- The ticket fails validation at once (16.2 rule 5) and the seat returns to sale (rule 6).
  update app.tickets set state = 'CANCELLED' where booked_seat_id = p_booked_seat_id and state = 'VALID';
  update app.ticket_credentials c set revoked_at = now(), revoke_reason = 'Ticket cancelled'
    from app.tickets t where t.booked_seat_id = p_booked_seat_id and c.ticket_id = t.id and c.revoked_at is null;
  update app.seat_claims set state = 'RELEASED', released_at = now(), release_reason = 'cancelled'
    where booked_seat_id = p_booked_seat_id and state in ('HELD', 'CONFIRMED');
  -- The booking is cancelled only when every seat is (16.2 rule 4).
  update app.bookings b set state = 'CANCELLED'
    where b.id = v_seat.booking_id and b.state = 'CONFIRMED'
      and not exists (select 1 from app.booked_seats s where s.booking_id = b.id and s.state <> 'CANCELLED');

  if v_amount > 0 then
    v_payment := app.refundable_payment(v_seat.booking_id, v_amount);
    if v_payment is null then
      perform app.fail('There is not enough left on the payment to refund this seat. Ask Finance to check the booking.');
    end if;
    insert into app.refunds (organisation_id, payment_id, booking_id, booked_seat_id, kind, amount_pesewas, currency, reason, requested_by)
    values (v_seat.org, v_payment, v_seat.booking_id, p_booked_seat_id, p_kind, v_amount, v_seat.currency,
            coalesce(nullif(trim(p_reason), ''), 'Cancelled'), app.current_actor_id())
    returning id into v_refund;
    v_threshold := coalesce(app.setting_int(v_seat.org, 'refund.approval_threshold_pesewas'), 0);
    -- Operator cancellations always, and passenger cancellations inside the policy up to the
    -- threshold, are approved by the system (16.3).
    if p_kind = 'operator_cancellation' or v_threshold = 0 or v_amount <= v_threshold then
      perform app.approve_refund_internal(v_refund, null);
    end if;
  end if;
  return v_refund;
end
$$;

-- Cancels every confirmed seat of a booking for the passenger (16.2). Returns the number of seats cancelled.
create function app.cancel_booking(p_booking_id uuid, p_reason text) returns int
language plpgsql
set search_path = ''
as $$
declare
  v_seat uuid;
  v_count int := 0;
  v_org uuid;
begin
  select organisation_id into v_org from app.bookings where id = p_booking_id for update;
  if v_org is null then
    perform app.fail('That booking does not exist.');
  end if;
  for v_seat in select id from app.booked_seats where booking_id = p_booking_id and state = 'CONFIRMED' order by id loop
    perform app.cancel_seat(v_seat, 'passenger_cancellation', p_reason);
    v_count := v_count + 1;
  end loop;
  if v_count = 0 then
    perform app.fail('This booking has no seats that can be cancelled.');
  end if;
  perform app.enqueue_message(v_org, 'booking_cancelled', jsonb_build_object('bookingId', p_booking_id),
    'booking_cancelled:' || p_booking_id::text || ':' || v_count::text || ':' || extract(epoch from now())::bigint::text);
  return v_count;
end
$$;

-- What cancelling a journey would do (15.2 step 1): passengers, bookings and refund total.
create function app.journey_cancellation_preview(p_journey_id uuid) returns jsonb
language sql stable
set search_path = ''
as $$
  select jsonb_build_object(
    'passengers', count(*) filter (where s.state = 'CONFIRMED'),
    'bookings', count(distinct s.booking_id) filter (where s.state = 'CONFIRMED'),
    'refundTotalPesewas', coalesce(sum((app.refund_quote(s.id, 'operator_cancellation') ->> 'amount')::bigint) filter (where s.state = 'CONFIRMED'), 0),
    'unpaidHolds', (select count(*) from app.bookings b where b.journey_id = p_journey_id and b.state in ('PENDING', 'PAYMENT_PENDING')))
  from app.booked_seats s where s.journey_id = p_journey_id
$$;

-- Cancels a journey with passengers (15.2): every seat and ticket cancelled,
-- every payment refunded in full with the system as approver, unpaid holds
-- ended, passengers told. Returns the number of passengers refunded.
create function app.cancel_journey(p_journey_id uuid, p_reason text) returns int
language plpgsql
set search_path = ''
as $$
declare
  v_journey record;
  v_seat uuid;
  v_booking uuid;
  v_count int := 0;
begin
  select * into v_journey from app.journeys where id = p_journey_id for update;
  if not found then
    perform app.fail('That journey does not exist.');
  end if;
  if v_journey.state in ('DEPARTED', 'COMPLETED', 'CANCELLED') then
    perform app.fail(case v_journey.state when 'CANCELLED' then 'This journey is already cancelled.' else 'This journey has already left.' end);
  end if;
  if length(trim(coalesce(p_reason, ''))) < 5 then
    perform app.fail('Give the reason passengers will be told (at least 5 characters).');
  end if;
  if exists (select 1 from app.boarding_records where journey_id = p_journey_id) then
    perform app.fail('Passengers have already boarded this bus, so it cannot be cancelled here. Record the departure or contact support.');
  end if;

  for v_booking in select id from app.bookings where journey_id = p_journey_id and state = 'CONFIRMED' order by id loop
    for v_seat in select id from app.booked_seats where booking_id = v_booking and state = 'CONFIRMED' order by id loop
      perform app.cancel_seat(v_seat, 'operator_cancellation', p_reason);
      v_count := v_count + 1;
    end loop;
    perform app.enqueue_message(v_journey.organisation_id, 'journey_cancelled',
      jsonb_build_object('bookingId', v_booking, 'reason', p_reason), 'journey_cancelled:' || v_booking::text);
  end loop;

  -- Unpaid holds end now. A payment that still arrives is refunded by the late-payment procedure.
  update app.bookings set expires_at = now() where journey_id = p_journey_id and state in ('PENDING', 'PAYMENT_PENDING');
  perform app.expire_booking(id) from app.bookings where journey_id = p_journey_id and state in ('PENDING', 'PAYMENT_PENDING');

  perform set_config('app.journey_cancellation', p_journey_id::text, true);
  perform app.move_journey(p_journey_id, 'CANCELLED', p_reason);
  perform set_config('app.journey_cancellation', '', true);
  return v_count;
end
$$;

-- ---------------------------------------------------------------------------
-- Refunds requested and approved by people (16.3)
-- ---------------------------------------------------------------------------

-- A refund outside the policy or a goodwill payment: requested by one person,
-- approved by another (refund.approve). Returns the refund id.
create function app.request_refund(p_booking_id uuid, p_amount bigint, p_reason text, p_kind text default 'goodwill') returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_booking record;
  v_payment uuid;
  v_refund uuid;
begin
  if p_kind not in ('goodwill', 'correction') then
    perform app.fail('Unknown refund kind.');
  end if;
  if p_amount is null or p_amount <= 0 then
    perform app.fail('Enter an amount to refund.');
  end if;
  select * into v_booking from app.bookings where id = p_booking_id;
  if not found then
    perform app.fail('That booking does not exist.');
  end if;
  v_payment := app.refundable_payment(p_booking_id, p_amount);
  if v_payment is null then
    perform app.fail('That is more than is left to refund on this booking''s payment.');
  end if;
  insert into app.refunds (organisation_id, payment_id, booking_id, kind, amount_pesewas, currency, reason, requested_by)
  values (v_booking.organisation_id, v_payment, p_booking_id, p_kind, p_amount, v_booking.currency, p_reason, app.current_actor_id())
  returning id into v_refund;
  return v_refund;
end
$$;

create function app.approve_refund(p_refund_id uuid) returns void
language plpgsql
set search_path = ''
as $$
declare
  v_requested_by uuid;
begin
  select requested_by into v_requested_by from app.refunds where id = p_refund_id;
  if v_requested_by is not distinct from app.current_actor_id() then
    perform app.fail('A refund must be approved by someone other than the person who asked for it.');
  end if;
  perform app.approve_refund_internal(p_refund_id, app.current_actor_id());
end
$$;

create function app.reject_refund(p_refund_id uuid) returns void
language plpgsql
set search_path = ''
as $$
declare
  v_rows int;
begin
  update app.refunds set approved_by = app.current_actor_id(), state = 'REJECTED', processed_at = now()
    where id = p_refund_id and state = 'REQUESTED';
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    perform app.fail('This refund is no longer waiting for approval.');
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Refund processing (16.4, 16.4a)
-- ---------------------------------------------------------------------------

-- Records what the provider said about an attempt. p_outcome:
--   processed: money returned; pending: accepted, waiting for its event;
--   retry: the provider could not be reached; refused: the route cannot refund this payment.
create function app.record_refund_attempt(p_refund_id uuid, p_route text, p_outcome text, p_provider_reference text, p_error text)
returns text
language plpgsql
set search_path = ''
as $$
declare
  v_refund record;
  v_max int;
begin
  select * into v_refund from app.refunds where id = p_refund_id for update;
  if v_refund.state not in ('APPROVED', 'PROCESSING') then
    return 'ignored';
  end if;
  v_max := coalesce(app.setting_int(v_refund.organisation_id, 'refund.max_attempts'), 5);

  if p_outcome = 'processed' then
    perform app.complete_refund(p_refund_id, p_route, p_provider_reference);
    return 'completed';
  elsif p_outcome = 'pending' then
    update app.refunds set state = 'PROCESSING', route = p_route, attempts = attempts + 1,
           provider_reference = coalesce(p_provider_reference, provider_reference), last_error = null
      where id = p_refund_id;
    return 'processing';
  elsif p_outcome = 'retry' and v_refund.attempts + 1 < v_max then
    update app.refunds set attempts = attempts + 1, last_error = left(p_error, 500),
           next_attempt_at = now() + make_interval(mins => 5 * power(2, attempts)::int)
      where id = p_refund_id;
    return 'retry';
  end if;

  -- Refused by the route, or out of retries: hand it to Finance to pay another way (16.4a).
  update app.refunds
    set state = 'FAILED', attempts = attempts + 1, last_error = left(coalesce(p_error, 'The provider could not refund this payment'), 500),
        processed_at = now(),
        route_attempts = route_attempts || jsonb_build_array(jsonb_build_object('route', p_route, 'at', now(), 'error', p_error))
    where id = p_refund_id;
  perform app.raise_exception(v_refund.organisation_id, 'failed_refund', 'high', 'failed_refund:' || p_refund_id::text,
    format('A refund of %s could not be sent through Paystack: %s', app.format_cedis(v_refund.amount_pesewas), coalesce(p_error, 'refused')),
    'Retry, or pay the passenger another way and record it.', v_refund.booking_id, null, v_refund.payment_id, p_refund_id);
  return 'failed';
end
$$;

-- "GH₵ 12.50" for messages written by the database.
create function app.format_cedis(p_pesewas bigint) returns text
language sql immutable
set search_path = ''
as $$ select 'GH₵ ' || (p_pesewas / 100)::text || '.' || lpad((p_pesewas % 100)::text, 2, '0') $$;

-- The money has gone back: COMPLETED, refunds payable cleared, passenger told.
create function app.complete_refund(p_refund_id uuid, p_route text, p_provider_reference text) returns void
language plpgsql
set search_path = ''
as $$
declare
  v_refund record;
  v_rows int;
begin
  select * into v_refund from app.refunds where id = p_refund_id for update;
  update app.refunds set state = 'COMPLETED', route = coalesce(p_route, route),
         provider_reference = coalesce(p_provider_reference, provider_reference), processed_at = now(), last_error = null,
         attempts = attempts + case when state = 'APPROVED' then 1 else 0 end
    where id = p_refund_id and state in ('APPROVED', 'PROCESSING');
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    return;
  end if;
  perform app.post_ledger(v_refund.organisation_id, 'Refund paid',
    jsonb_build_array(
      jsonb_build_object('account', 'REFUNDS_PAYABLE', 'amount', v_refund.amount_pesewas),
      jsonb_build_object('account', case when coalesce(p_route, v_refund.route) = 'manual' then 'BANK' else 'PROVIDER_CLEARING' end,
                         'amount', -v_refund.amount_pesewas)),
    v_refund.currency, v_refund.booking_id, v_refund.payment_id, p_refund_id);
  perform app.enqueue_message(v_refund.organisation_id, 'refund_completed',
    jsonb_build_object('bookingId', v_refund.booking_id, 'refundId', p_refund_id), 'refund_completed:' || p_refund_id::text);
  perform app.resolve_exception_automatically('failed_refund:' || p_refund_id::text, 'Closed automatically: the refund was paid.');
end
$$;

-- Finance sends a failed refund back for another provider attempt.
create function app.retry_refund(p_refund_id uuid) returns void
language plpgsql
set search_path = ''
as $$
declare
  v_rows int;
begin
  update app.refunds set state = 'APPROVED', attempts = 0, next_attempt_at = now(), processed_at = null
    where id = p_refund_id and state = 'FAILED';
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    perform app.fail('Only a failed refund can be tried again.');
  end if;
end
$$;

-- Finance paid outside Paystack and records it; a different person confirms (16.4a manual route).
create function app.record_manual_refund(p_refund_id uuid, p_reference text) returns void
language plpgsql
set search_path = ''
as $$
declare
  v_rows int;
begin
  if length(trim(coalesce(p_reference, ''))) < 3 then
    perform app.fail('Enter the payment reference from the bank or mobile money statement.');
  end if;
  update app.refunds
    set state = 'PROCESSING', route = 'manual', provider_reference = trim(p_reference), manual_recorded_by = app.current_actor_id(),
        processed_at = null,
        route_attempts = route_attempts || jsonb_build_array(jsonb_build_object('route', 'manual', 'at', now(), 'recordedBy', app.current_actor_id()))
    where id = p_refund_id and state in ('FAILED', 'APPROVED');
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    perform app.fail('This refund cannot be recorded as paid by hand now.');
  end if;
end
$$;

create function app.confirm_manual_refund(p_refund_id uuid) returns void
language plpgsql
set search_path = ''
as $$
declare
  v_refund record;
begin
  select * into v_refund from app.refunds where id = p_refund_id for update;
  if v_refund.route is distinct from 'manual' or v_refund.state <> 'PROCESSING' then
    perform app.fail('This refund is not waiting for a manual payment to be confirmed.');
  end if;
  if v_refund.manual_recorded_by is not distinct from app.current_actor_id() then
    perform app.fail('Someone other than the person who recorded the payment must confirm it.');
  end if;
  update app.refunds set confirmed_by = app.current_actor_id() where id = p_refund_id;
  perform app.complete_refund(p_refund_id, 'manual', null);
end
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

grant execute on function
  app.bookings_refund_policy(), app.seat_claims_journey_running(), app.journeys_cancel_guard(),
  app.refund_quote(uuid, text), app.refundable_payment(uuid, bigint), app.approve_refund_internal(uuid, uuid),
  app.cancel_seat(uuid, text, text), app.cancel_booking(uuid, text), app.journey_cancellation_preview(uuid),
  app.cancel_journey(uuid, text), app.request_refund(uuid, bigint, text, text), app.approve_refund(uuid),
  app.reject_refund(uuid), app.record_refund_attempt(uuid, text, text, text, text), app.format_cedis(bigint),
  app.complete_refund(uuid, text, text), app.retry_refund(uuid), app.record_manual_refund(uuid, text),
  app.confirm_manual_refund(uuid)
to app_runtime;

revoke all on function
  app.bookings_refund_policy(), app.seat_claims_journey_running(), app.journeys_cancel_guard(),
  app.refund_quote(uuid, text), app.refundable_payment(uuid, bigint), app.approve_refund_internal(uuid, uuid),
  app.cancel_seat(uuid, text, text), app.cancel_booking(uuid, text), app.journey_cancellation_preview(uuid),
  app.cancel_journey(uuid, text), app.request_refund(uuid, bigint, text, text), app.approve_refund(uuid),
  app.reject_refund(uuid), app.record_refund_attempt(uuid, text, text, text, text), app.format_cedis(bigint),
  app.complete_refund(uuid, text, text), app.retry_refund(uuid), app.record_manual_refund(uuid, text),
  app.confirm_manual_refund(uuid)
from anon, authenticated;

-- ====================================================================
-- 20261008150000_vehicle_change.sql
-- ====================================================================
-- Phase E, slice 5: replacing a bus after seats are sold (spec 15.1, 15.5, 24.2 "Seat remap determinism").
-- The old seat snapshot is retired, never deleted: bookings, claims and tickets
-- keep pointing at the seats they had, and every move is recorded.

-- ---------------------------------------------------------------------------
-- Retired journey seats
-- ---------------------------------------------------------------------------

alter table app.journey_seats
  -- Set when the journey changed bus; a retired seat is BLOCKED and never sold again.
  add column retired_at timestamptz,
  add constraint journey_seats_retired_blocked check (retired_at is null or state = 'BLOCKED');

-- Seat numbers and positions are unique among the seats in use, not among retired ones.
alter table app.journey_seats drop constraint journey_seats_journey_id_seat_number_key;
alter table app.journey_seats drop constraint journey_seats_journey_id_row_number_column_number_key;
create unique index journey_seats_live_number on app.journey_seats (journey_id, seat_number) where retired_at is null;
create unique index journey_seats_live_position on app.journey_seats (journey_id, row_number, column_number) where retired_at is null;

-- Seats are copied while the journey is a draft, or by the vehicle change
-- procedure. After that only a seat's BOOKABLE/BLOCKED state may change, and
-- a retired seat never changes again.
create or replace function app.journey_seats_guard() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_state text;
  v_remap boolean;
begin
  select state into v_state from app.journeys where id = coalesce(new.journey_id, old.journey_id);
  v_remap := app.request_setting('remap') is not distinct from coalesce(new.journey_id, old.journey_id)::text;
  if tg_op in ('INSERT', 'DELETE') then
    if v_state <> 'DRAFT' and not (tg_op = 'INSERT' and v_remap) then
      perform app.fail('The seat map of a journey on sale cannot be replaced. Change its bus with the vehicle change procedure.');
    end if;
    return coalesce(new, old);
  end if;
  if (new.journey_id, new.source_seat_id, new.seat_number, new.seat_type, new.row_number, new.column_number, new.position)
     is distinct from
     (old.journey_id, old.source_seat_id, old.seat_number, old.seat_type, old.row_number, old.column_number, old.position) then
    perform app.fail('A journey''s seats are a snapshot. Only blocking or unblocking a seat is allowed.');
  end if;
  if old.retired_at is not null then
    perform app.fail('This seat belonged to the journey''s previous bus and cannot be changed.');
  end if;
  if new.retired_at is not null and not v_remap then
    perform app.fail('Seats are retired only by the vehicle change procedure.');
  end if;
  if v_state in ('DEPARTED', 'COMPLETED', 'CANCELLED') then
    perform app.fail('Seats cannot be blocked or unblocked after the journey has left.');
  end if;
  return new;
end
$$;

-- ---------------------------------------------------------------------------
-- The record of every move (15.1 rule 3: nothing in history is rewritten)
-- ---------------------------------------------------------------------------

create table app.seat_remaps (
  id uuid primary key default app.uuid_v7(),
  organisation_id uuid not null,
  journey_id uuid not null,
  -- The new assignment this move belongs to.
  vehicle_assignment_id uuid not null,
  booked_seat_id uuid not null,
  from_journey_seat_id uuid not null,
  -- Null: the passenger was refunded instead of moved.
  to_journey_seat_id uuid,
  -- 1 to 5: the matching rule that placed them (15.1). Null: placed or refunded by the manager.
  rule int check (rule between 1 and 5),
  outcome text not null check (outcome in ('moved', 'moved_by_manager', 'refunded')),
  created_at timestamptz not null default now(),
  unique (organisation_id, id),
  foreign key (organisation_id, journey_id) references app.journeys (organisation_id, id),
  foreign key (organisation_id, vehicle_assignment_id) references app.vehicle_assignments (organisation_id, id),
  foreign key (organisation_id, journey_id, booked_seat_id) references app.booked_seats (organisation_id, journey_id, id),
  foreign key (organisation_id, journey_id, from_journey_seat_id) references app.journey_seats (organisation_id, journey_id, id),
  foreign key (organisation_id, journey_id, to_journey_seat_id) references app.journey_seats (organisation_id, journey_id, id),
  check ((outcome = 'refunded') = (to_journey_seat_id is null)),
  check ((outcome = 'moved') = (rule is not null))
);

create index seat_remaps_by_journey on app.seat_remaps (journey_id, created_at);

create trigger seat_remaps_immutable before update or delete on app.seat_remaps
  for each row execute function app.refuse_change();
create trigger seat_remaps_audit after insert on app.seat_remaps
  for each row execute function app.audit_row_change();

alter table app.seat_remaps enable row level security;
create policy org_boundary on app.seat_remaps to app_runtime
  using (organisation_id = app.current_organisation_id()) with check (organisation_id = app.current_organisation_id());
grant select, insert on app.seat_remaps to app_runtime;

-- ---------------------------------------------------------------------------
-- The matching rule (15.1), deterministic: the same input always gives the same result
-- ---------------------------------------------------------------------------

-- Every passenger holding a seat on the journey (paid, or held and not expired),
-- in booking order, with the seat on the new bus the rules give them.
-- new_seat_id is a layout seat of the new bus; null with rule null means manual review.
-- p_settled: passengers the manager has already placed or refunded (the rules skip them);
-- p_reserved: seat numbers the manager has chosen (the rules do not give them out).
create function app.vehicle_change_plan(p_journey_id uuid, p_vehicle_id uuid, p_settled uuid[] default '{}', p_reserved text[] default '{}')
returns table (
  booked_seat_id uuid,
  booking_reference text,
  passenger_name text,
  old_seat_number text,
  old_seat_type text,
  old_position text,
  new_seat_id uuid,
  new_seat_number text,
  new_seat_type text,
  rule int
)
language plpgsql stable
set search_path = ''
as $$
declare
  v_layout uuid;
  v_taken uuid[] := '{}';
  v_passenger record;
  v_pick record;
begin
  select id into v_layout from app.seat_layouts where vehicle_id = p_vehicle_id and status = 'published';
  if v_layout is null then
    perform app.fail('That bus has no published seat layout.');
  end if;

  -- Earlier bookers first (15.1 "Exact matching priority"), then a stable order within a booking.
  for v_passenger in
    select s.id as booked_seat_id, b.reference, p.full_name, js.seat_number, js.seat_type, js.position,
           js.row_number, js.column_number
    from app.seat_claims c
    join app.booked_seats s on s.id = c.booked_seat_id
    join app.bookings b on b.id = s.booking_id
    join app.booking_passengers p on p.id = s.passenger_id
    join app.journey_seats js on js.id = c.journey_seat_id
    where c.journey_id = p_journey_id
      and (c.state = 'CONFIRMED' or (c.state = 'HELD' and c.expires_at > now()))
    order by b.first_held_at, b.id, js.row_number, js.column_number
  loop
    booked_seat_id := v_passenger.booked_seat_id;
    booking_reference := v_passenger.reference;
    passenger_name := v_passenger.full_name;
    old_seat_number := v_passenger.seat_number;
    old_seat_type := v_passenger.seat_type;
    old_position := v_passenger.position;
    new_seat_id := null; new_seat_number := null; new_seat_type := null; rule := null;
    if v_passenger.booked_seat_id = any(p_settled) then
      return next;
      continue;
    end if;

    select x.id, x.seat_number, x.seat_type, x.rule into v_pick
    from (
      select ns.id, ns.seat_number, ns.seat_type,
             case
               when ns.seat_number = v_passenger.seat_number then 1
               when ns.row_number = v_passenger.row_number then 2
               when abs(ns.row_number - v_passenger.row_number) = 1 then 3
               when ns.position is not distinct from v_passenger.position then 4
               else 5
             end as rule,
             abs(ns.row_number - v_passenger.row_number) as row_distance,
             abs(ns.column_number - v_passenger.column_number) as column_distance
      from app.seats ns
      -- Same seat type only: an accessible seat only ever goes to an accessible seat, and nobody pays more.
      where ns.layout_id = v_layout and ns.bookable and ns.seat_type = v_passenger.seat_type
        and ns.id <> all(v_taken) and ns.seat_number <> all(p_reserved)
    ) x
    order by x.rule, x.row_distance, x.column_distance, length(x.seat_number), x.seat_number
    limit 1;

    if v_pick.id is not null then
      new_seat_id := v_pick.id; new_seat_number := v_pick.seat_number; new_seat_type := v_pick.seat_type; rule := v_pick.rule;
      v_taken := v_taken || v_pick.id;
    end if;
    return next;
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- Applying the change (15.1 rules 1 to 5)
-- ---------------------------------------------------------------------------

-- Changes the bus of a journey that is on sale. p_choices settles every
-- passenger the rules could not place: [{"bookedSeatId": ..., "seatNumber": "12C"}]
-- moves them to that free seat of the new bus (any type, never charged more;
-- a cheaper seat type refunds the difference), and [{"bookedSeatId": ..., "refund": true}]
-- refunds them in full. Returns the new assignment id.
create function app.change_vehicle(p_journey_id uuid, p_vehicle_id uuid, p_reason text, p_choices jsonb default '[]')
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_journey record;
  v_vehicle record;
  v_layout uuid;
  v_buffer int;
  v_assignment uuid;
  v_plan record;
  v_choice jsonb;
  v_target uuid;
  v_target_type text;
  v_seat record;
  v_old_claim record;
  v_new_journey_seat uuid;
  v_live int;
  v_refunding int;
  v_capacity int;
  v_last_seq int;
  v_fare_old bigint;
  v_fare_new bigint;
  v_payment uuid;
  v_used text[] := '{}';
  v_bookings uuid[] := '{}';
  v_booking uuid;
begin
  select * into v_journey from app.journeys where id = p_journey_id for update;
  if not found then
    perform app.fail('That journey does not exist.');
  end if;
  if v_journey.state = 'DRAFT' then
    perform app.fail('This journey is not on sale yet, so just assign the bus.');
  end if;
  if v_journey.state not in ('SCHEDULED', 'SALES_CLOSED', 'BOARDING') then
    perform app.fail('The bus can only be changed before the journey leaves.');
  end if;
  if exists (select 1 from app.boarding_records where journey_id = p_journey_id) then
    perform app.fail('Passengers have already boarded. Use the breakdown procedure instead.');
  end if;
  if length(trim(coalesce(p_reason, ''))) < 5 then
    perform app.fail('Say why the bus is changing (at least 5 characters).');
  end if;
  select * into v_vehicle from app.vehicles where id = p_vehicle_id;
  if not found then
    perform app.fail('That bus does not exist.');
  end if;
  if v_vehicle.status <> 'active' then
    perform app.fail(format('Bus %s is not in service.', v_vehicle.registration));
  end if;
  if exists (select 1 from app.vehicle_assignments where journey_id = p_journey_id and state = 'ACTIVE' and vehicle_id = p_vehicle_id) then
    perform app.fail('That bus is already on this journey.');
  end if;
  select id into v_layout from app.seat_layouts where vehicle_id = p_vehicle_id and status = 'published';
  if v_layout is null then
    perform app.fail(format('Bus %s has no published seat layout yet.', v_vehicle.registration));
  end if;

  -- Seats are taken in id order everywhere (11.3a), so concurrent holds wait for this.
  perform 1 from (select id from app.journey_seats where journey_id = p_journey_id order by id for update) locked;
  perform app.release_expired_claims(array(select id from app.journey_seats where journey_id = p_journey_id));

  -- Capacity (15.5): everyone who is not being refunded needs a seat on the new bus.
  select count(*) into v_live from app.seat_claims where journey_id = p_journey_id and state in ('HELD', 'CONFIRMED');
  select count(*) into v_refunding from jsonb_array_elements(p_choices) c where (c ->> 'refund')::boolean;
  select count(*) into v_capacity from app.seats where layout_id = v_layout and bookable;
  if v_capacity < v_live - v_refunding then
    perform app.fail(format('Bus %s has %s seats but %s are sold or held. Refund or move %s passengers first.',
      v_vehicle.registration, v_capacity, v_live, v_live - v_refunding - v_capacity));
  end if;

  -- The new assignment; the old one is kept as REPLACED (rule 3).
  update app.vehicle_assignments set state = 'REPLACED' where journey_id = p_journey_id and state = 'ACTIVE';
  v_buffer := coalesce(app.setting_int(v_journey.organisation_id, 'fleet.turnaround_minutes'), 60);
  begin
    insert into app.vehicle_assignments (organisation_id, journey_id, vehicle_id, occupied_during, reason, assigned_by)
    values (v_journey.organisation_id, p_journey_id, p_vehicle_id,
            tstzrange(v_journey.scheduled_departure_at, v_journey.scheduled_arrival_at + make_interval(mins => v_buffer)),
            p_reason, app.current_actor_id())
    returning id into v_assignment;
  exception when exclusion_violation then
    perform app.fail(format('Bus %s is already on another journey at that time, including the %s-minute turnaround.',
      v_vehicle.registration, v_buffer));
  end;

  -- Rebuild the seat snapshot (rule 1): old seats retired, new seats copied.
  perform set_config('app.remap', p_journey_id::text, true);
  update app.journey_seats set state = 'BLOCKED', retired_at = now() where journey_id = p_journey_id and retired_at is null;
  insert into app.journey_seats (organisation_id, journey_id, source_seat_id, seat_number, seat_type, row_number, column_number, position, state)
  select s.organisation_id, p_journey_id, s.id, s.seat_number, s.seat_type, s.row_number, s.column_number, s.position,
         case when s.bookable then 'BOOKABLE' else 'BLOCKED' end
  from app.seats s where s.layout_id = v_layout;
  select max(sequence) into v_last_seq from app.route_stops where route_id = v_journey.route_id;

  -- Seats chosen by the manager are not free for the rules.
  select coalesce(array_agg(upper(c ->> 'seatNumber')), '{}') into v_used
    from jsonb_array_elements(p_choices) c where c ? 'seatNumber';

  for v_plan in select * from app.vehicle_change_plan(p_journey_id, p_vehicle_id,
      array(select (c ->> 'bookedSeatId')::uuid from jsonb_array_elements(p_choices) c), v_used) loop
    select * into v_seat from app.booked_seats where id = v_plan.booked_seat_id;
    select * into v_old_claim from app.seat_claims where booked_seat_id = v_plan.booked_seat_id and state in ('HELD', 'CONFIRMED');
    select c into v_choice from jsonb_array_elements(p_choices) c where c ->> 'bookedSeatId' = v_plan.booked_seat_id::text;

    if v_choice is not null and (v_choice ->> 'refund')::boolean then
      if v_seat.state <> 'CONFIRMED' then
        perform app.fail('Only a paid seat can be refunded here. An unpaid hold can just be left to end.');
      end if;
      insert into app.seat_remaps (organisation_id, journey_id, vehicle_assignment_id, booked_seat_id, from_journey_seat_id, outcome)
      values (v_journey.organisation_id, p_journey_id, v_assignment, v_seat.id, v_seat.journey_seat_id, 'refunded');
      perform app.cancel_seat(v_seat.id, 'operator_cancellation', 'The bus was changed and no suitable seat was free: ' || p_reason);
      continue;
    end if;

    if v_choice is not null and v_choice ? 'seatNumber' then
      select id, seat_type into v_target, v_target_type from app.journey_seats
        where journey_id = p_journey_id and retired_at is null and seat_number = upper(v_choice ->> 'seatNumber') and state = 'BOOKABLE';
      if v_target is null then
        perform app.fail(format('Seat %s is not a seat for sale on bus %s.', v_choice ->> 'seatNumber', v_vehicle.registration));
      end if;
      if v_plan.old_seat_type = 'accessible' and v_target_type <> 'accessible' then
        perform app.fail(format('%s needs an accessible seat. Choose an accessible seat or a refund.', v_plan.passenger_name));
      end if;
    elsif v_plan.new_seat_id is not null then
      select id, seat_type into v_target, v_target_type from app.journey_seats
        where journey_id = p_journey_id and retired_at is null and source_seat_id = v_plan.new_seat_id;
    else
      perform app.fail(format('Choose a seat or a refund for %s (seat %s).', v_plan.passenger_name, v_plan.old_seat_number));
    end if;

    -- Move the claim (rule 1): the old one is released, the new one takes its place in the same state.
    update app.seat_claims set state = 'RELEASED', expires_at = null, released_at = now(), release_reason = 'remapped'
      where id = v_old_claim.id;
    update app.booked_seats set journey_seat_id = v_target where id = v_seat.id;
    insert into app.seat_claims (organisation_id, journey_id, journey_seat_id, booked_seat_id, occupied_from_seq, occupied_to_seq, state, expires_at)
    values (v_journey.organisation_id, p_journey_id, v_target, v_seat.id, v_old_claim.occupied_from_seq, v_old_claim.occupied_to_seq,
            v_old_claim.state, v_old_claim.expires_at);
    insert into app.seat_remaps (organisation_id, journey_id, vehicle_assignment_id, booked_seat_id, from_journey_seat_id, to_journey_seat_id, rule, outcome)
    values (v_journey.organisation_id, p_journey_id, v_assignment, v_seat.id, v_old_claim.journey_seat_id, v_target,
            case when v_choice is null then v_plan.rule end, case when v_choice is null then 'moved' else 'moved_by_manager' end);

    -- A cheaper seat type than was paid for refunds the difference (15.1 matching rule); a dearer one costs nothing.
    if v_target_type <> v_seat.seat_type and v_seat.state = 'CONFIRMED' then
      select amount_pesewas into v_fare_old from app.journey_fares
        where journey_id = p_journey_id and origin_stop_id = v_seat.origin_stop_id and destination_stop_id = v_seat.destination_stop_id and seat_type = v_seat.seat_type;
      select amount_pesewas into v_fare_new from app.journey_fares
        where journey_id = p_journey_id and origin_stop_id = v_seat.origin_stop_id and destination_stop_id = v_seat.destination_stop_id and seat_type = v_target_type;
      if v_fare_new is not null and v_fare_old is not null and v_fare_new < v_fare_old then
        v_payment := app.refundable_payment(v_seat.booking_id, v_fare_old - v_fare_new);
        if v_payment is not null then
          perform app.create_system_refund(v_payment, 'correction', v_fare_old - v_fare_new,
            'Moved to a cheaper seat type when the bus was changed', v_seat.id);
        end if;
      end if;
    end if;

    if v_seat.state = 'CONFIRMED' and not v_seat.booking_id = any(v_bookings) then
      v_bookings := v_bookings || v_seat.booking_id;
    end if;
  end loop;
  perform set_config('app.remap', '', true);

  -- Every passenger has a seat on the new bus or a refund (15.5).
  if exists (select 1 from app.seat_claims c join app.journey_seats js on js.id = c.journey_seat_id
             where c.journey_id = p_journey_id and c.state in ('HELD', 'CONFIRMED') and js.retired_at is not null) then
    perform app.fail('Some passengers were not given a seat on the new bus. Nothing has been changed.');
  end if;

  -- Passengers are told their seat (rule 4), one message per booking.
  foreach v_booking in array v_bookings loop
    perform app.enqueue_message(v_journey.organisation_id, 'seat_changed',
      jsonb_build_object('bookingId', v_booking, 'assignmentId', v_assignment), 'seat_changed:' || v_booking::text || ':' || v_assignment::text);
  end loop;
  perform app.record_journey_event(p_journey_id, 'vehicle_assigned', format('Bus changed to %s: %s', v_vehicle.registration, p_reason));
  return v_assignment;
end
$$;

grant execute on function app.vehicle_change_plan(uuid, uuid, uuid[], text[]), app.change_vehicle(uuid, uuid, text, jsonb) to app_runtime;
revoke all on function app.vehicle_change_plan(uuid, uuid, uuid[], text[]), app.change_vehicle(uuid, uuid, text, jsonb) from anon, authenticated;
revoke all on app.seat_remaps from anon, authenticated;

insert into supabase_migrations.schema_migrations (version, name) values
  ('20261008075400', 'scheduling_7_assign_vehicle'),
  ('20261008100000', 'booking_1_tables'),
  ('20261008100100', 'booking_2_procedures'),
  ('20261008100200', 'booking_3_security'),
  ('20261008120000', 'boarding'),
  ('20261008130000', 'operations_dashboard'),
  ('20261008140000', 'cancellations_refunds'),
  ('20261008150000', 'vehicle_change')
on conflict (version) do nothing;

commit;
