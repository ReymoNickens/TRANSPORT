import { z } from "zod";
import { AppError } from "@/lib/api/errors";
import { idempotent } from "@/lib/api/idempotency";
import { publicRoute } from "@/lib/api/public";
import type { Tx } from "@/lib/db";
import { clientAddress } from "@/lib/api/client-address";
import { guardedLookup } from "@/lib/api/rate-limit";
import { cleanReference, findAccessibleBooking } from "@/server/bookings";
import { cancelInput, cancellationQuote, cancelSeats } from "@/server/cancellations";

const params = z.object({ reference: z.string() });

async function bookingFor(tx: Tx, rawReference: string, userId: string | null, request: Request, context: { organisationId: string; correlationId: string }) {
  const reference = cleanReference(rawReference);
  if (!reference) throw new AppError("not_found");
  const id = await guardedLookup(context, clientAddress(request), () =>
    findAccessibleBooking(tx, reference, { userId, accessToken: request.headers.get("x-booking-token") }).catch((error) => {
      if (error instanceof AppError && error.code === "not_found") return null;
      throw error;
    }),
  );
  if (!id) throw new AppError("not_found", { message: "We couldn't find that booking." });
  return id;
}

/** What cancelling would refund now, seat by seat, under the policy the booking was sold with (16.1). */
export const GET = publicRoute({ params }, async ({ tx, ctx, organisationId, userId, params }) =>
  cancellationQuote(tx, await bookingFor(tx, params.reference, userId, ctx.request, { organisationId, correlationId: ctx.correlationId })),
);

/**
 * The passenger cancels seats (16.2). The refund is worked out on the server;
 * a retried request with the same Idempotency-Key returns the first result.
 */
export const POST = publicRoute({ params, body: cancelInput }, async ({ tx, ctx, organisationId, userId, params, body }) => {
  const bookingId = await bookingFor(tx, params.reference, userId, ctx.request, { organisationId, correlationId: ctx.correlationId });
  const { result } = await idempotent(
    tx,
    { organisationId, operation: "cancel_booking", key: ctx.request.headers.get("idempotency-key"), request: { bookingId, ...body } },
    () => cancelSeats(tx, bookingId, { ...body, reason: "Cancelled by the passenger" }),
  );
  return result;
});
