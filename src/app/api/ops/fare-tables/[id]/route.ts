import { idParams, opsRoute } from "@/lib/api/ops";
import { getFareTable } from "@/server/fares";

export const GET = opsRoute({ permission: "fare.manage", params: idParams }, ({ tx, params }) => getFareTable(tx, params.id));
