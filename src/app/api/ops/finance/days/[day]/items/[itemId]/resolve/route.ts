import { z } from "zod";
import { opsRoute } from "@/lib/api/ops";
import { resolveItem, resolveItemInput } from "@/server/finance";

const params = z.object({ day: z.iso.date(), itemId: z.uuid() });

/** Resolves one difference with a note (18.4 step 4). */
export const POST = opsRoute({ permission: "finance.reconcile", params, body: resolveItemInput }, ({ tx, params, body }) =>
  resolveItem(tx, params.itemId, body),
);
