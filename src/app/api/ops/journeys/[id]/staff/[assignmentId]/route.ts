import { z } from "zod";
import { opsRoute } from "@/lib/api/ops";
import { removeStaff } from "@/server/journeys";

export const DELETE = opsRoute(
  { permission: "journey.create", params: z.object({ id: z.uuid(), assignmentId: z.uuid() }) },
  ({ tx, actor, params }) => removeStaff(tx, actor.userId, params.id, params.assignmentId),
);
