-- Phase D: booking core, part 3 of 3: timestamps, never-delete rules, the
-- immutable ledger, audit, row-level security and grants for the new tables.

do $$
declare
  v_table text;
begin
  foreach v_table in array array['bookings', 'booked_seats', 'tickets', 'exceptions'] loop
    execute format('create trigger %1$s_updated_at before update on app.%1$I for each row execute function app.set_updated_at()', v_table);
  end loop;

  -- Money, tickets, boarding, callbacks and messages are never deleted (10.9).
  foreach v_table in array array['concession_verifications', 'bookings', 'booking_passengers', 'booked_seats', 'seat_claims',
                                 'tickets', 'ticket_credentials', 'payment_attempts', 'payments', 'refunds', 'webhook_events',
                                 'idempotency_keys', 'outbox', 'notification_deliveries', 'exceptions'] loop
    execute format('create trigger %1$s_no_delete before delete on app.%1$I for each row execute function app.refuse_delete()', v_table);
  end loop;

  -- Audited: privileged changes, payment state changes, ticket issue, refunds (19.8).
  foreach v_table in array array['payments', 'refunds', 'tickets', 'exceptions'] loop
    execute format('create trigger %1$s_audit after insert or update on app.%1$I for each row execute function app.audit_row_change()', v_table);
  end loop;

  foreach v_table in array array['concession_verifications', 'bookings', 'booking_passengers', 'booked_seats', 'seat_claims',
                                 'tickets', 'ticket_credentials', 'payment_attempts', 'payments', 'refunds', 'webhook_events',
                                 'idempotency_keys', 'outbox', 'notification_deliveries', 'ledger_entries', 'exceptions'] loop
    execute format('alter table app.%I enable row level security', v_table);
    execute format(
      'create policy org_boundary on app.%I to app_runtime using (organisation_id = app.current_organisation_id()) with check (organisation_id = app.current_organisation_id())',
      v_table);
    execute format('grant select, insert on app.%I to app_runtime', v_table);
  end loop;
end
$$;

-- Bookings carry personal data: mask it in audit values (19.4).
create trigger bookings_audit after insert or update on app.bookings
  for each row execute function app.audit_row_change('purchaser_name', 'purchaser_phone', 'purchaser_email', 'access_token_hash');

-- The ledger is append-only for every role, including the owner (10.9).
create trigger ledger_entries_immutable before update or delete on app.ledger_entries
  for each row execute function app.refuse_change();
create trigger ledger_entries_no_truncate before truncate on app.ledger_entries
  for each statement execute function app.refuse_change();

grant update on app.concession_verifications, app.bookings, app.booked_seats, app.seat_claims, app.tickets,
  app.ticket_credentials, app.payment_attempts, app.payments, app.refunds, app.webhook_events, app.idempotency_keys,
  app.outbox, app.notification_deliveries, app.exceptions to app_runtime;

grant execute on function
  app.random_code(int, text), app.is_late_payment_for(uuid), app.next_academic_year_end(uuid), app.bookings_before_update(), app.booked_seats_before_write(),
  app.seat_claims_before_write(), app.tickets_before_update(), app.ticket_credentials_before_update(),
  app.payment_attempts_before_update(), app.payments_before_update(), app.refund_counts(text), app.refunds_before_write(),
  app.webhook_events_before_update(), app.idempotency_keys_before_update(), app.ledger_posting_balances(),
  app.enqueue_message(uuid, text, jsonb, text), app.raise_exception(uuid, text, text, text, text, text, uuid, uuid, uuid, uuid),
  app.post_ledger(uuid, text, jsonb, text, uuid, uuid, uuid), app.create_system_refund(uuid, text, bigint, text, uuid),
  app.expire_booking(uuid), app.release_expired_claims(uuid[]), app.expire_holds(),
  app.hold_seats(uuid, uuid, uuid, jsonb, jsonb), app.begin_payment_attempt(uuid, text, text),
  app.fail_payment_attempt(uuid, text), app.issue_tickets(uuid), app.confirm_booking(uuid, text),
  app.place_late_booking(uuid), app.apply_payment_result(uuid, text, bigint, text, bigint, text)
to app_runtime;

revoke all on all tables in schema app from anon, authenticated;
revoke all on all functions in schema app from anon, authenticated;

-- Holds are released every minute (11.4). Correctness never depends on it:
-- every availability check treats an expired hold as free.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('expire-holds', '* * * * *', 'select app.expire_holds()');
  end if;
end
$$;
