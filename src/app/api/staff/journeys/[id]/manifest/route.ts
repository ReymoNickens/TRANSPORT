import { idParams, opsRoute } from "@/lib/api/ops";
import { getManifest, requireJourneyAccess } from "@/server/boarding";

/** The journey's passengers and boarding status (14.5). Only for its crew or organisation-wide lookup. */
export const GET = opsRoute(
  { permission: ["journey.view.assigned", "ticket.scan", "booking.view.scope"], params: idParams },
  async ({ tx, actor, params }) => {
    await requireJourneyAccess(tx, actor, params.id);
    return getManifest(tx, params.id);
  },
);
