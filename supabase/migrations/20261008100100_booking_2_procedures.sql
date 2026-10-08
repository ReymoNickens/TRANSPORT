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
