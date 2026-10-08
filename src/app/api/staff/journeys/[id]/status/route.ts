import { idParams, opsRoute } from "@/lib/api/ops";
import { requireJourneyAccess, statusInput, updateJourneyStatus } from "@/server/boarding";

/** Start boarding, record departure or record arrival. */
export const POST = opsRoute({ permission: "journey.update.status", params: idParams, body: statusInput }, async ({ tx, actor, params, body }) => {
  await requireJourneyAccess(tx, actor, params.id);
  return updateJourneyStatus(tx, params.id, body);
});
