-- Phase C: scheduling, part 3 of 7: the journey state machine (9.1, 9.2). Only app.move_journey changes a
-- journey's state; the trigger refuses anything else and any illegal move.
-- Row-level security, grants and audit for the Phase C tables are set in part 6.

create function app.journeys_before_update() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_allowed text[];
  v_buffer int;
begin
  if new.state is distinct from old.state then
    if app.request_setting('state_move') is distinct from 'journey:' || old.id::text then
      perform app.fail('A journey''s status changes only through the journey status function.');
    end if;
    v_allowed := case old.state
      when 'DRAFT' then array['SCHEDULED', 'CANCELLED']
      when 'SCHEDULED' then array['SALES_CLOSED', 'BOARDING', 'CANCELLED']
      when 'SALES_CLOSED' then array['BOARDING', 'CANCELLED']
      when 'BOARDING' then array['DEPARTED', 'CANCELLED']
      when 'DEPARTED' then array['COMPLETED']
      else array[]::text[]
    end;
    if not new.state = any(v_allowed) then
      perform app.fail(format('A journey cannot go from %s to %s.', old.state, new.state));
    end if;

    if new.state = 'SCHEDULED' then
      if not exists (select 1 from app.vehicle_assignments where journey_id = new.id and state = 'ACTIVE') then
        perform app.fail('The journey needs a bus before it can go on sale.');
      end if;
      if not exists (select 1 from app.journey_seats where journey_id = new.id and state = 'BOOKABLE') then
        perform app.fail('The journey needs bookable seats before it can go on sale.');
      end if;
      if not exists (select 1 from app.journey_fares where journey_id = new.id) then
        perform app.fail('The journey needs fares before it can go on sale.');
      end if;
    end if;
    if new.state = 'DEPARTED' then
      new.actual_departure_at := coalesce(new.actual_departure_at, now());
    end if;
    if new.state = 'COMPLETED' then
      new.actual_arrival_at := coalesce(new.actual_arrival_at, now());
    end if;
    if new.state = 'CANCELLED' then
      new.cancelled_at := now();
      new.cancellation_reason := coalesce(app.request_setting('reason'), 'No reason given');
    end if;
  end if;

  if new.route_id <> old.route_id or new.schedule_id is distinct from old.schedule_id
     or new.service_date <> old.service_date then
    perform app.fail('A journey''s route, schedule and date cannot change. Cancel it and create another.');
  end if;

  if (new.scheduled_departure_at, new.scheduled_arrival_at) is distinct from (old.scheduled_departure_at, old.scheduled_arrival_at) then
    if old.state not in ('DRAFT', 'SCHEDULED') then
      perform app.fail('The times of a journey can change only before sales close.');
    end if;
    -- The bus and crew stay booked for the new times; a clash is refused.
    v_buffer := coalesce(app.setting_int(new.organisation_id, 'fleet.turnaround_minutes'), 60);
    update app.vehicle_assignments
      set occupied_during = tstzrange(new.scheduled_departure_at, new.scheduled_arrival_at + make_interval(mins => v_buffer))
      where journey_id = new.id and state = 'ACTIVE';
    update app.journey_staff
      set occupied_during = tstzrange(new.scheduled_departure_at, new.scheduled_arrival_at)
      where journey_id = new.id and removed_at is null;
  end if;
  return new;
end
$$;

create trigger journeys_before_update before update on app.journeys
  for each row execute function app.journeys_before_update();

create function app.journeys_after_write() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform app.record_journey_event(new.id, 'created');
  elsif new.state is distinct from old.state then
    perform app.record_journey_event(new.id, 'state_changed', null, old.state, new.state);
  elsif (new.scheduled_departure_at, new.scheduled_arrival_at) is distinct from (old.scheduled_departure_at, old.scheduled_arrival_at) then
    perform app.record_journey_event(new.id, 'times_changed');
  end if;
  return null;
end
$$;

create trigger journeys_after_write after insert or update on app.journeys
  for each row execute function app.journeys_after_write();
