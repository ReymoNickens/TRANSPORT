-- Demo data for local development and previews: the Accra → Cape Coast pilot
-- corridor, one 2+2 coach, fares, a student concession, a booking fee and a
-- daily 07:00 schedule, then journeys generated for the next week.
-- Run after the migrations and seed.sql. Never run against production.

do $$
declare
  v_org uuid := (select id from app.organisations where slug = 'pilot');
  v_accra uuid;
  v_kasoa uuid;
  v_winneba uuid;
  v_cape uuid;
  v_route uuid;
  v_s1 uuid; v_s2 uuid; v_s3 uuid; v_s4 uuid;
  v_fares uuid;
  v_bus uuid;
  v_layout uuid;
  v_schedule uuid;
  v_row int;
  v_col int;
  v_letter text;
begin
  if v_org is null then
    raise exception 'Run supabase/seed.sql first (organisation "pilot").';
  end if;
  perform set_config('app.organisation_id', v_org::text, true);

  insert into app.locations (organisation_id, name, location_type, city, region) values
    (v_org, 'Accra, Circle Station', 'terminal', 'Accra', 'Greater Accra') returning id into v_accra;
  insert into app.locations (organisation_id, name, location_type, city, region) values
    (v_org, 'Kasoa Junction', 'stop', 'Kasoa', 'Central') returning id into v_kasoa;
  insert into app.locations (organisation_id, name, location_type, city, region) values
    (v_org, 'Winneba Station', 'station', 'Winneba', 'Central') returning id into v_winneba;
  insert into app.locations (organisation_id, name, location_type, city, region) values
    (v_org, 'Cape Coast, UCC Gate', 'terminal', 'Cape Coast', 'Central') returning id into v_cape;

  insert into app.routes (organisation_id, name, origin_location_id, destination_location_id, distance_km)
  values (v_org, 'Accra to Cape Coast', v_accra, v_cape, 145) returning id into v_route;
  insert into app.route_stops (organisation_id, route_id, location_id, sequence, arrival_offset_minutes, departure_offset_minutes, boarding_allowed, dropoff_allowed)
    values (v_org, v_route, v_accra, 1, 0, 0, true, false) returning id into v_s1;
  insert into app.route_stops (organisation_id, route_id, location_id, sequence, arrival_offset_minutes, departure_offset_minutes, boarding_allowed, dropoff_allowed)
    values (v_org, v_route, v_kasoa, 2, 40, 45, true, true) returning id into v_s2;
  insert into app.route_stops (organisation_id, route_id, location_id, sequence, arrival_offset_minutes, departure_offset_minutes, boarding_allowed, dropoff_allowed)
    values (v_org, v_route, v_winneba, 3, 90, 95, true, true) returning id into v_s3;
  insert into app.route_stops (organisation_id, route_id, location_id, sequence, arrival_offset_minutes, departure_offset_minutes, boarding_allowed, dropoff_allowed)
    values (v_org, v_route, v_cape, 4, 165, 165, false, true) returning id into v_s4;
  update app.routes set status = 'active' where id = v_route;

  insert into app.fare_templates (organisation_id, route_id, name) values (v_org, v_route, 'Standard fares 2026') returning id into v_fares;
  insert into app.fare_rules (organisation_id, template_id, route_id, origin_stop_id, destination_stop_id, seat_type, amount_pesewas, currency) values
    (v_org, v_fares, v_route, v_s1, v_s2, 'standard', 2500, 'GHS'),
    (v_org, v_fares, v_route, v_s1, v_s3, 'standard', 5000, 'GHS'),
    (v_org, v_fares, v_route, v_s1, v_s4, 'standard', 8000, 'GHS'),
    (v_org, v_fares, v_route, v_s1, v_s4, 'premium', 10000, 'GHS'),
    (v_org, v_fares, v_route, v_s2, v_s3, 'standard', 3000, 'GHS'),
    (v_org, v_fares, v_route, v_s2, v_s4, 'standard', 6000, 'GHS'),
    (v_org, v_fares, v_route, v_s3, v_s4, 'standard', 3500, 'GHS');
  update app.fare_templates set status = 'active' where id = v_fares;

  insert into app.concession_types (organisation_id, name, code, discount_kind, discount_basis_points)
    values (v_org, 'Student', 'student', 'percent', 1000);
  insert into app.fee_rules (organisation_id, name, category, calculation, amount_pesewas, applies_to)
    values (v_org, 'Booking fee', 'booking_fee', 'fixed', 150, 'online');

  insert into app.vehicles (organisation_id, registration, fleet_number, vehicle_type, make, capacity)
    values (v_org, 'GR-2468-24', 'C1', 'coach', 'Yutong', 52) returning id into v_bus;
  insert into app.seat_layouts (organisation_id, vehicle_id, version, name, row_count, column_count)
    values (v_org, v_bus, 1, '2+2 coach', 13, 5) returning id into v_layout;
  for v_row in 1..13 loop
    for v_col in 1..5 loop
      continue when v_col = 3;
      v_letter := case v_col when 1 then 'A' when 2 then 'B' when 4 then 'C' else 'D' end;
      insert into app.seats (organisation_id, layout_id, seat_number, row_number, column_number, seat_type, position)
      values (v_org, v_layout, v_row || v_letter, v_row, v_col,
              case when v_row = 1 then 'premium' else 'standard' end,
              case when v_col in (1, 5) then 'window' else 'aisle' end);
    end loop;
  end loop;
  update app.seat_layouts set status = 'published' where id = v_layout;

  insert into app.schedules (organisation_id, route_id, name) values (v_org, v_route, 'Daily 07:00') returning id into v_schedule;
  insert into app.schedule_versions (organisation_id, schedule_id, version, departure_time, days_of_week, default_vehicle_id)
    values (v_org, v_schedule, 1, '07:00', '{1,2,3,4,5,6,7}', v_bus);

  perform app.generate_journeys(v_org, null, 7);
end
$$;
