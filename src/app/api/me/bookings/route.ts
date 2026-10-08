import { AppError } from "@/lib/api/errors";
import { publicRoute } from "@/lib/api/public";
import { listMyBookings } from "@/server/tickets";

/** The signed-in passenger's trips. */
export const GET = publicRoute({}, async ({ tx, userId }) => {
  if (!userId) throw new AppError("unauthenticated");
  return listMyBookings(tx, userId);
});
