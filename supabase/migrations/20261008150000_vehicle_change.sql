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
