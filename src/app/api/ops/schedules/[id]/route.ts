import { idParams, opsRoute } from "@/lib/api/ops";
import { getSchedule } from "@/server/schedules";

export const GET = opsRoute({ permission: "schedule.manage", params: idParams }, ({ tx, params }) => getSchedule(tx, params.id));
