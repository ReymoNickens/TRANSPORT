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
