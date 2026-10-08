import { opsRoute } from "@/lib/api/ops";
import { enterPaperBoardings, exportParams, paperEntriesInput, requireJourneyAccess } from "@/server/boarding";

/** Enters the boardings ticked on a paper sheet, with the times written on it (14.7 step 3). */
export const POST = opsRoute(
  { permission: "ticket.board.manual", params: exportParams, body: paperEntriesInput },
  async ({ tx, actor, params, body }) => {
    await requireJourneyAccess(tx, actor, params.id);
    return enterPaperBoardings(tx, params.id, params.exportId, body);
  },
);
