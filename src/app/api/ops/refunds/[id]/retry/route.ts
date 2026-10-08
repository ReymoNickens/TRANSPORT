import { idParams, opsRoute } from "@/lib/api/ops";
import { retryRefund, reasonOnly } from "@/server/refunds";

/** Sends a failed refund back to the provider. High risk: a reason and a fresh second factor (section 5). */
export const POST = opsRoute({ permission: "refund.approve", params: idParams, body: reasonOnly }, ({ tx, params }) => retryRefund(tx, params.id));
