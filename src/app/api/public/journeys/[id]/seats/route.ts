import { idParams } from "@/lib/api/ops";
import { publicRoute } from "@/lib/api/public";
import { getSeatMap, seatMapQuery } from "@/server/bookings";

/** The real seat layout with each seat's availability and the fares for the chosen stops. */
export const GET = publicRoute({ params: idParams, query: seatMapQuery }, ({ tx, params, query }) => getSeatMap(tx, params.id, query));
