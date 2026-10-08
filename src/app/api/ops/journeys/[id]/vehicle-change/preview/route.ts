import { idParams, opsRoute } from "@/lib/api/ops";
import { previewVehicleChange, vehicleChangePreviewInput } from "@/server/vehicle-change";

/** Where every passenger would sit on the new bus (15.1). Changes nothing. */
export const POST = opsRoute({ permission: "vehicle.assign", params: idParams, body: vehicleChangePreviewInput }, ({ tx, params, body }) =>
  previewVehicleChange(tx, params.id, body),
);
