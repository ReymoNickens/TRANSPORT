import { opsRoute } from "@/lib/api/ops";
import { closePaperManifest, exportParams, requireJourneyAccess } from "@/server/boarding";

/** Marks a paper sheet as fully entered, so it leaves the dashboard (14.7 step 4). */
export const POST = opsRoute({ permission: "ticket.board.manual", params: exportParams }, async ({ tx, actor, params }) => {
  await requireJourneyAccess(tx, actor, params.id);
  return closePaperManifest(tx, params.id, params.exportId);
});
