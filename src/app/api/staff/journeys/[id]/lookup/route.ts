import { idParams, opsRoute } from "@/lib/api/ops";
import { env } from "@/lib/env";
import { lookupPassengers, lookupQuery, requireJourneyAccess } from "@/server/boarding";

/** Manual lookup on the journey's manifest: reference, ticket number, boarding code, phone or name (14.4). */
export const GET = opsRoute({ permission: "ticket.board.manual", params: idParams, query: lookupQuery }, async ({ tx, actor, params, query }) => {
  await requireJourneyAccess(tx, actor, params.id);
  return lookupPassengers(tx, env().TICKET_TOKEN_SECRET, params.id, query.q);
});
