import { idParams, opsRoute } from "@/lib/api/ops";
import { resolveException, resolveInput } from "@/server/operations";

/** Closes an item with a note saying what was done (18.6). */
export const POST = opsRoute({ permission: "exception.manage", params: idParams, body: resolveInput }, ({ tx, actor, params, body }) =>
  resolveException(tx, actor.userId, params.id, body),
);
