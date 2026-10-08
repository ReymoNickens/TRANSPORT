import { timingSafeEqual } from "node:crypto";
import { log } from "@/lib/api/log";
import { withOrganisation } from "@/lib/db";
import { env } from "@/lib/env";
import { currentOrganisation } from "@/lib/organisation";
import { paymentProvider } from "@/providers/payments";
import { smsProvider } from "@/providers/sms";
import { sendDueMessages } from "@/server/messages";
import { checkPendingAttempts, retryStoredCallbacks } from "@/server/payments";
import { checkProcessingRefunds, processDueRefunds } from "@/server/refunds";
import { importAndCheckDay } from "@/server/finance";
import { currentAlerts, raiseAlerts } from "@/server/alerts";

/**
 * Background work, called every minute by a scheduler with the CRON_SECRET:
 * expire holds, ask the provider about late payments, retry stored callbacks,
 * send refunds and check on them, send queued text messages, raise and clear
 * needs-attention items, settle journeys after arrival (no-shows), and check
 * yesterday against Paystack once. Each step is safe to repeat.
 */
async function tick(request: Request) {
  const correlationId = crypto.randomUUID();
  const secret = env().CRON_SECRET;
  const given = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (!secret || given.length !== secret.length || !timingSafeEqual(Buffer.from(given), Buffer.from(secret))) {
    return new Response(null, { status: 401 });
  }
  const organisation = await currentOrganisation();
  const ctx = { organisationId: organisation.id, correlationId };
  const [{ expired }] = await withOrganisation(ctx, (tx) => tx<{ expired: number }[]>`select app.expire_holds() as expired`);
  const payments = await checkPendingAttempts(ctx, paymentProvider());
  const callbacks = await retryStoredCallbacks(ctx, paymentProvider());
  const refunds = { ...(await processDueRefunds(ctx, paymentProvider())), ...(await checkProcessingRefunds(ctx, paymentProvider())) };
  const ticketSecret = env().TICKET_TOKEN_SECRET;
  const messages = ticketSecret ? await sendDueMessages(ctx, smsProvider(), { ticketSecret, baseUrl: env().APP_BASE_URL }) : { sent: 0 };
  const [{ raised, settled }] = await withOrganisation(ctx, (tx) =>
    tx<{ raised: number; settled: number }[]>`select app.check_operations() as raised, app.settle_completed_journeys() as settled`,
  );
  // Yesterday is checked against the provider's records once, automatically; Finance can check again any time.
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const [{ checked }] = await withOrganisation(ctx, (tx) =>
    tx<{ checked: boolean }[]>`select exists (select 1 from app.reconciliation_days where day = ${yesterday}::date and checked_at is not null) as checked`,
  );
  const reconciliation = checked ? null : await importAndCheckDay(ctx, paymentProvider(), yesterday).catch((error) => {
    log("warn", "jobs.reconciliation_failed", { correlationId, cause: error instanceof Error ? error.message : String(error) });
    return null;
  });
  const summary = { expired, ...payments, callbacks, ...refunds, ...messages, raised, settled, reconciled: reconciliation?.day ?? null };
  const alerts = await withOrganisation(ctx, async (tx) => {
    await tx`select app.record_heartbeat('tick', ${tx.json(summary)})`;
    const found = await currentAlerts(tx);
    await raiseAlerts(tx, organisation.id, found);
    return found;
  });
  log(alerts.length ? "warn" : "info", "jobs.tick", { ...summary, correlationId, alerts: alerts.map((a) => a.signal) });
  return Response.json({ data: { expired, ...payments, callbacks, ...refunds, ...messages, raised, settled, reconciled: reconciliation?.day ?? null } });
}

export const GET = tick;
export const POST = tick;
