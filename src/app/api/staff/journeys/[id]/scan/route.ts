import { idempotent } from "@/lib/api/idempotency";
import { idParams, opsRoute } from "@/lib/api/ops";
import { checkLimit } from "@/lib/api/rate-limit";
import { requireJourneyAccess, scanInput, scanTicket } from "@/server/boarding";

/**
 * Scan (14.3). Without confirm it checks and shows the passenger; with confirm
 * it boards them. Confirming needs an Idempotency-Key so a lost reply is
 * retried safely and returns the original result (14.3a).
 */
export const POST = opsRoute({ permission: "ticket.scan", params: idParams, body: scanInput }, async ({ tx, actor, params, body, ctx }) => {
  await checkLimit({ organisationId: actor.organisationId, correlationId: ctx.correlationId }, "scan", actor.userId);
  await requireJourneyAccess(tx, actor, params.id);
  if (!body.confirm) return scanTicket(tx, params.id, body);
  const { result } = await idempotent(
    tx,
    { organisationId: actor.organisationId, operation: "board_ticket", key: ctx.request.headers.get("idempotency-key"), request: { journeyId: params.id, ...body } },
    () => scanTicket(tx, params.id, body),
  );
  return result;
});
