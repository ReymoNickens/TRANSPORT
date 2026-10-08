import { idParams, opsRoute } from "@/lib/api/ops";
import { changeVehicle, vehicleChangeInput } from "@/server/vehicle-change";

/** Changes the bus of a journey on sale, after the preview was seen and confirmed (15.1 rule 5). */
export const POST = opsRoute({ permission: "vehicle.assign", params: idParams, body: vehicleChangeInput }, ({ tx, params, body }) =>
  changeVehicle(tx, params.id, body),
);
