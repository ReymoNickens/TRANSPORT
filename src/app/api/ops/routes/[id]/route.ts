import { idParams, opsRoute } from "@/lib/api/ops";
import { getRoute, updateRoute, updateRouteInput } from "@/server/network";

export const GET = opsRoute({ permission: "route.manage", params: idParams }, ({ tx, params }) => getRoute(tx, params.id));

export const PATCH = opsRoute({ permission: "route.manage", params: idParams, body: updateRouteInput }, ({ tx, params, body }) =>
  updateRoute(tx, params.id, body),
);
