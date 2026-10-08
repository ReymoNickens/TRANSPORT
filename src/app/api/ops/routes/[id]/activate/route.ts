import { idParams, opsRoute } from "@/lib/api/ops";
import { setRouteStatus } from "@/server/network";

export const POST = opsRoute({ permission: "route.manage", params: idParams }, ({ tx, params }) => setRouteStatus(tx, params.id, "active"));
