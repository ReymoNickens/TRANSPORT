import { opsRoute } from "@/lib/api/ops";
import { listReconciliationDays } from "@/server/finance";

/** The last fortnight of reconciliation days and what is left on each. */
export const GET = opsRoute({ permission: "finance.reconcile" }, ({ tx }) => listReconciliationDays(tx));
