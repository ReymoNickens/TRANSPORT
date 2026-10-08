import { idempotent } from "@/lib/api/idempotency";
import { publicRoute } from "@/lib/api/public";
import { holdInput, holdSeats } from "@/server/bookings";

/**
 * Holds seats (11.3). Needs an Idempotency-Key header: a retry after an
 * uncertain network reply returns the same booking instead of holding more seats.
 */
export const POST = publicRoute({ body: holdInput, status: 201 }, async ({ tx, ctx, organisationId, userId, address, body }) => {
  const { result } = await idempotent(
    tx,
    { organisationId, operation: "hold_seats", key: ctx.request.headers.get("idempotency-key"), request: body },
    () => holdSeats(tx, body, { userId, address, source: "passenger_app" }),
  );
  return result;
});
