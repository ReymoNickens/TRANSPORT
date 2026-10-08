import { idParams, opsRoute } from "@/lib/api/ops";
import { getLayout } from "@/server/fleet";

export const GET = opsRoute({ permission: "fleet.manage", params: idParams }, ({ tx, params }) => getLayout(tx, params.id));
