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
