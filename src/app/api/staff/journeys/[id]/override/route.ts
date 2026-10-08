import { idParams, opsRoute } from "@/lib/api/ops";
import { boardWithOverride, overrideInput, requireJourneyAccess } from "@/server/boarding";

/** Boarding against a failed check (14.4): high risk, with a reason and a fresh second factor. */
export const POST = opsRoute({ permission: "ticket.override.board", params: idParams, body: overrideInput }, async ({ tx, actor, params, body }) => {
  await requireJourneyAccess(tx, actor, params.id);
  return boardWithOverride(tx, params.id, body);
});
