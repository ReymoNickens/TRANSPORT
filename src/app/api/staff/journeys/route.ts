import { opsRoute } from "@/lib/api/ops";
import { listStaffJourneys } from "@/server/boarding";

/** The staff app's Today screen: the journeys this person works on today and tomorrow. */
export const GET = opsRoute(
  { permission: ["journey.view.assigned", "ticket.scan", "booking.view.scope", "journey.update.status"] },
  ({ tx, actor }) => listStaffJourneys(tx, actor),
);
