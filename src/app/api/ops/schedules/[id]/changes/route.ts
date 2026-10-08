import { idParams, opsRoute } from "@/lib/api/ops";
import { applyScheduleChange, previewScheduleChange } from "@/server/schedules";

/** The counts a manager sees before confirming a schedule change (23.1). */
export const GET = opsRoute({ permission: "schedule.manage", params: idParams }, ({ tx, params }) =>
  previewScheduleChange(tx, params.id),
);

/** Applies the current version to unbooked journeys generated from older versions. */
export const POST = opsRoute({ permission: "schedule.manage", params: idParams }, ({ tx, params }) =>
  applyScheduleChange(tx, params.id),
);
