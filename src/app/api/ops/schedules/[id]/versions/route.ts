import { idParams, opsRoute } from "@/lib/api/ops";
import { newScheduleVersion, newVersionInput } from "@/server/schedules";

/** Edits a schedule by adding a version; returns what it would change on generated journeys (23.1). */
export const POST = opsRoute(
  { permission: "schedule.manage", params: idParams, body: newVersionInput, status: 201 },
  ({ tx, actor, params, body }) => newScheduleVersion(tx, actor.userId, params.id, body),
);
