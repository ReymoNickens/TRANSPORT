import { idParams, opsRoute } from "@/lib/api/ops";
import { rejectRefund, reasonOnly } from "@/server/refunds";

/** Turns down a requested refund. High risk: a reason and a fresh second factor (section 5). */
export const POST = opsRoute({ permission: "refund.approve", params: idParams, body: reasonOnly }, ({ tx, params }) => rejectRefund(tx, params.id));
