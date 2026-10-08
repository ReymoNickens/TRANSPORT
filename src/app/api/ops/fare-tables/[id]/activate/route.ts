import { idParams, opsRoute } from "@/lib/api/ops";
import { setFareTableStatus } from "@/server/fares";

export const POST = opsRoute({ permission: "fare.manage", params: idParams }, ({ tx, params }) => setFareTableStatus(tx, params.id, "active"));
