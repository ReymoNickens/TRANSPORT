-- Local development data. Runs after the migrations on `npx supabase db reset`.
-- Never run against production.
select app.create_organisation('Pilot Transport', 'pilot');
