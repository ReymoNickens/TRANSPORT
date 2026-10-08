import { opsRoute } from "@/lib/api/ops";
import { getDashboard } from "@/server/operations";

/** The manager's dashboard (8.2a): needs attention, today's departures, today's figures. */
export const GET = opsRoute(
  { permission: ["journey.create", "booking.view.scope", "exception.manage", "payment.view"] },
  ({ tx, actor }) => getDashboard(tx, actor.userId),
);
