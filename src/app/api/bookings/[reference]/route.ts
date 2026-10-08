import { z } from "zod";
import { apiRoute } from "@/lib/api/handler";
import { AppError } from "@/lib/api/errors";
import { currentIdentity, loadActor } from "@/lib/auth/actor";
import { withOrganisation } from "@/lib/db";
import { env } from "@/lib/env";
import { currentOrganisation } from "@/lib/organisation";
import { paymentProvider } from "@/providers/payments";
import { cleanReference, findAccessibleBooking, getBooking } from "@/server/bookings";
import { checkPendingAttempts } from "@/server/payments";
import { clientAddress } from "@/lib/api/client-address";
import { guardedLookup } from "@/lib/api/rate-limit";

/**
 * The booking's true state, from the server (12.6 step 6). If a payment has
 * waited a minute without a callback, the provider is asked first (12.6 step 8).
 */
const notFoundAsNull = (error: unknown) => {
  if (error instanceof AppError && error.code === "not_found") return null;
  throw error;
};

export const GET = apiRoute<{ reference: string }>(async ({ correlationId, request }, params) => {
  const reference = cleanReference(z.string().parse(params.reference));
  if (!reference) throw new AppError("not_found");
  const organisation = await currentOrganisation();
  const ctx = { organisationId: organisation.id, correlationId };
  const identity = await currentIdentity().catch(() => null);
  const accessToken = request.headers.get("x-booking-token");

  const bookingId = await guardedLookup(ctx, clientAddress(request), () =>
    withOrganisation(ctx, async (tx) => {
      const actor = identity ? await loadActor(tx, organisation.id, identity) : null;
      return findAccessibleBooking(tx, reference, { userId: actor?.userId ?? null, accessToken }).catch(notFoundAsNull);
    }),
  );
  if (!bookingId) throw new AppError("not_found", { message: "We couldn't find that booking." });
  await checkPendingAttempts(ctx, paymentProvider(), { bookingId, limit: 2 });
  const data = await withOrganisation(ctx, (tx) => getBooking(tx, bookingId, env().TICKET_TOKEN_SECRET));
  return { data };
});
