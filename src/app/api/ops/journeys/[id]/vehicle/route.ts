import { idParams, opsRoute } from "@/lib/api/ops";
import { assignVehicle, assignVehicleInput } from "@/server/journeys";

export const POST = opsRoute({ permission: "vehicle.assign", params: idParams, body: assignVehicleInput }, ({ tx, params, body }) =>
  assignVehicle(tx, params.id, body),
);
