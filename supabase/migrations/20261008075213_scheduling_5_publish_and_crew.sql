-- Phase C: scheduling, part 5 of 7: putting a journey on sale, and crew.
-- Row-level security, grants and audit for the Phase C tables are set in part 6.

-- Copies the route's live fares and puts a draft journey on sale (D23).
create function app.publish_journey(p_journey_id uuid) returns void
language plpgsql
set search_path = ''
as $$
declare
  v_journey record;
  v_template_id uuid;
begin
  select * into v_journey from app.journeys where id = p_journey_id for update;
  if not found then
    perform app.fail('That journey does not exist.');
  end if;
  if v_journey.state <> 'DRAFT' then
    perform app.fail('Only a draft journey can be put on sale.');
  end if;
  if v_journey.scheduled_departure_at <= now() then
    perform app.fail('A journey in the past cannot go on sale.');
  end if;
  select id into v_template_id from app.fare_templates where route_id = v_journey.route_id and status = 'active';
  if v_template_id is null then
    perform app.fail('The route has no live fare table, so the journey cannot be priced.');
  end if;

  insert into app.journey_fares (organisation_id, journey_id, route_id, origin_stop_id, destination_stop_id, seat_type,
                                 amount_pesewas, currency, source_template_id, source_fare_rule_id)
  select r.organisation_id, p_journey_id, r.route_id, r.origin_stop_id, r.destination_stop_id, r.seat_type,
         r.amount_pesewas, r.currency, r.template_id, r.id
  from app.fare_rules r where r.template_id = v_template_id;

  perform app.move_journey(p_journey_id, 'SCHEDULED', 'Put on sale');
end
$$;

-- Puts a person on a journey's crew.
create function app.assign_journey_staff(p_journey_id uuid, p_user_id uuid, p_role text) returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_journey record;
  v_id uuid;
begin
  select * into v_journey from app.journeys where id = p_journey_id for update;
  if not found then
    perform app.fail('That journey does not exist.');
  end if;
  if v_journey.state in ('DEPARTED', 'COMPLETED', 'CANCELLED') then
    perform app.fail('Crew can only be changed before the journey leaves.');
  end if;
  begin
    insert into app.journey_staff (organisation_id, journey_id, user_id, staff_role, occupied_during, assigned_by)
    values (v_journey.organisation_id, p_journey_id, p_user_id, p_role,
            tstzrange(v_journey.scheduled_departure_at, v_journey.scheduled_arrival_at), app.current_actor_id())
    returning id into v_id;
  exception when exclusion_violation then
    perform app.fail('This person is already on another journey at that time.');
  end;
  perform app.record_journey_event(p_journey_id, 'staff_assigned', p_role);
  return v_id;
end
$$;
