import { idParams, opsRoute } from "@/lib/api/ops";
import { removeScheduleException } from "@/server/schedules";

export const DELETE = opsRoute({ permission: "schedule.manage", params: idParams }, ({ tx, params }) =>
  removeScheduleException(tx, params.id),
);
