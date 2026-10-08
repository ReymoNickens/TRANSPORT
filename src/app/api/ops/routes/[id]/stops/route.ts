import { idParams, opsRoute } from "@/lib/api/ops";
import { replaceRouteStops, routeStopsInput } from "@/server/network";

/** Replaces all stops of a draft route, in order. */
export const PUT = opsRoute({ permission: "route.manage", params: idParams, body: routeStopsInput }, ({ tx, params, body }) =>
  replaceRouteStops(tx, params.id, body),
);
