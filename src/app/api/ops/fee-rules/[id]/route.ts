import { idParams, opsRoute } from "@/lib/api/ops";
import { updateFee, updateFeeInput } from "@/server/fares";

export const PATCH = opsRoute({ permission: "fare.manage", params: idParams, body: updateFeeInput }, ({ tx, params, body }) =>
  updateFee(tx, params.id, body),
);
