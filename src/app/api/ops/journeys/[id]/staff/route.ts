import { idParams, opsRoute } from "@/lib/api/ops";
import { assignStaff, assignStaffInput } from "@/server/journeys";

export const POST = opsRoute({ permission: "journey.create", params: idParams, body: assignStaffInput, status: 201 }, ({ tx, params, body }) =>
  assignStaff(tx, params.id, body),
);
