-- Nightly journey generation (D23), using pg_cron where it is available
-- (Supabase). 02:10 Africa/Accra, which is UTC. Test databases without
-- pg_cron skip this; generation can also be run from the operations app.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule('generate-journeys', '10 2 * * *', 'select app.generate_journeys_all()');
  end if;
end
$$;
