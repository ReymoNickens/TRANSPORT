import { idParams, opsRoute } from "@/lib/api/ops";
import { approveRefund, reasonOnly } from "@/server/refunds";

/** Approves a refund someone else requested (16.3). High risk: a reason and a fresh second factor (section 5). */
export const POST = opsRoute({ permission: "refund.approve", params: idParams, body: reasonOnly }, ({ tx, params }) => approveRefund(tx, params.id));
