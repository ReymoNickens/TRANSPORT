import { idParams, opsRoute } from "@/lib/api/ops";
import { getVehicle, updateVehicle, updateVehicleInput } from "@/server/fleet";

export const GET = opsRoute({ permission: "fleet.manage", params: idParams }, ({ tx, params }) => getVehicle(tx, params.id));

export const PATCH = opsRoute({ permission: "fleet.manage", params: idParams, body: updateVehicleInput }, ({ tx, params, body }) =>
  updateVehicle(tx, params.id, body),
);
