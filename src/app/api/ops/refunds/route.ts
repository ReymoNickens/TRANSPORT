import { opsRoute } from "@/lib/api/ops";
import { listRefunds, refundsQuery } from "@/server/refunds";

/** Finance's refund queue: waiting for approval, being paid, failed. */
export const GET = opsRoute({ permission: ["refund.approve", "payment.view", "refund.request"], query: refundsQuery }, ({ tx, query }) =>
  listRefunds(tx, query),
);
