-- Phase F, slice 6: money (spec 18.2, 18.3a, 18.4, 18.4a, D18, D33).
-- Earned revenue when a journey ends, Paystack's transactions and settlements
-- imported and matched every day, differences listed in plain words, and the
-- day signed off by Finance.

-- ---------------------------------------------------------------------------
-- Earned revenue (18.3a "Journey completes")
-- ---------------------------------------------------------------------------

-- When a journey completes, what each booking still holds in DEFERRED_FARES is
-- earned: the booking-fee part to FEE_REVENUE, the rest to FARE_REVENUE. When a
-- journey is cancelled, everyone has been refunded in full, so only amounts kept
-- under the cancellation policy remain, and they are earned as fares.
create function app.recognise_journey_revenue(p_journey_id uuid) returns int
language plpgsql
set search_path = ''
as $$
declare
  v_booking record;
  v_journey_state text;
  v_fee bigint;
  v_count int := 0;
begin
  select state into v_journey_state from app.journeys where id = p_journey_id;
  for v_booking in
    select b.id, b.organisation_id, b.currency, -coalesce(sum(l.amount_pesewas), 0)::bigint as held
    from app.bookings b
    join app.ledger_entries l on l.booking_id = b.id and l.account = 'DEFERRED_FARES'
    where b.journey_id = p_journey_id
    group by b.id, b.organisation_id, b.currency
    having -sum(l.amount_pesewas) > 0
    order by b.id
  loop
    v_fee := 0;
    if v_journey_state = 'COMPLETED' then
      select least(v_booking.held, coalesce(sum(fee_share_pesewas), 0))::bigint into v_fee
        from app.booked_seats where booking_id = v_booking.id and state in ('BOARDED', 'NO_SHOW', 'CONFIRMED');
    end if;
    perform app.post_ledger(v_booking.organisation_id, case when v_journey_state = 'COMPLETED' then 'Journey completed: revenue earned'
                                                            else 'Journey cancelled: amount kept under the policy' end,
      jsonb_build_array(
        jsonb_build_object('account', 'DEFERRED_FARES', 'amount', v_booking.held),
        jsonb_build_object('account', 'FARE_REVENUE', 'amount', -(v_booking.held - v_fee)),
        jsonb_build_object('account', 'FEE_REVENUE', 'amount', -v_fee)),
      v_booking.currency, v_booking.id);
    v_count := v_count + 1;
  end loop;
  return v_count;
end
$$;

create function app.journeys_revenue_on_end() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.state in ('COMPLETED', 'CANCELLED') and old.state is distinct from new.state then
    perform app.recognise_journey_revenue(new.id);
  end if;
  return null;
end
$$;

create trigger journeys_revenue_on_end after update on app.journeys
  for each row execute function app.journeys_revenue_on_end();

-- ---------------------------------------------------------------------------
-- Paystack's records (18.4a), imported as received
-- ---------------------------------------------------------------------------

create table app.provider_settlements (
  id uuid primary key default app.uuid_v7(),
  organisation_id uuid not null references app.organisations (id),
  provider text not null check (provider in ('fake', 'paystack')),
  provider_settlement_id text not null,
  settled_on date not null,
  currency char(3) not null,
  -- As the provider reports them.
  gross_pesewas bigint not null check (gross_pesewas >= 0),
  fees_pesewas bigint not null check (fees_pesewas >= 0),
  refunds_pesewas bigint not null default 0 check (refunds_pesewas >= 0),
  -- What arrived in the bank.
  net_pesewas bigint not null,
  raw jsonb not null,
  imported_at timestamptz not null default now(),
  unique (organisation_id, id),
  unique (provider, provider_settlement_id)
);

create table app.provider_transactions (
  id uuid primary key default app.uuid_v7(),
  organisation_id uuid not null references app.organisations (id),
  provider text not null check (provider in ('fake', 'paystack')),
  -- Our payment attempt id, which is the reference we sent.
  reference text not null,
  status text not null check (status in ('success', 'failed', 'pending', 'reversed')),
  amount_pesewas bigint not null check (amount_pesewas >= 0),
  currency char(3) not null,
  fee_pesewas bigint not null default 0 check (fee_pesewas >= 0),
  -- Null: the provider did not say.
  channel text,
  paid_at timestamptz,
  -- Null until the provider settles it.
  settlement_id uuid,
  raw jsonb not null,
  imported_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organisation_id, id),
  unique (provider, reference),
  foreign key (organisation_id, settlement_id) references app.provider_settlements (organisation_id, id)
);

create index provider_transactions_by_day on app.provider_transactions (organisation_id, paid_at);

-- Ledger entries for a settlement point at it.
alter table app.ledger_entries add column settlement_id uuid references app.provider_settlements (id);

-- ---------------------------------------------------------------------------
-- Reconciliation days and their differences (18.4)
-- ---------------------------------------------------------------------------

create table app.reconciliation_days (
  id uuid primary key default app.uuid_v7(),
  organisation_id uuid not null references app.organisations (id),
  day date not null,
  state text not null default 'OPEN' check (state in ('OPEN', 'SIGNED_OFF')),
  -- Null until checked.
  checked_at timestamptz,
  -- Null until signed off.
  signed_off_by uuid,
  signed_off_at timestamptz,
  -- Null: no note.
  notes text check (length(notes) <= 2000),
  -- What the check found, for the record.
  summary jsonb not null default '{}',
  updated_at timestamptz not null default now(),
  unique (organisation_id, id),
  unique (organisation_id, day),
  foreign key (organisation_id, signed_off_by) references app.users (organisation_id, id),
  check ((state = 'SIGNED_OFF') = (signed_off_at is not null)),
  check ((signed_off_at is null) = (signed_off_by is null))
);

create table app.reconciliation_items (
  id uuid primary key default app.uuid_v7(),
  organisation_id uuid not null references app.organisations (id),
  day_id uuid not null,
  kind text not null check (kind in ('paid_at_provider_not_here', 'paid_here_not_at_provider', 'amount_differs',
                                     'fee_differs', 'status_differs', 'settlement_differs')),
  severity text not null check (severity in ('critical', 'high')),
  -- The same cause is one item.
  dedupe_key text not null,
  description text not null,
  -- What it concerns. Null when not about that thing.
  payment_id uuid,
  booking_id uuid,
  provider_reference text,
  settlement_id uuid,
  difference_pesewas bigint,
  -- Required to resolve (18.4 step 4).
  resolution text check (length(trim(resolution)) >= 5),
  -- Null: resolved by the system when the difference went away.
  resolved_by uuid,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  unique (organisation_id, id),
  unique (organisation_id, dedupe_key),
  foreign key (organisation_id, day_id) references app.reconciliation_days (organisation_id, id),
  foreign key (organisation_id, payment_id) references app.payments (organisation_id, id),
  foreign key (organisation_id, booking_id) references app.bookings (organisation_id, id),
  foreign key (organisation_id, settlement_id) references app.provider_settlements (organisation_id, id),
  foreign key (organisation_id, resolved_by) references app.users (organisation_id, id),
  check ((resolved_at is null) = (resolution is null)),
  check (resolved_at is not null or resolved_by is null)
);

create index reconciliation_items_open on app.reconciliation_items (organisation_id, day_id) where resolved_at is null;

create function app.reconciliation_days_before_update() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.state = 'SIGNED_OFF' then
    perform app.fail('This day is signed off. Correct anything with a new entry on a later day.');
  end if;
  if new.day <> old.day then
    perform app.fail('A reconciliation day cannot change its date.');
  end if;
  return new;
end
$$;

create trigger reconciliation_days_before_update before update on app.reconciliation_days
  for each row execute function app.reconciliation_days_before_update();

create function app.reconciliation_items_before_update() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.resolved_at is not null then
    perform app.fail('This difference is already resolved.');
  end if;
  if (new.day_id, new.kind, new.dedupe_key, new.payment_id, new.provider_reference, new.settlement_id)
     is distinct from (old.day_id, old.kind, old.dedupe_key, old.payment_id, old.provider_reference, old.settlement_id) then
    perform app.fail('What a difference is about cannot change.');
  end if;
  if exists (select 1 from app.reconciliation_days where id = old.day_id and state = 'SIGNED_OFF') then
    perform app.fail('This day is signed off.');
  end if;
  return new;
end
$$;

create trigger reconciliation_items_before_update before update on app.reconciliation_items
  for each row execute function app.reconciliation_items_before_update();

-- ---------------------------------------------------------------------------
-- Settlements in the ledger (18.3a "Settlement received from provider")
-- ---------------------------------------------------------------------------

create function app.post_settlement(p_settlement_id uuid) returns void
language plpgsql
set search_path = ''
as $$
declare
  v_settlement record;
  v_posting uuid;
begin
  select * into v_settlement from app.provider_settlements where id = p_settlement_id;
  if exists (select 1 from app.ledger_entries where settlement_id = p_settlement_id) or v_settlement.net_pesewas = 0 then
    return;
  end if;
  v_posting := app.post_ledger(v_settlement.organisation_id, 'Settlement received from ' || v_settlement.provider,
    jsonb_build_array(jsonb_build_object('account', 'BANK', 'amount', v_settlement.net_pesewas),
                      jsonb_build_object('account', 'PROVIDER_CLEARING', 'amount', -v_settlement.net_pesewas)),
    v_settlement.currency);
  -- The posting's lines carry the settlement (set once, at creation, by this function only).
  perform set_config('app.ledger_link', v_posting::text, true);
  update app.ledger_entries set settlement_id = p_settlement_id where posting_id = v_posting;
  perform set_config('app.ledger_link', '', true);
end
$$;

-- The ledger stays append-only; the only change ever allowed is linking a
-- settlement posting to its settlement in the same transaction that wrote it.
create or replace function app.ledger_entries_link_only() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if app.request_setting('ledger_link') is not distinct from old.posting_id::text
     and old.settlement_id is null
     and (to_jsonb(new) - 'settlement_id') = (to_jsonb(old) - 'settlement_id') then
    return new;
  end if;
  perform app.fail('The ledger is append-only. Post a correcting entry instead.');
end
$$;

drop trigger ledger_entries_immutable on app.ledger_entries;
create trigger ledger_entries_immutable before update on app.ledger_entries
  for each row execute function app.ledger_entries_link_only();
create trigger ledger_entries_no_delete before delete on app.ledger_entries
  for each row execute function app.refuse_change();

-- ---------------------------------------------------------------------------
-- The daily check (18.4 steps 2 and 3, 18.4a steps 1 to 5)
-- ---------------------------------------------------------------------------

-- Matches the provider's records for one day (Africa/Accra) with ours and
-- lists every difference. Safe to run again: the same difference is one item,
-- and a difference that has gone away resolves itself. Returns open items.
create function app.check_reconciliation_day(p_day date) returns int
language plpgsql
set search_path = ''
as $$
declare
  v_org uuid := app.current_organisation_id();
  v_tz text;
  v_day record;
  v_row record;
  v_from timestamptz;
  v_to timestamptz;
  v_seen text[] := '{}';
  v_key text;
  v_open int;
begin
  select timezone into v_tz from app.organisations where id = v_org;
  v_from := p_day::timestamp at time zone v_tz;
  v_to := (p_day + 1)::timestamp at time zone v_tz;

  insert into app.reconciliation_days (organisation_id, day) values (v_org, p_day) on conflict (organisation_id, day) do nothing;
  select * into v_day from app.reconciliation_days where organisation_id = v_org and day = p_day;
  if v_day.state = 'SIGNED_OFF' then
    perform app.fail('This day is already signed off.');
  end if;

  -- 1. Each provider transaction of the day against our attempt and payment.
  for v_row in
    select t.*, a.id as attempt_id, a.state as attempt_state, p.id as payment_id, p.amount_pesewas as paid,
           p.currency as paid_currency, p.provider_fee_pesewas as our_fee, p.state as payment_state, a.booking_id
    from app.provider_transactions t
    left join app.payment_attempts a on a.id::text = t.reference
    left join app.payments p on p.attempt_id = a.id
    where t.organisation_id = v_org and t.paid_at >= v_from and t.paid_at < v_to
    order by t.reference
  loop
    if v_row.status = 'success' and v_row.payment_id is null then
      v_key := 'paid_at_provider_not_here:' || v_row.reference;
      perform app.reconciliation_item(v_day.id, 'paid_at_provider_not_here', 'critical', v_key,
        format('Paid at Paystack but no booking here: %s for reference %s. A callback was probably missed; check the payment and confirm or refund it.',
               app.format_cedis(v_row.amount_pesewas), v_row.reference),
        null, v_row.booking_id, v_row.reference, null, v_row.amount_pesewas);
      v_seen := v_seen || v_key;
    elsif v_row.payment_id is not null then
      if v_row.status <> 'success' and v_row.payment_state = 'RECEIVED' then
        v_key := 'status_differs:' || v_row.reference;
        perform app.reconciliation_item(v_day.id, 'status_differs', 'critical', v_key,
          format('Paystack shows payment %s as %s, but it is recorded here as paid.', v_row.reference, v_row.status),
          v_row.payment_id, v_row.booking_id, v_row.reference, null, v_row.paid);
        v_seen := v_seen || v_key;
      end if;
      if v_row.amount_pesewas <> v_row.paid or v_row.currency <> v_row.paid_currency then
        v_key := 'amount_differs:' || v_row.reference;
        perform app.reconciliation_item(v_day.id, 'amount_differs', 'critical', v_key,
          format('Payment %s: Paystack has %s %s, recorded here as %s %s.', v_row.reference,
                 v_row.currency, app.format_cedis(v_row.amount_pesewas), v_row.paid_currency, app.format_cedis(v_row.paid)),
          v_row.payment_id, v_row.booking_id, v_row.reference, null, v_row.amount_pesewas - v_row.paid);
        v_seen := v_seen || v_key;
      end if;
      if v_row.fee_pesewas <> v_row.our_fee then
        v_key := 'fee_differs:' || v_row.reference;
        perform app.reconciliation_item(v_day.id, 'fee_differs', 'high', v_key,
          format('Payment %s: Paystack charged a fee of %s, recorded here as %s.', v_row.reference,
                 app.format_cedis(v_row.fee_pesewas), app.format_cedis(v_row.our_fee)),
          v_row.payment_id, v_row.booking_id, v_row.reference, null, v_row.fee_pesewas - v_row.our_fee);
        v_seen := v_seen || v_key;
      end if;
    end if;
  end loop;

  -- 2. Our payments of the day with no successful provider transaction.
  for v_row in
    select p.id, p.booking_id, p.amount_pesewas, a.id as attempt_id
    from app.payments p join app.payment_attempts a on a.id = p.attempt_id
    where p.organisation_id = v_org and p.received_at >= v_from and p.received_at < v_to
      and not exists (select 1 from app.provider_transactions t where t.provider = a.provider and t.reference = a.id::text and t.status in ('success', 'reversed'))
    order by p.id
  loop
    v_key := 'paid_here_not_at_provider:' || v_row.attempt_id::text;
    perform app.reconciliation_item(v_day.id, 'paid_here_not_at_provider', 'critical', v_key,
      format('Recorded here as paid (%s, reference %s) but Paystack has no successful payment for it.',
             app.format_cedis(v_row.amount_pesewas), v_row.attempt_id),
      v_row.id, v_row.booking_id, v_row.attempt_id::text, null, v_row.amount_pesewas);
    v_seen := v_seen || v_key;
  end loop;

  -- 3. Settlements paid that day: the bank amount must equal payments less fees less refunds.
  for v_row in
    select s.*, coalesce((select sum(t.amount_pesewas - t.fee_pesewas) from app.provider_transactions t
                           where t.settlement_id = s.id and t.status = 'success'), 0)::bigint as expected_before_refunds
    from app.provider_settlements s
    where s.organisation_id = v_org and s.settled_on = p_day
  loop
    if v_row.net_pesewas <> v_row.expected_before_refunds - v_row.refunds_pesewas then
      v_key := 'settlement_differs:' || v_row.provider_settlement_id;
      perform app.reconciliation_item(v_day.id, 'settlement_differs', 'high', v_key,
        format('Settlement %s paid %s to the bank, but its payments less fees and refunds come to %s.',
               v_row.provider_settlement_id, app.format_cedis(v_row.net_pesewas),
               app.format_cedis(v_row.expected_before_refunds - v_row.refunds_pesewas)),
        null, null, null, v_row.id, v_row.net_pesewas - (v_row.expected_before_refunds - v_row.refunds_pesewas));
      v_seen := v_seen || v_key;
    end if;
  end loop;

  -- Differences found before that are no longer there resolve themselves (a late import, a fixed payment).
  update app.reconciliation_items
    set resolution = 'Resolved automatically: the difference is no longer there when checked again.', resolved_at = now(),
        resolved_by = app.current_actor_id()
    where day_id = v_day.id and resolved_at is null and dedupe_key <> all(v_seen);

  select count(*) into v_open from app.reconciliation_items where day_id = v_day.id and resolved_at is null;
  update app.reconciliation_days set checked_at = now(),
    summary = jsonb_build_object(
      'providerTransactions', (select count(*) from app.provider_transactions where organisation_id = v_org and paid_at >= v_from and paid_at < v_to),
      'payments', (select count(*) from app.payments where organisation_id = v_org and received_at >= v_from and received_at < v_to),
      'paidPesewas', (select coalesce(sum(amount_pesewas), 0) from app.payments where organisation_id = v_org and received_at >= v_from and received_at < v_to),
      'settlements', (select count(*) from app.provider_settlements where organisation_id = v_org and settled_on = p_day),
      'settledPesewas', (select coalesce(sum(net_pesewas), 0) from app.provider_settlements where organisation_id = v_org and settled_on = p_day),
      'openDifferences', v_open)
    where id = v_day.id;

  if v_open > 0 then
    perform app.raise_exception(v_org, 'reconciliation_mismatch', 'high', 'reconciliation:' || p_day::text,
      format('Reconciliation for %s has %s difference(s) with Paystack.', to_char(p_day, 'DD Mon YYYY'), v_open),
      'Resolve each listed difference.');
  else
    perform app.resolve_exception_automatically('reconciliation:' || p_day::text, 'Closed automatically: the day balances.');
  end if;
  return v_open;
end
$$;

-- Records one difference, once (the same cause never makes two).
create function app.reconciliation_item(p_day_id uuid, p_kind text, p_severity text, p_key text, p_description text,
  p_payment_id uuid, p_booking_id uuid, p_reference text, p_settlement_id uuid, p_difference bigint) returns void
language sql
set search_path = ''
as $$
  insert into app.reconciliation_items (organisation_id, day_id, kind, severity, dedupe_key, description, payment_id, booking_id,
                                        provider_reference, settlement_id, difference_pesewas)
  values (app.current_organisation_id(), p_day_id, p_kind, p_severity, p_key, p_description, p_payment_id, p_booking_id,
          p_reference, p_settlement_id, p_difference)
  on conflict (organisation_id, dedupe_key) do nothing
$$;

create function app.resolve_reconciliation_item(p_item_id uuid, p_resolution text) returns void
language plpgsql
set search_path = ''
as $$
declare
  v_rows int;
begin
  if length(trim(coalesce(p_resolution, ''))) < 5 then
    perform app.fail('Say how this difference was resolved (at least 5 characters).');
  end if;
  update app.reconciliation_items set resolution = trim(p_resolution), resolved_at = now(), resolved_by = app.current_actor_id()
    where id = p_item_id and resolved_at is null;
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    perform app.fail('This difference is already resolved.');
  end if;
end
$$;

-- Finance signs the day off once it balances (18.4 step 5).
create function app.sign_off_day(p_day date, p_notes text) returns void
language plpgsql
set search_path = ''
as $$
declare
  v_day record;
begin
  select * into v_day from app.reconciliation_days where organisation_id = app.current_organisation_id() and day = p_day for update;
  if not found or v_day.checked_at is null then
    perform app.fail('Check the day against Paystack before signing it off.');
  end if;
  if v_day.state = 'SIGNED_OFF' then
    perform app.fail('This day is already signed off.');
  end if;
  if exists (select 1 from app.reconciliation_items where day_id = v_day.id and resolved_at is null) then
    perform app.fail('Resolve every difference before signing the day off.');
  end if;
  if p_day >= (now() at time zone (select timezone from app.organisations where id = app.current_organisation_id()))::date then
    perform app.fail('A day can be signed off only once it has ended.');
  end if;
  update app.reconciliation_days set state = 'SIGNED_OFF', signed_off_by = app.current_actor_id(), signed_off_at = now(),
         notes = nullif(trim(coalesce(p_notes, '')), '')
    where id = v_day.id;
end
$$;

-- ---------------------------------------------------------------------------
-- Security, audit, grants
-- ---------------------------------------------------------------------------

do $$
declare
  v_table text;
begin
  foreach v_table in array array['provider_settlements', 'provider_transactions', 'reconciliation_days', 'reconciliation_items'] loop
    execute format('alter table app.%I enable row level security', v_table);
    execute format('create policy org_boundary on app.%I to app_runtime using (organisation_id = app.current_organisation_id()) with check (organisation_id = app.current_organisation_id())', v_table);
    execute format('grant select, insert on app.%I to app_runtime', v_table);
    execute format('create trigger %1$s_no_delete before delete on app.%1$I for each row execute function app.refuse_delete()', v_table);
    execute format('revoke all on app.%I from anon, authenticated', v_table);
  end loop;
  foreach v_table in array array['provider_transactions', 'reconciliation_days'] loop
    execute format('create trigger %1$s_updated_at before update on app.%1$I for each row execute function app.set_updated_at()', v_table);
  end loop;
  foreach v_table in array array['reconciliation_days', 'reconciliation_items', 'provider_settlements'] loop
    execute format('create trigger %1$s_audit after insert or update on app.%1$I for each row execute function app.audit_row_change()', v_table);
  end loop;
end
$$;

grant update on app.provider_transactions, app.provider_settlements, app.reconciliation_days, app.reconciliation_items to app_runtime;
-- Linking a settlement posting is the one ledger update the runtime may make (see app.ledger_entries_link_only).
grant update (settlement_id) on app.ledger_entries to app_runtime;

grant execute on function
  app.recognise_journey_revenue(uuid), app.journeys_revenue_on_end(), app.reconciliation_days_before_update(),
  app.reconciliation_items_before_update(), app.post_settlement(uuid), app.ledger_entries_link_only(),
  app.check_reconciliation_day(date),
  app.reconciliation_item(uuid, text, text, text, text, uuid, uuid, text, uuid, bigint),
  app.resolve_reconciliation_item(uuid, text), app.sign_off_day(date, text)
to app_runtime;

revoke all on function
  app.recognise_journey_revenue(uuid), app.journeys_revenue_on_end(), app.reconciliation_days_before_update(),
  app.reconciliation_items_before_update(), app.post_settlement(uuid), app.ledger_entries_link_only(),
  app.check_reconciliation_day(date),
  app.reconciliation_item(uuid, text, text, text, text, uuid, uuid, text, uuid, bigint),
  app.resolve_reconciliation_item(uuid, text), app.sign_off_day(date, text)
from anon, authenticated;
