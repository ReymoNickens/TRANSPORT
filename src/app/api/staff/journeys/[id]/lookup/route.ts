import { idParams, opsRoute } from "@/lib/api/ops";
import { checkLimit } from "@/lib/api/rate-limit";
import { env } from "@/lib/env";
import { lookupPassengers, lookupQuery, requireJourneyAccess } from "@/server/boarding";

/** Manual lookup on the journey's manifest: reference, ticket number, boarding code, phone or name (14.4). */
export const GET = opsRoute({ permission: "ticket.board.manual", params: idParams, query: lookupQuery }, async ({ tx, actor, ctx, params, query }) => {
  await checkLimit({ organisationId: actor.organisationId, correlationId: ctx.correlationId }, "staffLookup", actor.userId);
  await requireJourneyAccess(tx, actor, params.id);
  return lookupPassengers(tx, env().TICKET_TOKEN_SECRET, params.id, query.q);
});
