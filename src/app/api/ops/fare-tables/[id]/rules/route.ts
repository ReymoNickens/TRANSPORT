import { idParams, opsRoute } from "@/lib/api/ops";
import { replaceFareRules, replaceFareRulesInput } from "@/server/fares";

export const PUT = opsRoute({ permission: "fare.manage", params: idParams, body: replaceFareRulesInput }, ({ tx, params, body }) =>
  replaceFareRules(tx, params.id, body),
);
