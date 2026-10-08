import { timingSafeEqual } from "node:crypto";
import { withOrganisation } from "@/lib/db";
import { env } from "@/lib/env";
import { currentOrganisation } from "@/lib/organisation";
import { currentAlerts, runbookFirstStep } from "@/server/alerts";

/**
 * Operational alerts (spec 22.3) for an outside uptime monitor, which pages
 * the named person. 200 when all is well; 503 with the alerts otherwise, so
 * even a stopped background job is noticed. Needs the CRON_SECRET.
 */
export async function GET(request: Request) {
  const secret = env().CRON_SECRET;
  const given = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (!secret || given.length !== secret.length || !timingSafeEqual(Buffer.from(given), Buffer.from(secret))) {
    return new Response(null, { status: 401 });
  }
  const organisation = await currentOrganisation();
  const alerts = await withOrganisation({ organisationId: organisation.id }, (tx) => currentAlerts(tx));
  const body = { status: alerts.length ? "attention" : "ok", alerts: alerts.map((a) => ({ ...a, firstStep: runbookFirstStep[a.signal] ?? null })) };
  return Response.json(body, { status: alerts.length ? 503 : 200 });
}
