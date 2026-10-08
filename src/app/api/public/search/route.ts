import { publicRoute } from "@/lib/api/public";
import { searchJourneys, searchQuery } from "@/server/bookings";

export const GET = publicRoute({ query: searchQuery }, ({ tx, query }) => searchJourneys(tx, query));
