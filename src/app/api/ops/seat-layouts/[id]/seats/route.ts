import { idParams, opsRoute } from "@/lib/api/ops";
import { replaceSeats, replaceSeatsInput } from "@/server/fleet";

export const PUT = opsRoute({ permission: "fleet.manage", params: idParams, body: replaceSeatsInput }, ({ tx, params, body }) =>
  replaceSeats(tx, params.id, body),
);
