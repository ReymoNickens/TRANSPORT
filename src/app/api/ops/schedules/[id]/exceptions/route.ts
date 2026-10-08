import { idParams, opsRoute } from "@/lib/api/ops";
import { addScheduleException, exceptionInput } from "@/server/schedules";

/** A holiday or one-off change for one date. */
export const POST = opsRoute(
  { permission: "schedule.manage", params: idParams, body: exceptionInput, status: 201 },
  ({ tx, actor, params, body }) => addScheduleException(tx, actor.userId, params.id, body),
);
