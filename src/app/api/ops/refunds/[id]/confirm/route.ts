import { idParams, opsRoute } from "@/lib/api/ops";
import { confirmManualRefund, reasonOnly } from "@/server/refunds";

/** Confirms a refund paid by hand, recorded by someone else (16.4a). High risk: a reason and a fresh second factor (section 5). */
export const POST = opsRoute({ permission: "refund.approve", params: idParams, body: reasonOnly }, ({ tx, params }) => confirmManualRefund(tx, params.id));
