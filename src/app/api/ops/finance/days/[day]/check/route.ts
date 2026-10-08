import { apiRoute } from "@/lib/api/handler";
import { AppError } from "@/lib/api/errors";
import { requireActor } from "@/lib/auth/actor";
import { requirePermission } from "@/lib/auth/permissions";
import { withOrganisation } from "@/lib/db";
import { paymentProvider } from "@/providers/payments";
import { dayParam, getReconciliationDay, importAndCheckDay, requireEndedDay } from "@/server/finance";

/**
 * Imports Paystack's records for the day and checks them against ours (18.4a).
 * The provider is called outside any database transaction.
 */
export const POST = apiRoute<{ day: string }>(async (ctx, rawParams) => {
  const actor = await requireActor({ correlationId: ctx.correlationId });
  if (actor.kind !== "staff") throw new AppError("forbidden");
  requirePermission(actor, "finance.reconcile");
  const parsed = dayParam.safeParse(rawParams);
  if (!parsed.success) throw new AppError("not_found");
  requireEndedDay(parsed.data.day);
  const context = { organisationId: actor.organisationId, actorUserId: actor.userId, correlationId: ctx.correlationId };
  await importAndCheckDay(context, paymentProvider(), parsed.data.day);
  const data = await withOrganisation(context, (tx) => getReconciliationDay(tx, parsed.data.day));
  return { data };
});
