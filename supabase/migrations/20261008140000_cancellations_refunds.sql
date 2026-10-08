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
