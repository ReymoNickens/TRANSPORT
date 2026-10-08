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

/**
 * Background work, called every minute by a scheduler with the CRON_SECRET:
 * expire holds, ask the provider about late payments, retry stored callbacks,
 * send refunds and check on them, send queued text messages, raise and clear
 * needs-attention items, and settle journeys after arrival (no-shows). Each
 * step is safe to repeat.
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
  log("info", "jobs.tick", { correlationId, expired, ...payments, callbacks, ...refunds, ...messages, raised, settled });
  return Response.json({ data: { expired, ...payments, callbacks, ...refunds, ...messages, raised, settled } });
}

export const GET = tick;
export const POST = tick;
