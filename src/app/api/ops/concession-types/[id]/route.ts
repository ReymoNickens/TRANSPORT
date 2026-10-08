import { idParams, opsRoute } from "@/lib/api/ops";
import { updateConcession, updateConcessionInput } from "@/server/fares";

export const PATCH = opsRoute({ permission: "fare.manage", params: idParams, body: updateConcessionInput }, ({ tx, params, body }) =>
  updateConcession(tx, params.id, body),
);
