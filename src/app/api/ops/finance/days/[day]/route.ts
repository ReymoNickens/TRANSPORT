import { opsRoute } from "@/lib/api/ops";
import { dayParam, getReconciliationDay } from "@/server/finance";

/** One day's check against Paystack: totals and every difference (18.4). */
export const GET = opsRoute({ permission: "finance.reconcile", params: dayParam }, ({ tx, params }) => getReconciliationDay(tx, params.day));
