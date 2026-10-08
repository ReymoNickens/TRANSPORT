import { idempotent } from "@/lib/api/idempotency";
import { idParams, opsRoute } from "@/lib/api/ops";
import { boardInput, boardManually, requireJourneyAccess } from "@/server/boarding";

/** Manual boarding after a lookup (14.4). Confirming needs an Idempotency-Key. */
export const POST = opsRoute({ permission: "ticket.board.manual", params: idParams, body: boardInput }, async ({ tx, actor, params, body, ctx }) => {
  await requireJourneyAccess(tx, actor, params.id);
  if (!body.confirm) return boardManually(tx, params.id, body);
  const { result } = await idempotent(
    tx,
    { organisationId: actor.organisationId, operation: "board_ticket", key: ctx.request.headers.get("idempotency-key"), request: { journeyId: params.id, ...body } },
    () => boardManually(tx, params.id, body),
  );
  return result;
});
