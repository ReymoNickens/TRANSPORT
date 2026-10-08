import { idParams, opsRoute } from "@/lib/api/ops";
import { recordManualRefund, manualRefundInput } from "@/server/refunds";

/** Records a refund paid outside Paystack; a different person confirms it (16.4a). High risk: a reason and a fresh second factor (section 5). */
export const POST = opsRoute({ permission: "refund.approve", params: idParams, body: manualRefundInput }, ({ tx, params, body }) => recordManualRefund(tx, params.id, body));
