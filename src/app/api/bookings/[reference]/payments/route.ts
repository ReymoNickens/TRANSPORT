import { z } from "zod";
import { AppError } from "@/lib/api/errors";
import { apiRoute, readJson } from "@/lib/api/handler";
import { currentIdentity, loadActor } from "@/lib/auth/actor";
import { withOrganisation } from "@/lib/db";
import { currentOrganisation } from "@/lib/organisation";
import { paymentProvider } from "@/providers/payments";
import { cleanReference, findAccessibleBooking } from "@/server/bookings";
import { startPayment, startPaymentInput } from "@/server/payments";

/** Starts a payment for a held booking and returns where the passenger pays. */
export const POST = apiRoute<{ reference: string }>(async ({ correlationId, request }, params) => {
  const reference = cleanReference(z.string().parse(params.reference));
  if (!reference) throw new AppError("not_found");
  const input = await readJson(request, startPaymentInput);
  const organisation = await currentOrganisation();
  const ctx = { organisationId: organisation.id, correlationId };
  const identity = await currentIdentity().catch(() => null);

  const bookingId = await withOrganisation(ctx, async (tx) => {
    const actor = identity ? await loadActor(tx, organisation.id, identity) : null;
    return findAccessibleBooking(tx, reference, { userId: actor?.userId ?? null, accessToken: request.headers.get("x-booking-token") });
  });
  const data = await startPayment(ctx, paymentProvider(), bookingId, input);
  return { data, status: 201 };
});
