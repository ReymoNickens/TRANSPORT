import { opsRoute } from "@/lib/api/ops";
import { bookingLookupQuery, lookupBookings } from "@/server/operations";

/** Look up a booking by reference or phone number. */
export const GET = opsRoute({ permission: "booking.view.scope", query: bookingLookupQuery }, ({ tx, query }) => lookupBookings(tx, query.q));
