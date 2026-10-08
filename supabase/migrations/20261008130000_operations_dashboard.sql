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
