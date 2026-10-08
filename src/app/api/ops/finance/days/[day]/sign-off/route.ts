import { opsRoute } from "@/lib/api/ops";
import { dayParam, signOffDay, signOffInput } from "@/server/finance";

/** Finance signs off a day that balances (18.4 step 5). */
export const POST = opsRoute({ permission: "finance.reconcile", params: dayParam, body: signOffInput }, ({ tx, params, body }) =>
  signOffDay(tx, params.day, body),
);
