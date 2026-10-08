import { z } from "zod";
import { opsRoute } from "@/lib/api/ops";
import { getBooking } from "@/server/bookings";
import { bookingIdByReference } from "@/server/operations";

const params = z.object({ reference: z.string().regex(/^[2-9A-HJ-NP-Za-hj-np-z]{8}$/) });

/** One booking for staff. Staff never see a passenger's QR or boarding code. */
export const GET = opsRoute({ permission: "booking.view.scope", params }, async ({ tx, params }) =>
  getBooking(tx, await bookingIdByReference(tx, params.reference), undefined),
);
