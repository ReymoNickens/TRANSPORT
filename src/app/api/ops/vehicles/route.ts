import { opsRoute } from "@/lib/api/ops";
import { pageQuery } from "@/lib/api/pagination";
import { createVehicle, createVehicleInput, listVehicles, listVehiclesQuery } from "@/server/fleet";

export const GET = opsRoute({ permission: "fleet.manage", query: pageQuery.extend(listVehiclesQuery.shape) }, ({ tx, query }) =>
  listVehicles(tx, query),
);

export const POST = opsRoute({ permission: "fleet.manage", body: createVehicleInput, status: 201 }, ({ tx, actor, body }) =>
  createVehicle(tx, actor.userId, body),
);
