import { idParams, opsRoute } from "@/lib/api/ops";
import { copyFareTable, copyFareTableInput } from "@/server/fares";

/** Copies a fare table into a new draft, the way prices are changed. */
export const POST = opsRoute(
  { permission: "fare.manage", params: idParams, body: copyFareTableInput, status: 201 },
  ({ tx, params, body }) => copyFareTable(tx, params.id, body),
);
