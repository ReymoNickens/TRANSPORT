import "server-only";
import { z } from "zod";
import { AppError } from "@/lib/api/errors";
import { log } from "@/lib/api/log";
import { withOrganisation, type RequestContext, type Sql } from "@/lib/db";
import { env } from "@/lib/env";
import type { PaymentProvider } from "@/providers/payments";
import { PaymentProviderError } from "@/providers/payments/types";
import { issueCredentials } from "./credentials";
import { checkProcessingRefunds } from "./refunds";

export const startPaymentInput = z.object({ method: z.enum(["mobile_money", "card", "any"]).default("any") });

type Ctx = Pick<RequestContext, "organisationId" | "correlationId" | "actorUserId">;

/**
 * Starts a payment (12.6). The attempt is written before the provider is
 * called (13.3 rule 1); the provider's answer is recorded in a second
 * transaction. A provider failure keeps the seats held.
 */
export async function startPayment(
  ctx: Ctx,
  provider: PaymentProvider,
  bookingId: string,
  input: z.infer<typeof startPaymentInput>,
  sql?: Sql,
) {
  const attempt = await withOrganisation(ctx, async (tx) => {
    const [booking] = await tx<{ id: string; reference: string; state: string; expiresAt: Date | null; totalPesewas: number; currency: string; purchaserEmail: string | null; purchaserPhone: string }[]>`
      select id, reference, state, expires_at, total_pesewas, currency, purchaser_email, purchaser_phone
      from app.bookings where id = ${bookingId} for update`;
    if (!booking || !["PENDING", "PAYMENT_PENDING"].includes(booking.state) || !booking.expiresAt || booking.expiresAt <= new Date()) {
      throw new AppError("rule_violation", { message: "This booking can no longer be paid. Its seats are no longer held." });
    }
    const [domain] = await tx<{ value: string }[]>`
      select value #>> '{}' as value from app.settings where organisation_id = ${ctx.organisationId} and key = 'paystack.placeholder_email_domain'`;
    const [row] = await tx<{ id: string }[]>`
      insert into app.payment_attempts (organisation_id, booking_id, provider, method, amount_pesewas, currency)
      values (${ctx.organisationId}, ${booking.id}, ${provider.name}, ${input.method}, ${booking.totalPesewas}, ${booking.currency})
      returning id`;
    return {
      id: row.id,
      booking,
      // D30: a non-receiving address when the passenger gave no email.
      email: booking.purchaserEmail ?? `${booking.reference.toLowerCase()}@${domain?.value ?? "payments.invalid"}`,
    };
  }, sql);

  try {
    const started = await provider.startPayment({
      attemptId: attempt.id,
      amountPesewas: attempt.booking.totalPesewas,
      currency: attempt.booking.currency,
      email: attempt.email,
      phone: attempt.booking.purchaserPhone,
      bookingReference: attempt.booking.reference,
      method: input.method,
      returnUrl: `${env().APP_BASE_URL}/booking/${attempt.booking.reference}`,
    });
    const expiresAt = await withOrganisation(ctx, async (tx) => {
      const [row] = await tx<{ expiresAt: Date | null }[]>`
        select app.begin_payment_attempt(${attempt.id}, ${started.providerReference}, ${started.checkoutUrl}) as expires_at`;
      return row.expiresAt;
    }, sql);
    return { checkoutUrl: started.checkoutUrl, expiresAt };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "The payment could not be started";
    await withOrganisation(ctx, (tx) => tx`select app.fail_payment_attempt(${attempt.id}, ${reason})`, sql);
    if (error instanceof PaymentProviderError || error instanceof AppError) {
      log("warn", "payment.start_failed", { correlationId: ctx.correlationId, attemptId: attempt.id, reason });
      throw new AppError("payment_unavailable", { cause: error });
    }
    throw error;
  }
}

/**
 * Applies a provider's verified result in one transaction: payment, seats,
 * tickets, credentials, ledger and messages together (12.1 rule 5).
 */
export async function applyPaymentResult(
  ctx: Ctx,
  attemptId: string,
  check: { status: string; amountPesewas: number | null; currency: string | null; providerFeePesewas: number; providerReference: string | null },
  sql?: Sql,
): Promise<string> {
  return withOrganisation(ctx, async (tx) => {
    const [row] = await tx<{ outcome: string }[]>`
      select app.apply_payment_result(${attemptId}, ${check.status}, ${check.amountPesewas}, ${check.currency},
                                      ${check.providerFeePesewas}, ${check.providerReference}) as outcome`;
    const secret = env().TICKET_TOKEN_SECRET;
    if (!secret) throw new Error("TICKET_TOKEN_SECRET is not set, so tickets cannot be issued");
    const [attempt] = await tx<{ bookingId: string }[]>`select booking_id from app.payment_attempts where id = ${attemptId}`;
    if (attempt) await issueCredentials(tx, secret, attempt.bookingId);
    return row.outcome;
  }, sql);
}

/**
 * The webhook inbox (20.8): verify, store exactly as received, then process.
 * A charge result is confirmed with the provider's own verify call before
 * any amount is trusted (D34). Returns the stored event's outcome.
 */
export async function receiveCallback(ctx: Ctx, provider: PaymentProvider, rawBody: string, headers: Headers, sql?: Sql) {
  const verified = provider.verifyCallback(rawBody, headers);
  if (!verified) {
    log("warn", "payment.callback_rejected", { correlationId: ctx.correlationId, provider: provider.name });
    return { stored: false, outcome: "rejected" as const };
  }

  const event = await withOrganisation(ctx, async (tx) => {
    const inserted = await tx<{ id: string }[]>`
      insert into app.webhook_events (organisation_id, provider, provider_event_id, raw_body, signature_ok)
      values (${ctx.organisationId}, ${provider.name}, ${verified.eventId}, ${rawBody}, true)
      on conflict (provider, provider_event_id) do nothing
      returning id`;
    if (inserted.length) return { id: inserted[0].id, fresh: true };
    const [existing] = await tx<{ id: string; processedAt: Date | null }[]>`
      select id, processed_at from app.webhook_events where provider = ${provider.name} and provider_event_id = ${verified.eventId}`;
    return { id: existing.id, fresh: existing.processedAt === null };
  }, sql);

  // A repeated delivery of something already processed changes nothing.
  if (!event.fresh) return { stored: true, outcome: "duplicate" as const };
  const outcome = await processCallback(ctx, provider, event.id, verified.kind, verified.reference, sql);
  return { stored: true, outcome };
}

async function processCallback(
  ctx: Ctx,
  provider: PaymentProvider,
  eventId: string,
  kind: string,
  reference: string | null,
  sql?: Sql,
): Promise<"applied" | "ignored" | "error"> {
  try {
    let result: "applied" | "ignored" = "ignored";
    if (kind === "charge" && reference && /^[0-9a-f-]{36}$/i.test(reference)) {
      const known = await withOrganisation(ctx, (tx) => tx`select 1 from app.payment_attempts where id = ${reference}`, sql);
      if (known.length) {
        // Never trust the callback's amount: ask the provider (D34).
        const check = await provider.checkPayment(reference);
        const fromCallback = check.status === "pending" ? statusFromStoredEvent : null;
        await applyPaymentResult(ctx, reference, fromCallback ? await fromCallback(ctx, eventId, sql) : check, sql);
        result = "applied";
      } else {
        log("warn", "payment.callback_unknown_reference", { correlationId: ctx.correlationId, provider: provider.name });
      }
    } else if (kind === "refund") {
      // Never trust the event's status: ask the provider about refunds still being paid (16.4).
      await checkProcessingRefunds(ctx, provider, { force: true }, sql);
      result = "applied";
    }
    await markEvent(ctx, eventId, result, null, sql);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log("error", "payment.callback_failed", { correlationId: ctx.correlationId, eventId, cause: message });
    await markEvent(ctx, eventId, "error", message, sql).catch(() => {});
    return "error";
  }
}

/**
 * The fake provider has no status service, so its signed callback is the
 * only source; Paystack is always confirmed by the verify call instead.
 */
async function statusFromStoredEvent(ctx: Ctx, eventId: string, sql?: Sql) {
  const [row] = await withOrganisation(ctx, (tx) => tx<{ provider: string; rawBody: string }[]>`
    select provider, raw_body from app.webhook_events where id = ${eventId}`, sql);
  if (row.provider !== "fake") return { status: "pending", amountPesewas: null, currency: null, providerFeePesewas: 0, providerReference: null };
  const body = JSON.parse(row.rawBody) as { data: { status: string; amount: number; currency: string; fees: number; reference: string } };
  return {
    status: body.data.status === "success" ? "success" : body.data.status === "failed" ? "failed" : "pending",
    amountPesewas: body.data.amount,
    currency: body.data.currency,
    providerFeePesewas: body.data.fees ?? 0,
    providerReference: body.data.reference,
  };
}

async function markEvent(ctx: Ctx, eventId: string, outcome: string, error: string | null, sql?: Sql) {
  await withOrganisation(ctx, (tx) => tx`
    update app.webhook_events
    set processed_at = case when ${outcome} = 'error' then null else now() end,
        outcome = ${outcome}, attempts = attempts + 1, last_error = ${error ? error.slice(0, 500) : null}
    where id = ${eventId}`, sql);
}

/**
 * When a callback is late (12.2): ask the provider about pending attempts
 * that have waited a minute, at most once a minute each. A failed check is
 * retried later, never treated as a failed payment.
 */
export async function checkPendingAttempts(ctx: Ctx, provider: PaymentProvider, options: { bookingId?: string; limit?: number } = {}, sql?: Sql) {
  const due = await withOrganisation(ctx, (tx) => tx<{ id: string }[]>`
    update app.payment_attempts set last_checked_at = now()
    where id in (
      select id from app.payment_attempts
      where state = 'PENDING' and provider = ${provider.name}
        and started_at < now() - interval '60 seconds'
        and (last_checked_at is null or last_checked_at < now() - interval '60 seconds')
        and (${options.bookingId ?? null}::uuid is null or booking_id = ${options.bookingId ?? null}::uuid)
      order by started_at limit ${options.limit ?? 20}
      for update skip locked)
    returning id`, sql);
  let applied = 0;
  for (const { id } of due) {
    try {
      const check = await provider.checkPayment(id);
      if (check.status !== "pending") {
        await applyPaymentResult(ctx, id, check, sql);
        applied++;
      }
    } catch (error) {
      log("warn", "payment.check_failed", { correlationId: ctx.correlationId, attemptId: id, cause: error instanceof Error ? error.message : String(error) });
    }
  }
  return { checked: due.length, applied };
}

/** Retries stored callbacks whose processing failed (the inbox never loses one). */
export async function retryStoredCallbacks(ctx: Ctx, provider: PaymentProvider, sql?: Sql) {
  const events = await withOrganisation(ctx, (tx) => tx<{ id: string; rawBody: string }[]>`
    select id, raw_body from app.webhook_events
    where processed_at is null and provider = ${provider.name} and attempts < 10
    order by received_at limit 20`, sql);
  for (const event of events) {
    const parsed = JSON.parse(event.rawBody) as { event?: string; data?: { reference?: string } };
    const kind = parsed.event?.startsWith("charge.") ? "charge" : "other";
    await processCallback(ctx, provider, event.id, kind, parsed.data?.reference ?? null, sql);
  }
  return events.length;
}
