import { opsRoute } from "@/lib/api/ops";
import { pageQuery } from "@/lib/api/pagination";
import { createLocation, createLocationInput, listLocations, listLocationsQuery } from "@/server/network";

export const GET = opsRoute({ permission: "route.manage", query: pageQuery.extend(listLocationsQuery.shape) }, ({ tx, query }) =>
  listLocations(tx, query),
);

export const POST = opsRoute({ permission: "route.manage", body: createLocationInput, status: 201 }, ({ tx, actor, body }) =>
  createLocation(tx, actor.userId, body),
);
