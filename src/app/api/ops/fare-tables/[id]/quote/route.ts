import { idParams, opsRoute } from "@/lib/api/ops";
import { quoteFare, quoteInput } from "@/server/fares";

/** Previews what a passenger would pay, built exactly as checkout builds it. */
export const POST = opsRoute({ permission: "fare.manage", params: idParams, body: quoteInput }, ({ tx, params, body }) =>
  quoteFare(tx, params.id, body),
);
