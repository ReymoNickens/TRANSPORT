import { idParams, opsRoute } from "@/lib/api/ops";
import { updateLocation, updateLocationInput } from "@/server/network";

export const PATCH = opsRoute({ permission: "route.manage", params: idParams, body: updateLocationInput }, ({ tx, params, body }) =>
  updateLocation(tx, params.id, body),
);
