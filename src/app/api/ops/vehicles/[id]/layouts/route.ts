import { idParams, opsRoute } from "@/lib/api/ops";
import { createLayout, createLayoutInput } from "@/server/fleet";

/** Starts a new draft seat layout, from a pattern such as 2+2 or seat by seat. */
export const POST = opsRoute(
  { permission: "fleet.manage", params: idParams, body: createLayoutInput, status: 201 },
  ({ tx, actor, params, body }) => createLayout(tx, actor.userId, params.id, body),
);
