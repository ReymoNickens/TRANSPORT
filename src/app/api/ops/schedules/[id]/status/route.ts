import { idParams, opsRoute } from "@/lib/api/ops";
import { scheduleStatusInput, setScheduleStatus } from "@/server/schedules";

export const POST = opsRoute({ permission: "schedule.manage", params: idParams, body: scheduleStatusInput }, ({ tx, params, body }) =>
  setScheduleStatus(tx, params.id, body),
);
