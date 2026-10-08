import { idParams, opsRoute } from "@/lib/api/ops";
import { takeException } from "@/server/operations";

/** Takes ownership of an item (audited). */
export const POST = opsRoute({ permission: "exception.manage", params: idParams }, ({ tx, params }) => takeException(tx, params.id));
