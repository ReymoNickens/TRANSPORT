import { idParams, opsRoute } from "@/lib/api/ops";
import { env } from "@/lib/env";
import { exportPaperManifest, requireJourneyAccess } from "@/server/boarding";

/** A numbered paper manifest for boarding with no signal (14.7). Every export is audited. */
export const POST = opsRoute(
  { permission: ["ticket.board.manual", "passenger.export"], params: idParams, status: 201 },
  async ({ tx, actor, params }) => {
    await requireJourneyAccess(tx, actor, params.id);
    return exportPaperManifest(tx, env().TICKET_TOKEN_SECRET, params.id);
  },
);
