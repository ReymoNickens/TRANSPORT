import { opsRoute } from "@/lib/api/ops";
import { pageQuery } from "@/lib/api/pagination";
import { createRoute, createRouteInput, listRoutes, listRoutesQuery } from "@/server/network";

export const GET = opsRoute({ permission: "route.manage", query: pageQuery.extend(listRoutesQuery.shape) }, ({ tx, query }) =>
  listRoutes(tx, query),
);

export const POST = opsRoute({ permission: "route.manage", body: createRouteInput, status: 201 }, ({ tx, actor, body }) =>
  createRoute(tx, actor.userId, body),
);
