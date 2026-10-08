-- Phase A: Foundations.
-- Conventions (spec 10.9), organisation boundary (10.9, 19.3), people,
-- roles and permissions (5, 10.1), settings (2, 10.1) and the audit log
-- (10.7, 19.8).
--
-- Rules every later migration follows:
--   * Tables live in schema `app`, which Supabase's REST API never exposes (spec 20.5).
--   * ids are time-ordered uuids made by the database: app.uuid_v7().
--   * Money is bigint pesewas plus char(3) currency. Time is timestamptz.
--   * Every organisation-owned table has organisation_id, a unique key on
--     (organisation_id, id), composite foreign keys, and the org_boundary policy.
--   * ON DELETE RESTRICT everywhere (the default). No cascades.

create schema if not exists app;
revoke all on schema app from public;
alter default privileges in schema app revoke execute on functions from public;

-- The server runs every business transaction as this role, with
-- app.organisation_id set, so row-level security applies (decision T5).
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_runtime') then
    create role app_runtime nologin noinherit;
  end if;
end
$$;
grant app_runtime to postgres;
grant usage on schema app to app_runtime;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Time-ordered uuid (version 7): 48 bits of milliseconds, then random bits.
create function app.uuid_v7() returns uuid
language plpgsql volatile
as $$
declare
  v_bytes bytea := uuid_send(gen_random_uuid());
  v_ms bigint := floor(extract(epoch from clock_timestamp()) * 1000);
begin
  v_bytes := overlay(v_bytes placing substring(int8send(v_ms) from 3) from 1 for 6);
  v_bytes := set_byte(v_bytes, 6, (get_byte(v_bytes, 6) & 15) | 112);
  v_bytes := set_byte(v_bytes, 8, (get_byte(v_bytes, 8) & 63) | 128);
  return encode(v_bytes, 'hex')::uuid;
end
$$;

-- The organisation the current transaction acts for. Null when unset, so a
-- query that forgot to set it sees nothing (spec 19.3).
create function app.current_organisation_id() returns uuid
language sql stable
as $$ select nullif(current_setting('app.organisation_id', true), '')::uuid $$;

-- The person acting, or null for the system.
create function app.current_actor_id() returns uuid
language sql stable
as $$ select nullif(current_setting('app.actor_user_id', true), '')::uuid $$;

create function app.request_setting(p_name text) returns text
language sql stable
as $$ select nullif(current_setting('app.' || p_name, true), '') $$;

create function app.set_updated_at() returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

-- Ledger, audit, webhook raw bodies and boarding records never change (spec 10.9).
create function app.refuse_change() returns trigger
language plpgsql
as $$
begin
  raise exception '% on %.% is not allowed: the table is append-only', tg_op, tg_table_schema, tg_table_name
    using errcode = 'P0001';
end
$$;

-- People, organisations and roles are deactivated or archived, never deleted.
create function app.refuse_delete() returns trigger
language plpgsql
as $$
begin
  raise exception 'Rows in %.% are never deleted; deactivate or archive instead', tg_table_schema, tg_table_name
    using errcode = 'P0001';
end
$$;

-- Masks a sensitive value for audit records, keeping the last two characters.
create function app.mask(p_value text) returns text
language sql immutable
as $$
  select case
    when p_value is null then null
    when length(p_value) <= 4 then repeat('*', length(p_value))
    else repeat('*', length(p_value) - 2) || right(p_value, 2)
  end
$$;

-- ---------------------------------------------------------------------------
-- Organisations
-- ---------------------------------------------------------------------------

create table app.organisations (
  id uuid primary key default app.uuid_v7(),
  name text not null check (length(trim(name)) between 2 and 120),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  -- Null: no public contact number published yet.
  phone text check (phone ~ '^\+[1-9][0-9]{7,14}$'),
  -- Null: no public contact email published yet.
  email text,
  currency char(3) not null default 'GHS' check (currency ~ '^[A-Z]{3}$'),
  timezone text not null default 'Africa/Accra',
  status text not null default 'active' check (status in ('active', 'suspended')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger organisations_updated_at before update on app.organisations
  for each row execute function app.set_updated_at();
create trigger organisations_no_delete before delete on app.organisations
  for each row execute function app.refuse_delete();

-- ---------------------------------------------------------------------------
-- People
-- ---------------------------------------------------------------------------

-- Passengers and staff. A user never stores a role directly (spec 10.1).
create table app.users (
  id uuid primary key default app.uuid_v7(),
  organisation_id uuid not null references app.organisations (id),
  -- The Supabase Auth identity that proves who this person is.
  auth_user_id uuid not null unique references auth.users (id),
  kind text not null check (kind in ('passenger', 'staff')),
  -- Null: a passenger who has not given a name yet.
  full_name text check (length(trim(full_name)) between 1 and 120),
  -- Null: a staff member with no phone number on record. E.164 format.
  phone text check (phone ~ '^\+[1-9][0-9]{7,14}$'),
  -- Null: no email given (email is optional for passengers, D8).
  email text check (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  status text not null default 'active' check (status in ('active', 'deactivated')),
  -- Null: the phone number has never changed since the account was made.
  -- Money-affecting actions wait 24 hours after a change (spec 19.1).
  phone_changed_at timestamptz,
  -- Null: the account is active.
  deactivated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organisation_id, id),
  check ((status = 'deactivated') = (deactivated_at is not null))
);

create unique index users_phone_per_organisation on app.users (organisation_id, phone) where phone is not null;

create trigger users_updated_at before update on app.users
  for each row execute function app.set_updated_at();
create trigger users_no_delete before delete on app.users
  for each row execute function app.refuse_delete();

-- ---------------------------------------------------------------------------
-- Roles and permissions (spec 5). Code checks a permission, never a role name.
-- ---------------------------------------------------------------------------

-- The permission catalogue is global; organisations choose which roles hold which permissions.
create table app.permissions (
  code text primary key check (code ~ '^[a-z]+(\.[a-z]+)+$'),
  description text not null,
  -- High-risk permissions need a fresh confirmation and a reason, and are always audited.
  high_risk boolean not null default false,
  created_at timestamptz not null default now()
);

insert into app.permissions (code, description, high_risk) values
  ('booking.create.own',       'Book as oneself', false),
  ('booking.view.own',         'See own bookings and tickets', false),
  ('booking.create.station',   'Sell a booking at a station', false),
  ('booking.view.scope',       'See bookings in scope', false),
  ('booking.cancel.scope',     'Cancel a booking in scope', false),
  ('booking.override',         'Override a rule, with a reason', true),
  ('ticket.scan',              'Scan and board', false),
  ('ticket.board.manual',      'Board by manual lookup', false),
  ('ticket.override.board',    'Board against a failed check, with a reason', true),
  ('journey.view.assigned',    'See assigned journeys and manifest', false),
  ('journey.update.status',    'Record departure, arrival, delay', false),
  ('journey.create',           'Create or generate journeys', false),
  ('journey.cancel',           'Cancel a journey', true),
  ('vehicle.assign',           'Assign or substitute a vehicle', false),
  ('fleet.manage',             'Vehicles and seat layouts', false),
  ('route.manage',             'Locations, routes, stops', false),
  ('schedule.manage',          'Schedules and exceptions', false),
  ('fare.manage',              'Fare templates and concession types', false),
  ('payment.view',             'See payments', false),
  ('refund.request',           'Request a refund', false),
  ('refund.approve',           'Approve a refund', true),
  ('finance.reconcile',        'Run and sign off reconciliation', false),
  ('finance.export',           'Export financial data', true),
  ('passenger.export',         'Export passenger lists', true),
  ('staff.manage',             'Invite and deactivate staff', false),
  ('role.manage',              'Change roles and permissions', true),
  ('settings.manage',          'Organisation settings and decision-log values', false),
  ('audit.view',               'Read the audit log', false),
  ('notification.send.manual', 'Send a manual notice to a journey''s passengers', false);

create table app.roles (
  id uuid primary key default app.uuid_v7(),
  organisation_id uuid not null references app.organisations (id),
  name text not null check (length(trim(name)) between 2 and 60),
  description text not null default '',
  -- Holders must sign in with a second factor (spec 19.2).
  requires_second_factor boolean not null default false,
  -- Seeded by the platform; may be edited but not archived.
  is_system boolean not null default false,
  status text not null default 'active' check (status in ('active', 'archived')),
  -- Null: created by the system, not a person.
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organisation_id, id),
  foreign key (organisation_id, created_by) references app.users (organisation_id, id)
);

create unique index roles_name_per_organisation on app.roles (organisation_id, lower(name));

create trigger roles_updated_at before update on app.roles
  for each row execute function app.set_updated_at();
create trigger roles_no_delete before delete on app.roles
  for each row execute function app.refuse_delete();

create table app.role_permissions (
  organisation_id uuid not null,
  role_id uuid not null,
  permission_code text not null references app.permissions (code),
  -- Null: granted by the system, not a person.
  created_by uuid,
  created_at timestamptz not null default now(),
  primary key (organisation_id, role_id, permission_code),
  foreign key (organisation_id, role_id) references app.roles (organisation_id, id),
  foreign key (organisation_id, created_by) references app.users (organisation_id, id)
);

-- A role held by a person, within a scope: the whole organisation, a station or a journey.
-- Assignments are revoked, never deleted, so history stays attributable.
create table app.user_roles (
  id uuid primary key default app.uuid_v7(),
  organisation_id uuid not null,
  user_id uuid not null,
  role_id uuid not null,
  scope_type text not null check (scope_type in ('organisation', 'station', 'journey')),
  -- Null: organisation scope. Otherwise the station (location) or journey id;
  -- those tables arrive in phases B and C, which add the check that it exists.
  scope_id uuid,
  -- Null: granted by the system (for example a passenger's own role).
  granted_by uuid,
  granted_at timestamptz not null default now(),
  -- Null: still in force.
  revoked_at timestamptz,
  -- Null: not revoked, or revoked by the system.
  revoked_by uuid,
  unique (organisation_id, id),
  foreign key (organisation_id, user_id) references app.users (organisation_id, id),
  foreign key (organisation_id, role_id) references app.roles (organisation_id, id),
  foreign key (organisation_id, granted_by) references app.users (organisation_id, id),
  foreign key (organisation_id, revoked_by) references app.users (organisation_id, id),
  check ((scope_type = 'organisation') = (scope_id is null)),
  check (revoked_at is null or revoked_at >= granted_at)
);

create unique index user_roles_one_active
  on app.user_roles (organisation_id, user_id, role_id, scope_type, coalesce(scope_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where revoked_at is null;
create index user_roles_by_user on app.user_roles (organisation_id, user_id) where revoked_at is null;

create trigger user_roles_no_delete before delete on app.user_roles
  for each row execute function app.refuse_delete();

-- ---------------------------------------------------------------------------
-- Settings: every decision-log value (spec 2, 10.1)
-- ---------------------------------------------------------------------------

create table app.setting_definitions (
  key text primary key check (key ~ '^[a-z_]+(\.[a-z_]+)+$'),
  -- Null: a technical setting with no decision-log entry.
  decision text check (decision ~ '^D[0-9]+$'),
  description text not null,
  value_type text not null check (value_type in ('number', 'boolean', 'string', 'object')),
  default_value jsonb not null,
  check (jsonb_typeof(default_value) = value_type)
);

insert into app.setting_definitions (key, decision, description, value_type, default_value) values
  ('seat_sales.mode', 'D1', 'whole_journey in release 1; segment in release 2', 'string', '"whole_journey"'),
  ('hold.minutes', 'D2', 'Seat hold length from selection', 'number', '10'),
  ('hold.payment_extension_minutes', 'D3', 'Hold runs until this long after a payment attempt began', 'number', '10'),
  ('hold.max_total_minutes', 'D3', 'A hold never runs beyond this long from first selection', 'number', '20'),
  ('booking.online_close_minutes', 'D5', 'Online booking closes this long before departure', 'number', '30'),
  ('booking.max_seats', 'D6', 'Maximum seats per booking', 'number', '6'),
  ('booking.max_active_holds', 'D7', 'Maximum active unpaid bookings per phone number and account', 'number', '2'),
  ('booking.guest_allowed', 'D9', 'Guests may book without an account', 'boolean', 'true'),
  ('station_cash.enabled', 'D12', 'Station cash sales (release 2)', 'boolean', 'false'),
  ('refund.policy', 'D14', 'Cancellation refund bands', 'object',
    '{"bands":[{"min_hours_before":24,"refund_percent":100,"deduct_provider_fee":true},{"min_hours_before":6,"refund_percent":50,"deduct_provider_fee":false},{"min_hours_before":0,"refund_percent":0,"deduct_provider_fee":false}],"operator_cancellation_percent":100,"operator_cancellation_includes_fees":true}'),
  ('fleet.turnaround_minutes', 'D16', 'Minimum gap between a vehicle''s journeys', 'number', '60'),
  ('retention.passenger_months', 'D19', 'Passenger details kept this long after the journey', 'number', '24'),
  ('retention.financial_years', 'D19', 'Financial and audit records kept this long', 'number', '7'),
  ('journeys.generation_horizon_days', 'D23', 'Journeys are generated this many days ahead', 'number', '30'),
  ('booking.open_days_before', 'D23', 'Booking opens this many days before departure', 'number', '30'),
  ('booking.auto_reseat_late_payment', 'D24', 'Re-seat a late payment to a same-class seat automatically', 'boolean', 'true'),
  ('concession.max_validity_months', 'D25', 'Student concession validity, at most', 'number', '12'),
  ('exceptions.response_minutes', 'D27', 'Exception response times by kind', 'object',
    '{"money_taken_no_ticket":60,"failed_refund":240,"reconciliation_mismatch":240,"other":"next_working_day"}'),
  ('paystack.placeholder_email_domain', 'D30', 'Domain for the non-receiving email used when a passenger gave none', 'string', '"payments.invalid"'),
  ('fees.passenger_pays_provider_fee', 'D31', 'Add Paystack''s fee to the passenger''s total as a visible line', 'boolean', 'false');

create table app.settings (
  organisation_id uuid not null references app.organisations (id),
  key text not null references app.setting_definitions (key),
  value jsonb not null,
  -- Null: set by the system (the default when the organisation was created).
  changed_by uuid,
  changed_at timestamptz not null default now(),
  primary key (organisation_id, key),
  foreign key (organisation_id, changed_by) references app.users (organisation_id, id)
);

create function app.settings_before_write() returns trigger
language plpgsql
as $$
declare
  v_type text;
begin
  select value_type into v_type from app.setting_definitions where key = new.key;
  if jsonb_typeof(new.value) <> v_type then
    raise exception 'Setting % must be a %, got %', new.key, v_type, jsonb_typeof(new.value)
      using errcode = '22023';
  end if;
  new.changed_at := now();
  new.changed_by := app.current_actor_id();
  return new;
end
$$;

create trigger settings_before_write before insert or update on app.settings
  for each row execute function app.settings_before_write();
create trigger settings_no_delete before delete on app.settings
  for each row execute function app.refuse_delete();

-- ---------------------------------------------------------------------------
-- Audit log (spec 10.7, 19.8). Append-only for every role, including the owner.
-- ---------------------------------------------------------------------------

create table app.audit_logs (
  id uuid primary key default app.uuid_v7(),
  -- Null: a platform-level event that belongs to no organisation.
  organisation_id uuid references app.organisations (id),
  occurred_at timestamptz not null default now(),
  actor_type text not null check (actor_type in ('user', 'system', 'provider')),
  -- Null: the actor is the system or a provider.
  actor_user_id uuid,
  action text not null check (action ~ '^[a-z_]+(\.[a-z_]+)+$'),
  entity_type text not null,
  -- Null: the action is not about one entity (for example an export).
  entity_id text,
  -- Null: nothing existed before (a creation) or the value is not recorded.
  before jsonb,
  -- Null: nothing exists after (a removal) or the value is not recorded.
  after jsonb,
  -- Null: no reason was required.
  reason text,
  -- Null: the change was not made through a web request.
  source_address inet,
  -- Null: the change was not made through a web request.
  device text,
  -- Null: the change was not made through a web request.
  correlation_id text,
  foreign key (organisation_id, actor_user_id) references app.users (organisation_id, id),
  check ((actor_type = 'user') = (actor_user_id is not null))
);

create index audit_logs_by_entity on app.audit_logs (organisation_id, entity_type, entity_id, occurred_at desc);
create index audit_logs_by_time on app.audit_logs (organisation_id, occurred_at desc);

create trigger audit_logs_immutable before update or delete on app.audit_logs
  for each row execute function app.refuse_change();
create trigger audit_logs_no_truncate before truncate on app.audit_logs
  for each statement execute function app.refuse_change();

-- Writes one audit entry using the request context set by the server
-- (actor, reason, address, device, correlation id).
create function app.write_audit(
  p_action text,
  p_entity_type text,
  p_entity_id text,
  p_before jsonb default null,
  p_after jsonb default null,
  p_organisation_id uuid default app.current_organisation_id()
) returns uuid
language plpgsql
as $$
declare
  v_id uuid;
  v_actor uuid := app.current_actor_id();
begin
  insert into app.audit_logs (
    organisation_id, actor_type, actor_user_id, action, entity_type, entity_id,
    before, after, reason, source_address, device, correlation_id
  ) values (
    p_organisation_id,
    case when v_actor is null then 'system' else 'user' end,
    v_actor, p_action, p_entity_type, p_entity_id, p_before, p_after,
    app.request_setting('reason'),
    app.request_setting('source_address')::inet,
    app.request_setting('device'),
    app.request_setting('correlation_id')
  ) returning id into v_id;
  return v_id;
end
$$;

-- Audits every change to a table. Trigger arguments name columns to mask.
create function app.audit_row_change() returns trigger
language plpgsql
as $$
declare
  v_before jsonb;
  v_after jsonb;
  v_row jsonb;
  v_column text;
  v_organisation_id uuid;
begin
  if tg_op in ('UPDATE', 'DELETE') then v_before := to_jsonb(old); end if;
  if tg_op in ('INSERT', 'UPDATE') then v_after := to_jsonb(new); end if;
  if tg_op = 'UPDATE' and (v_before - 'updated_at') = (v_after - 'updated_at') then
    return null;
  end if;

  foreach v_column in array coalesce(tg_argv, '{}'::text[]) loop
    if v_before ? v_column then
      v_before := jsonb_set(v_before, array[v_column], coalesce(to_jsonb(app.mask(v_before ->> v_column)), 'null'));
    end if;
    if v_after ? v_column then
      v_after := jsonb_set(v_after, array[v_column], coalesce(to_jsonb(app.mask(v_after ->> v_column)), 'null'));
    end if;
  end loop;

  v_row := coalesce(v_after, v_before);
  v_organisation_id := case when tg_table_name = 'organisations'
    then (v_row ->> 'id')::uuid
    else (v_row ->> 'organisation_id')::uuid end;

  perform app.write_audit(
    tg_table_name || '.' || lower(tg_op),
    tg_table_name,
    coalesce(v_row ->> 'id', v_row ->> 'key', (v_row ->> 'role_id') || '/' || (v_row ->> 'permission_code')),
    v_before,
    v_after,
    v_organisation_id
  );
  return null;
end
$$;

create trigger organisations_audit after insert or update on app.organisations
  for each row execute function app.audit_row_change('phone', 'email');
create trigger users_audit after insert or update on app.users
  for each row execute function app.audit_row_change('phone', 'email', 'full_name');
create trigger roles_audit after insert or update on app.roles
  for each row execute function app.audit_row_change();
create trigger role_permissions_audit after insert or delete on app.role_permissions
  for each row execute function app.audit_row_change();
create trigger user_roles_audit after insert or update on app.user_roles
  for each row execute function app.audit_row_change();
create trigger settings_audit after insert or update on app.settings
  for each row execute function app.audit_row_change();

-- ---------------------------------------------------------------------------
-- Permission lookup
-- ---------------------------------------------------------------------------

-- The permissions a person holds, with the scope of each. Deactivated people hold none.
create function app.user_permissions(p_user_id uuid)
returns table (permission_code text, scope_type text, scope_id uuid, high_risk boolean, requires_second_factor boolean)
language sql stable
as $$
  select distinct rp.permission_code, ur.scope_type, ur.scope_id, p.high_risk, r.requires_second_factor
  from app.user_roles ur
  join app.users u on u.organisation_id = ur.organisation_id and u.id = ur.user_id
  join app.roles r on r.organisation_id = ur.organisation_id and r.id = ur.role_id
  join app.role_permissions rp on rp.organisation_id = r.organisation_id and rp.role_id = r.id
  join app.permissions p on p.code = rp.permission_code
  where ur.user_id = p_user_id
    and ur.revoked_at is null
    and u.status = 'active'
    and r.status = 'active'
$$;

-- Finds or creates the passenger record for a signed-in phone identity and
-- makes sure it holds the Passenger role. Safe to call on every sign-in.
create function app.ensure_passenger(p_auth_user_id uuid, p_phone text) returns uuid
language plpgsql
as $$
declare
  v_organisation_id uuid := app.current_organisation_id();
  v_user_id uuid;
  v_role_id uuid;
begin
  if v_organisation_id is null then
    raise exception 'No organisation set for this request' using errcode = '42501';
  end if;

  select id into v_user_id from app.users where auth_user_id = p_auth_user_id;
  if v_user_id is null then
    insert into app.users (organisation_id, auth_user_id, kind, phone)
    values (v_organisation_id, p_auth_user_id, 'passenger', p_phone)
    returning id into v_user_id;
  end if;

  select id into v_role_id from app.roles
  where organisation_id = v_organisation_id and is_system and lower(name) = 'passenger';

  insert into app.user_roles (organisation_id, user_id, role_id, scope_type)
  values (v_organisation_id, v_user_id, v_role_id, 'organisation')
  on conflict do nothing;

  return v_user_id;
end
$$;

-- ---------------------------------------------------------------------------
-- Creating an organisation: default settings and the default roles of spec 5.
-- Run by the platform (owner role), never by a request.
-- ---------------------------------------------------------------------------

create function app.create_organisation(p_name text, p_slug text) returns uuid
language plpgsql
as $$
declare
  v_organisation_id uuid;
  v_role record;
  v_role_id uuid;
begin
  insert into app.organisations (name, slug) values (p_name, p_slug)
  returning id into v_organisation_id;

  perform set_config('app.organisation_id', v_organisation_id::text, true);

  insert into app.settings (organisation_id, key, value)
  select v_organisation_id, key, default_value from app.setting_definitions;

  for v_role in
    select * from (values
      ('Passenger', 'Search, book, pay and manage own trips', false,
        array['booking.create.own', 'booking.view.own']),
      ('Station Agent', 'Assist passengers, look up bookings, board passengers', false,
        array['booking.create.station', 'booking.view.scope', 'ticket.scan', 'ticket.board.manual']),
      ('Conductor', 'Manifest, scanning, boarding, no-show marking', false,
        array['ticket.scan', 'ticket.board.manual', 'journey.view.assigned', 'journey.update.status']),
      ('Driver', 'Journey status and trip information', false,
        array['journey.view.assigned', 'journey.update.status']),
      ('Operations Manager', 'Routes, schedules, journeys, vehicles, assignments, disruptions', true,
        array['booking.view.scope', 'booking.cancel.scope', 'booking.override', 'ticket.override.board',
              'journey.update.status', 'journey.create', 'journey.cancel', 'vehicle.assign', 'fleet.manage',
              'route.manage', 'schedule.manage', 'fare.manage', 'refund.request', 'passenger.export',
              'notification.send.manual']),
      ('Finance', 'Payments, refunds, reconciliation, finance reports', true,
        array['payment.view', 'refund.request', 'refund.approve', 'finance.reconcile', 'finance.export', 'audit.view']),
      ('Support', 'Passenger help and controlled booking assistance', false,
        array['booking.view.scope', 'booking.cancel.scope', 'payment.view', 'refund.request']),
      ('Administrator', 'Organisation settings, staff and roles', true,
        array['fare.manage', 'staff.manage', 'role.manage', 'settings.manage', 'audit.view'])
    ) as r(name, description, requires_second_factor, permissions)
  loop
    insert into app.roles (organisation_id, name, description, requires_second_factor, is_system)
    values (v_organisation_id, v_role.name, v_role.description, v_role.requires_second_factor, true)
    returning id into v_role_id;

    insert into app.role_permissions (organisation_id, role_id, permission_code)
    select v_organisation_id, v_role_id, unnest(v_role.permissions);
  end loop;

  return v_organisation_id;
end
$$;

-- ---------------------------------------------------------------------------
-- Organisation boundary: row-level security for the runtime role
-- ---------------------------------------------------------------------------

alter table app.organisations enable row level security;
create policy org_boundary on app.organisations to app_runtime
  using (id = app.current_organisation_id());

do $$
declare
  v_table text;
begin
  foreach v_table in array array['users', 'roles', 'role_permissions', 'user_roles', 'settings', 'audit_logs'] loop
    execute format('alter table app.%I enable row level security', v_table);
    execute format(
      'create policy org_boundary on app.%I to app_runtime using (organisation_id = app.current_organisation_id()) with check (organisation_id = app.current_organisation_id())',
      v_table);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- Grants. The runtime role gets exactly what business operations need.
-- Supabase's API roles get nothing (decision T4).
-- ---------------------------------------------------------------------------

grant select on app.organisations, app.permissions, app.setting_definitions to app_runtime;
grant select, insert, update on app.users, app.roles, app.user_roles, app.settings to app_runtime;
grant select, insert, delete on app.role_permissions to app_runtime;
grant select, insert on app.audit_logs to app_runtime;

grant execute on function
  app.uuid_v7(), app.current_organisation_id(), app.current_actor_id(), app.request_setting(text),
  app.set_updated_at(), app.refuse_change(), app.refuse_delete(), app.mask(text),
  app.settings_before_write(), app.write_audit(text, text, text, jsonb, jsonb, uuid),
  app.audit_row_change(), app.user_permissions(uuid), app.ensure_passenger(uuid, text)
to app_runtime;

revoke all on all tables in schema app from anon, authenticated;
revoke all on all functions in schema app from anon, authenticated;
