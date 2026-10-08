-- Phase C: scheduling, part 4 of 7: the journey status function.
-- Row-level security, grants and audit for the Phase C tables are set in part 6.

-- The one function that moves a journey between states (9.1 rule 2).
-- Uses a conditional update so a concurrent move fails cleanly (10.9).
create function app.move_journey(p_journey_id uuid, p_to_state text, p_reason text default null) returns void
language plpgsql
set search_path = ''
as $$
declare
  v_from text;
  v_rows int;
begin
  select state into v_from from app.journeys where id = p_journey_id for update;
  if v_from is null then
    perform app.fail('That journey does not exist.');
  end if;
  if p_reason is not null then
    perform set_config('app.reason', p_reason, true);
  end if;
  perform set_config('app.state_move', 'journey:' || p_journey_id::text, true);
  update app.journeys set state = p_to_state where id = p_journey_id and state = v_from;
  get diagnostics v_rows = row_count;
  perform set_config('app.state_move', '', true);
  if v_rows <> 1 then
    perform app.fail('The journey was changed by someone else. Refresh and try again.');
  end if;

  if p_to_state = 'CANCELLED' then
    -- The bus and crew are free again.
    update app.vehicle_assignments set state = 'CANCELLED' where journey_id = p_journey_id and state = 'ACTIVE';
    update app.journey_staff set removed_at = now(), removed_by = app.current_actor_id()
      where journey_id = p_journey_id and removed_at is null;
  end if;
end
$$;
