import { log } from "@/lib/api/log";
import { clientAddress } from "@/lib/api/client-address";
import { isLive } from "@/lib/env";
import { currentOrganisation } from "@/lib/organisation";
import { paymentProvider } from "@/providers/payments";
import { receiveCallback } from "@/server/payments";

// Paystack's published webhook addresses: an extra control, never the only one (D34).
const PAYSTACK_ADDRESSES = new Set(["52.31.139.75", "52.49.173.169", "52.214.14.220"]);

/**
 * Paystack's webhook (13.2a). The raw body is verified and stored before any
 * processing, and success is answered quickly; the inbox makes Paystack's
 * retries harmless. The callback's amount is never trusted on its own.
 */
export async function POST(request: Request) {
  const correlationId = crypto.randomUUID();
  if (isLive() && !PAYSTACK_ADDRESSES.has(clientAddress(request) ?? "")) {
    log("warn", "paystack.callback_wrong_address", { correlationId });
    return new Response(null, { status: 403 });
  }
  const rawBody = await request.text();
  try {
    const organisation = await currentOrganisation();
    const result = await receiveCallback({ organisationId: organisation.id, correlationId }, paymentProvider(), rawBody, request.headers);
    if (!result.stored) return new Response(null, { status: 401 });
    return Response.json({ received: true });
  } catch (error) {
    log("error", "paystack.callback_failed", { correlationId, cause: error instanceof Error ? error.message : String(error) });
    // Not stored: let Paystack deliver it again.
    return new Response(null, { status: 500 });
  }
}
