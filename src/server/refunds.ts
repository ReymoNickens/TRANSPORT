import { z } from "zod";
import { log } from "@/lib/api/log";
import { withOrganisation, type RequestContext, type Sql, type Tx } from "@/lib/db";
import { PaymentProviderError, type PaymentProvider } from "@/providers/payments/types";
import { pesewas } from "./common";

type Ctx = Pick<RequestContext, "organisationId" | "correlationId">;

/**
 * Refunds (spec 16.3, 16.4, 16.4a). The database decides amounts, approvals
 * and states; this file talks to the payment provider and records what it said.
 * Release 1 uses the Paystack refund route; a payment Paystack cannot refund
 * goes to Finance to pay by hand (the transfer route is not built yet).
 */

const ROUTE = "paystack_refund";

/** Sends approved refunds that are due to the provider, one transaction per refund. */
export async function processDueRefunds(ctx: Ctx, provider: PaymentProvider, options: { limit?: number } = {}, sql?: Sql) {
  // Claim due refunds by pushing their next attempt out, so two workers never send the same one.
  const due = await withOrganisation(ctx, (tx) => tx<{ id: string; reference: string; amountPesewas: number }[]>`
    update app.refunds r set next_attempt_at = now() + interval '10 minutes'
    from app.payments p join app.payment_attempts a on a.id = p.attempt_id
    where r.id in (
        select id from app.refunds where state = 'APPROVED' and next_attempt_at <= now()
        order by next_attempt_at limit ${options.limit ?? 20} for update skip locked)
      and p.id = r.payment_id and a.provider = ${provider.name}
    returning r.id, a.id as reference, r.amount_pesewas`, sql);

  const outcomes: Record<string, number> = {};
  for (const refund of due) {
    let outcome: "processed" | "pending" | "retry" | "refused";
    let providerReference: string | null = null;
    let error: string | null = null;
    try {
      const result = await provider.refund(refund.reference, refund.amountPesewas);
      providerReference = result.providerReference;
      outcome = result.status === "failed" ? "refused" : result.status;
      if (outcome === "refused") error = "The provider reported the refund as failed";
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      outcome = e instanceof PaymentProviderError && !e.retryable ? "refused" : "retry";
    }
    const [row] = await withOrganisation(ctx, (tx) => tx<{ result: string }[]>`
      select app.record_refund_attempt(${refund.id}, ${ROUTE}, ${outcome}, ${providerReference}, ${error}) as result`, sql);
    outcomes[row.result] = (outcomes[row.result] ?? 0) + 1;
    if (row.result === "failed") log("warn", "refund.failed", { correlationId: ctx.correlationId, refundId: refund.id, cause: error });
  }
  return { refundsSent: due.length, ...prefix(outcomes) };
}

/** Asks the provider about refunds it accepted but has not finished (a refund event may be late or lost). */
export async function checkProcessingRefunds(ctx: Ctx, provider: PaymentProvider, options: { limit?: number; force?: boolean } = {}, sql?: Sql) {
  const processing = await withOrganisation(ctx, (tx) => tx<{ id: string; providerReference: string }[]>`
    update app.refunds r set next_attempt_at = now() + interval '15 minutes'
    from app.payments p join app.payment_attempts a on a.id = p.attempt_id
    where r.id in (
        select id from app.refunds
        where state = 'PROCESSING' and route = ${ROUTE} and provider_reference is not null
          and (${options.force ?? false} or next_attempt_at <= now())
        order by next_attempt_at limit ${options.limit ?? 20} for update skip locked)
      and p.id = r.payment_id and a.provider = ${provider.name}
    returning r.id, r.provider_reference`, sql);

  let completed = 0;
  for (const refund of processing) {
    try {
      const result = await provider.checkRefund(refund.providerReference);
      if (result.status === "pending") continue;
      const [row] = await withOrganisation(ctx, (tx) => tx<{ result: string }[]>`
        select app.record_refund_attempt(${refund.id}, ${ROUTE}, ${result.status === "processed" ? "processed" : "refused"},
                                         ${refund.providerReference}, ${result.status === "failed" ? "The provider reported the refund as failed" : null}) as result`, sql);
      if (row.result === "completed") completed++;
    } catch (e) {
      log("warn", "refund.check_failed", { correlationId: ctx.correlationId, refundId: refund.id, cause: e instanceof Error ? e.message : String(e) });
    }
  }
  return { refundsChecked: processing.length, refundsCompleted: completed };
}

function prefix(outcomes: Record<string, number>) {
  return Object.fromEntries(Object.entries(outcomes).map(([k, v]) => [`refunds_${k}`, v]));
}

// ---------------------------------------------------------------------------
// Finance's refund queue
// ---------------------------------------------------------------------------

export const refundsQuery = z.object({ state: z.enum(["REQUESTED", "APPROVED", "PROCESSING", "COMPLETED", "FAILED", "REJECTED", "open"]).default("open") });
export const requestRefundInput = z.object({ amountPesewas: pesewas, reason: z.string().trim().min(5).max(500), kind: z.enum(["goodwill", "correction"]).default("goodwill") });
export const reasonOnly = z.object({ reason: z.string().trim().min(5).max(500) });
export const manualRefundInput = z.object({ paymentReference: z.string().trim().min(3).max(120), reason: z.string().trim().min(5).max(500) });

export type RefundRow = {
  id: string;
  bookingReference: string;
  journeyLabel: string;
  purchaserName: string;
  phoneLastDigits: string;
  kind: string;
  amountPesewas: number;
  currency: string;
  reason: string;
  state: string;
  route: string | null;
  attempts: number;
  lastError: string | null;
  requestedByName: string | null;
  approvedByName: string | null;
  manualRecordedById: string | null;
  manualRecordedByName: string | null;
  providerReference: string | null;
  requestedAt: Date;
  processedAt: Date | null;
};

export async function listRefunds(tx: Tx, query: z.infer<typeof refundsQuery>, bookingId?: string): Promise<RefundRow[]> {
  const open = query.state === "open";
  return tx<RefundRow[]>`
    select r.id, b.reference as booking_reference, app.journey_label(b.journey_id) as journey_label, b.purchaser_name,
           right(b.purchaser_phone, 3) as phone_last_digits, r.kind, r.amount_pesewas, r.currency, r.reason, r.state, r.route,
           r.attempts, r.last_error, rq.full_name as requested_by_name, ap.full_name as approved_by_name,
           r.manual_recorded_by as manual_recorded_by_id, mr.full_name as manual_recorded_by_name, r.provider_reference,
           r.requested_at, r.processed_at
    from app.refunds r
    join app.bookings b on b.id = r.booking_id
    left join app.users rq on rq.id = r.requested_by
    left join app.users ap on ap.id = r.approved_by
    left join app.users mr on mr.id = r.manual_recorded_by
    where (${bookingId ?? null}::uuid is not null and r.booking_id = ${bookingId ?? null}::uuid)
       or (${bookingId ?? null}::uuid is null and (
             (${open} and r.state in ('REQUESTED', 'APPROVED', 'PROCESSING', 'FAILED'))
             or (not ${open} and r.state = ${query.state})))
    order by case r.state when 'FAILED' then 0 when 'REQUESTED' then 1 when 'PROCESSING' then 2 else 3 end, r.requested_at desc
    limit 200`;
}

export async function requestRefund(tx: Tx, bookingId: string, input: z.infer<typeof requestRefundInput>) {
  const [row] = await tx<{ id: string }[]>`select app.request_refund(${bookingId}, ${input.amountPesewas}, ${input.reason}, ${input.kind}) as id`;
  return row;
}

export async function approveRefund(tx: Tx, id: string) {
  await tx`select app.approve_refund(${id})`;
  return { id };
}

export async function rejectRefund(tx: Tx, id: string) {
  await tx`select app.reject_refund(${id})`;
  return { id };
}

export async function retryRefund(tx: Tx, id: string) {
  await tx`select app.retry_refund(${id})`;
  return { id };
}

export async function recordManualRefund(tx: Tx, id: string, input: z.infer<typeof manualRefundInput>) {
  await tx`select app.record_manual_refund(${id}, ${input.paymentReference})`;
  return { id };
}

export async function confirmManualRefund(tx: Tx, id: string) {
  await tx`select app.confirm_manual_refund(${id})`;
  return { id };
}
