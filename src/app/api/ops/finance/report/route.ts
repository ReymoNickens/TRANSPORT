import { opsRoute } from "@/lib/api/ops";
import { financeReport, rangeQuery } from "@/server/finance";

/** Booked and earned revenue, provider fees and refund liability for a period (18.1, 18.2). */
export const GET = opsRoute({ permission: ["payment.view", "finance.reconcile"], query: rangeQuery }, ({ tx, query }) => financeReport(tx, query));
