import { opsRoute } from "@/lib/api/ops";
import { pageQuery } from "@/lib/api/pagination";
import { createSchedule, createScheduleInput, listSchedules, listSchedulesQuery } from "@/server/schedules";

export const GET = opsRoute({ permission: "schedule.manage", query: pageQuery.extend(listSchedulesQuery.shape) }, ({ tx, query }) =>
  listSchedules(tx, query),
);

export const POST = opsRoute({ permission: "schedule.manage", body: createScheduleInput, status: 201 }, ({ tx, actor, body }) =>
  createSchedule(tx, actor.userId, body),
);
