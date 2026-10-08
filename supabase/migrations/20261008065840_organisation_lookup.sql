-- The server finds its organisation by slug before row-level security can
-- apply, because the organisation is what row-level security needs. This
-- function returns only the public fields of one active organisation, so the
-- application's database login needs no access beyond app_runtime.
create function app.organisation_by_slug(p_slug text)
returns table (id uuid, name text, slug text, timezone text, currency text)
language sql stable security definer
set search_path = ''
as $$
  select o.id, o.name, o.slug, o.timezone, o.currency::text
  from app.organisations o
  where o.slug = p_slug and o.status = 'active'
$$;

revoke all on function app.organisation_by_slug(text) from public;
grant execute on function app.organisation_by_slug(text) to app_runtime;
