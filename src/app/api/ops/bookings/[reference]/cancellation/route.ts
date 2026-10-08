import { z } from "zod";
import { opsRoute } from "@/lib/api/ops";
import { cancelInput, cancellationQuote, cancelSeats } from "@/server/cancellations";
import { bookingIdByReference } from "@/server/operations";

const params = z.object({ reference: z.string().regex(/^[2-9A-HJ-NP-Za-hj-np-z]{8}$/) });

/** The policy refund for each seat, for staff helping a passenger. */
export const GET = opsRoute({ permission: "booking.cancel.scope", params }, async ({ tx, params }) =>
  cancellationQuote(tx, await bookingIdByReference(tx, params.reference)),
);

/** Cancels seats for a passenger, under the booking's policy (16.2). */
export const POST = opsRoute({ permission: "booking.cancel.scope", params, body: cancelInput }, async ({ tx, params, body }) =>
  cancelSeats(tx, await bookingIdByReference(tx, params.reference), { ...body, reason: body.reason || "Cancelled by staff for the passenger" }),
);
