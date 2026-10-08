-- Phase F, part 2: hardening (spec 19.5, 19.6, 22.3).
-- Rate limits shared by every server instance, a heartbeat for the background
-- job, and the operational alerts with their thresholds.

-- ---------------------------------------------------------------------------
-- Rate limits (19.5): fixed windows counted in the database
-- ---------------------------------------------------------------------------

create table app.rate_limit_hits (
  -- What is being limited and for whom, for example "scan:user:<id>" or "ticket_link:ip:<address>".
  key text not null check (length(key) between 3 and 200),
  window_start timestamptz not null,
  hits int not null default 1 check (hits >= 1),
  primary key (key, window_start)
);

alter table app.rate_limit_hits enable row level security;
-- Not organisation data: keys carry the organisation where it matters.
create policy runtime_only on app.rate_limit_hits to app_runtime using (true) with check (true);
grant select, insert, update on app.rate_limit_hits to app_runtime;
revoke all on app.rate_limit_hits from anon, authenticated;

-- Counts one attempt; true while the key is within p_limit attempts in the current window.
create function app.hit_rate_limit(p_key text, p_limit int, p_window_seconds int) returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_window timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  v_hits int;
begin
  insert into app.rate_limit_hits (key, window_start) values (p_key, v_window)
  on conflict (key, window_start) do update set hits = app.rate_limit_hits.hits + 1
  returning hits into v_hits;
  return v_hits <= p_limit;
end
$$;

-- Old windows are cleared every night.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('clear-rate-limits', '17 3 * * *', $job$delete from app.rate_limit_hits where window_start < now() - interval '1 day'$job$);
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Background job heartbeat (22.3 "Hold expiry job not run for 2 minutes")
-- ---------------------------------------------------------------------------

create table app.job_heartbeats (
  organisation_id uuid not null references app.organisations (id),
  job text not null check (job ~ '^[a-z_]+$'),
  last_run_at timestamptz not null default now(),
  -- What the last run reported.
  last_result jsonb not null default '{}',
  primary key (organisation_id, job)
);

alter table app.job_heartbeats enable row level security;
create policy org_boundary on app.job_heartbeats to app_runtime
  using (organisation_id = app.current_organisation_id()) with check (organisation_id = app.current_organisation_id());
grant select, insert, update on app.job_heartbeats to app_runtime;
revoke all on app.job_heartbeats from anon, authenticated;

create function app.record_heartbeat(p_job text, p_result jsonb) returns void
language sql
set search_path = ''
as $$
  insert into app.job_heartbeats (organisation_id, job, last_run_at, last_result)
  values (app.current_organisation_id(), p_job, now(), coalesce(p_result, '{}'))
  on conflict (organisation_id, job) do update set last_run_at = now(), last_result = excluded.last_result
$$;

-- ---------------------------------------------------------------------------
-- Operational alerts (22.3). Each signal with its threshold; an empty list means all is well.
-- ---------------------------------------------------------------------------

create function app.operational_alerts() returns jsonb
language plpgsql stable
set search_path = ''
as $$
declare
  v_org uuid := app.current_organisation_id();
  v_alerts jsonb := '[]';
  v_count int;
  v_total int;
  v_last timestamptz;
  v_day date;
  v_local timestamp := now() at time zone 'Africa/Accra';
begin
  -- Payment callbacks: payments are being started but no callback has arrived for 15 minutes.
  select count(*) into v_count from app.payment_attempts where organisation_id = v_org and started_at > now() - interval '15 minutes';
  select max(received_at) into v_last from app.webhook_events where organisation_id = v_org;
  if v_count >= 3 and (v_last is null or v_last < now() - interval '15 minutes') then
    v_alerts := v_alerts || jsonb_build_object('signal', 'payment_callbacks', 'severity', 'critical',
      'message', format('%s payments were started in the last 15 minutes but no payment callback has arrived.', v_count));
  end if;

  -- Pending payments: more than 20 waiting over 10 minutes.
  select count(*) into v_count from app.payment_attempts
    where organisation_id = v_org and state = 'PENDING' and started_at < now() - interval '10 minutes';
  if v_count > 20 then
    v_alerts := v_alerts || jsonb_build_object('signal', 'pending_payments', 'severity', 'high',
      'message', format('%s payments have been pending for more than 10 minutes.', v_count));
  end if;

  -- Late-success cases: any open.
  select count(*) into v_count from app.exceptions
    where organisation_id = v_org and kind = 'payment_after_seat_released' and state not in ('RESOLVED', 'DISMISSED');
  if v_count > 0 then
    v_alerts := v_alerts || jsonb_build_object('signal', 'late_success', 'severity', 'high',
      'message', format('%s payment(s) arrived after the seat was released and need checking.', v_count));
  end if;

  -- The every-minute job: not run for 2 minutes.
  select last_run_at into v_last from app.job_heartbeats where organisation_id = v_org and job = 'tick';
  if v_last is null or v_last < now() - interval '2 minutes' then
    v_alerts := v_alerts || jsonb_build_object('signal', 'background_job', 'severity', 'critical',
      'message', case when v_last is null then 'The every-minute job has never run.'
                      else format('The every-minute job last ran %s minutes ago.', floor(extract(epoch from now() - v_last) / 60)) end);
  end if;

  -- Text messages: more than 5 percent failing over the last 10 minutes (at least 10 tries).
  select count(*) filter (where d.state = 'FAILED' or d.last_error is not null), count(*) into v_count, v_total
    from app.notification_deliveries d join app.outbox o on o.id = d.outbox_id
    where d.organisation_id = v_org and o.created_at > now() - interval '10 minutes' and d.attempts > 0;
  if v_total >= 10 and v_count * 100 > v_total * 5 then
    v_alerts := v_alerts || jsonb_build_object('signal', 'notifications', 'severity', 'high',
      'message', format('%s of %s text messages in the last 10 minutes failed.', v_count, v_total));
  end if;

  -- Refunds: any failed after retries.
  select count(*) into v_count from app.refunds where organisation_id = v_org and state = 'FAILED';
  if v_count > 0 then
    v_alerts := v_alerts || jsonb_build_object('signal', 'refunds', 'severity', 'high',
      'message', format('%s refund(s) could not be paid and need Finance.', v_count));
  end if;

  -- Reconciliation: the previous day not signed off by noon (Accra).
  v_day := v_local::date - 1;
  if v_local::time >= time '12:00' and not exists (
       select 1 from app.reconciliation_days where organisation_id = v_org and day = v_day and state = 'SIGNED_OFF')
     and exists (select 1 from app.payments where organisation_id = v_org
                 and received_at >= v_day::timestamp at time zone 'Africa/Accra' and received_at < (v_day + 1)::timestamp at time zone 'Africa/Accra') then
    v_alerts := v_alerts || jsonb_build_object('signal', 'reconciliation', 'severity', 'high',
      'message', format('%s has not been signed off by Finance.', to_char(v_day, 'DD Mon YYYY')));
  end if;

  return v_alerts;
end
$$;

grant execute on function app.hit_rate_limit(text, int, int), app.record_heartbeat(text, jsonb), app.operational_alerts() to app_runtime;
revoke all on function app.hit_rate_limit(text, int, int), app.record_heartbeat(text, jsonb), app.operational_alerts() from anon, authenticated;
