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
