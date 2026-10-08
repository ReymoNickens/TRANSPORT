import { publicRoute } from "@/lib/api/public";
import { listPublicLocations } from "@/server/bookings";

/** Places passengers can search between. */
export const GET = publicRoute({}, ({ tx }) => listPublicLocations(tx));
