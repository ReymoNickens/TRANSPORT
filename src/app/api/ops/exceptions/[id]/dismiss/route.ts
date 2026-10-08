import { idParams, opsRoute } from "@/lib/api/ops";
import { dismissException, dismissInput } from "@/server/operations";

/** Closes an item without fixing it: high risk, with a reason and a fresh second factor (18.6). */
export const POST = opsRoute({ permission: "exception.dismiss", params: idParams, body: dismissInput }, ({ tx, actor, params, body }) =>
  dismissException(tx, actor.userId, params.id, body),
);
