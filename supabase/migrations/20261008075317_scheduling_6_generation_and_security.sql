-- Phase C: scheduling, part 6 of 7: generating journeys (D23), rules that now
-- have journeys to check, and row-level security, grants and audit for the
-- Phase C tables. app.assign_vehicle and its grant are in part 7.

-- ---------------------------------------------------------------------------
-- Generating journeys from schedules (D23)
-- ---------------------------------------------------------------------------

-- Generates journeys for the next horizon days (setting journeys.generation_horizon_days).
-- Safe to run repeatedly: a schedule gets at most one journey per day. A new
-- journey gets the schedule's default bus and goes on sale when it can; any
-- business-rule problem leaves it as a DRAFT for a manager ("needs a bus").
create function app.generate_journeys(p_organisation_id uuid, p_from date default null, p_days int default null)
returns table (created int, put_on_sale int)
language plpgsql
set search_path = ''
as $$
declare
  v_timezone text;
  v_from date;
  v_days int;
  v_open_days int;
  v_schedule record;
  v_duration int;
  v_date date;
  v_exception record;
  v_time time;
  v_departure timestamptz;
  v_journey_id uuid;
  v_created int := 0;
  v_on_sale int := 0;
begin
  select timezone into v_timezone from app.organisations where id = p_organisation_id and status = 'active';
  if v_timezone is null then
    return query select 0, 0;
    return;
  end if;
  v_from := coalesce(p_from, (now() at time zone v_timezone)::date);
  v_days := coalesce(p_days, app.setting_int(p_organisation_id, 'journeys.generation_horizon_days'), 30);
  v_open_days := coalesce(app.setting_int(p_organisation_id, 'booking.open_days_before'), 30);

  for v_schedule in
    select s.id, s.route_id, s.booking_open_days_before, v.version, v.departure_time, v.days_of_week, v.default_vehicle_id
    from app.schedules s
    join app.schedule_versions v on v.schedule_id = s.id and v.version = s.current_version
    join app.routes r on r.id = s.route_id and r.status = 'active'
    where s.organisation_id = p_organisation_id and s.status = 'active'
  loop
    select max(arrival_offset_minutes) into v_duration from app.route_stops where route_id = v_schedule.route_id;

    for v_date in select v_from + i from generate_series(0, v_days - 1) as i loop
      select kind, departure_time into v_exception
        from app.schedule_exceptions where schedule_id = v_schedule.id and service_date = v_date;
      v_time := case
        when v_exception.kind = 'skip' then null
        when v_exception.kind in ('move', 'extra') then v_exception.departure_time
        when extract(isodow from v_date)::smallint = any(v_schedule.days_of_week) then v_schedule.departure_time
        else null
      end;
      continue when v_time is null;

      v_departure := (v_date + v_time) at time zone v_timezone;
      continue when v_departure <= now();

      v_journey_id := null;
      insert into app.journeys (organisation_id, route_id, schedule_id, schedule_version, service_date,
                                scheduled_departure_at, scheduled_arrival_at, booking_opens_at)
      values (p_organisation_id, v_schedule.route_id, v_schedule.id, v_schedule.version, v_date,
              v_departure, v_departure + make_interval(mins => v_duration),
              v_departure - make_interval(days => coalesce(v_schedule.booking_open_days_before, v_open_days)))
      on conflict (schedule_id, service_date) where schedule_id is not null do nothing
      returning id into v_journey_id;
      continue when v_journey_id is null;
      v_created := v_created + 1;

      if v_schedule.default_vehicle_id is not null then
        begin
          perform app.assign_vehicle(v_journey_id, v_schedule.default_vehicle_id, 'The schedule''s default bus');
          perform app.publish_journey(v_journey_id);
          v_on_sale := v_on_sale + 1;
        exception when sqlstate 'BR001' then
          -- Stays a DRAFT; the dashboard shows what it still needs.
          null;
        end;
      end if;
    end loop;
  end loop;

  return query select v_created, v_on_sale;
end
$$;

-- The nightly job: every active organisation (run by the database owner).
create function app.generate_journeys_all() returns void
language plpgsql
set search_path = ''
as $$
declare
  v_organisation_id uuid;
begin
  for v_organisation_id in select id from app.organisations where status = 'active' loop
    perform set_config('app.organisation_id', v_organisation_id::text, true);
    perform app.generate_journeys(v_organisation_id);
  end loop;
  perform set_config('app.organisation_id', '', true);
end
$$;

-- ---------------------------------------------------------------------------
-- Rules that now have journeys to check
-- ---------------------------------------------------------------------------

-- A bus cannot be retired while it is assigned to a journey that has not run (15.1).
create or replace function app.vehicles_before_update() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_upcoming int;
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
    select count(*) into v_upcoming
    from app.vehicle_assignments a join app.journeys j on j.id = a.journey_id
    where a.vehicle_id = new.id and a.state = 'ACTIVE' and j.state not in ('COMPLETED', 'CANCELLED');
    if v_upcoming > 0 then
      perform app.fail(format('This bus is assigned to %s journeys that have not run. Assign them another bus first.', v_upcoming));
    end if;
    new.retired_at := now();
  end if;
  return new;
end
$$;

create or replace function app.user_roles_scope_check() returns trigger
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
  if new.scope_type = 'journey' and not exists (
    select 1 from app.journeys where organisation_id = new.organisation_id and id = new.scope_id
  ) then
    perform app.fail('A journey role must point at one of the organisation''s journeys.');
  end if;
  return new;
end
$$;

-- ---------------------------------------------------------------------------
-- Shared plumbing
-- ---------------------------------------------------------------------------

do $$
declare
  v_table text;
begin
  foreach v_table in array array['schedules', 'journeys', 'journey_seats'] loop
    execute format('create trigger %1$s_updated_at before update on app.%1$I for each row execute function app.set_updated_at()', v_table);
  end loop;

  foreach v_table in array array['schedules', 'journeys', 'vehicle_assignments', 'journey_staff'] loop
    execute format('create trigger %1$s_no_delete before delete on app.%1$I for each row execute function app.refuse_delete()', v_table);
  end loop;

  -- Audited: plans and assignments. Seat and fare snapshots are copies, and journeys have their own event log.
  foreach v_table in array array['schedules', 'schedule_versions', 'schedule_exceptions', 'vehicle_assignments', 'journey_staff'] loop
    execute format('create trigger %1$s_audit after insert or update or delete on app.%1$I for each row execute function app.audit_row_change()', v_table);
  end loop;

  foreach v_table in array array['schedules', 'schedule_versions', 'schedule_exceptions', 'journeys', 'journey_events',
                                 'vehicle_assignments', 'journey_seats', 'journey_fares', 'journey_staff'] loop
    execute format('alter table app.%I enable row level security', v_table);
    execute format(
      'create policy org_boundary on app.%I to app_runtime using (organisation_id = app.current_organisation_id()) with check (organisation_id = app.current_organisation_id())',
      v_table);
    execute format('grant select, insert on app.%I to app_runtime', v_table);
  end loop;
end
$$;

grant update on app.schedules, app.journeys, app.vehicle_assignments, app.journey_seats, app.journey_staff to app_runtime;
grant delete on app.schedule_exceptions, app.journey_seats to app_runtime;

-- Exceptions may be removed only for dates that are still ahead.
create function app.schedule_exceptions_before_delete() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.service_date <= (now() at time zone (select timezone from app.organisations where id = old.organisation_id))::date then
    perform app.fail('Exceptions for today or earlier are kept as history.');
  end if;
  return old;
end
$$;

create trigger schedule_exceptions_before_delete before delete on app.schedule_exceptions
  for each row execute function app.schedule_exceptions_before_delete();

grant execute on function
  app.setting_int(uuid, text), app.schedule_versions_before_insert(), app.schedule_versions_after_insert(),
  app.schedules_before_update(), app.record_journey_event(uuid, text, text, text, text, int, uuid),
  app.vehicle_assignments_before_update(), app.journey_seats_guard(), app.journey_fares_before_insert(),
  app.journey_staff_before_write(), app.journeys_before_update(), app.journeys_after_write(),
  app.move_journey(uuid, text, text), app.publish_journey(uuid),
  app.assign_journey_staff(uuid, uuid, text), app.generate_journeys(uuid, date, int),
  app.schedule_exceptions_before_delete()
to app_runtime;

revoke all on all tables in schema app from anon, authenticated;
revoke all on all functions in schema app from anon, authenticated;
