import { idParams, opsRoute } from "@/lib/api/ops";
import { publishLayout } from "@/server/fleet";

/** Makes a draft the vehicle's current layout; the previous one is retired. */
export const POST = opsRoute({ permission: "fleet.manage", params: idParams }, ({ tx, params }) => publishLayout(tx, params.id));
