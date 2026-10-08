import { idParams, opsRoute } from "@/lib/api/ops";
import { startException } from "@/server/operations";

/** Marks an item as being worked on. */
export const POST = opsRoute({ permission: "exception.manage", params: idParams }, ({ tx, actor, params }) => startException(tx, actor.userId, params.id));
