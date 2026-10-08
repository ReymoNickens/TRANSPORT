import { opsRoute } from "@/lib/api/ops";
import { exceptionsQuery, listAttention } from "@/server/operations";

/** The needs-attention queue, filterable by severity, owner and journey (18.6). */
export const GET = opsRoute({ permission: "exception.manage", query: exceptionsQuery }, ({ tx, actor, query }) =>
  listAttention(tx, actor.userId, query),
);
