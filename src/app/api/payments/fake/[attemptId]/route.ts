import { z } from "zod";
import { AppError } from "@/lib/api/errors";
import { apiRoute, readJson } from "@/lib/api/handler";
import { withOrganisation } from "@/lib/db";
import { isLive } from "@/lib/env";
import { currentOrganisation } from "@/lib/organisation";
import { FAKE_PROVIDER_SECRET, fakeChargeEvent } from "@/providers/payments/fake";
import { signBody } from "@/providers/payments/signature";
import { paymentProvider } from "@/providers/payments";
import { receiveCallback } from "@/server/payments";

/**
 * The fake checkout page's "Approve" and "Decline" buttons (development and
 * previews only). It sends a signed callback through the same inbox path
 * Paystack's webhook uses.
 */
export const POST = apiRoute<{ attemptId: string }>(async ({ correlationId, request }, params) => {
  if (isLive()) throw new AppError("not_found");
  const attemptId = z.uuid().parse(params.attemptId);
  const { outcome } = await readJson(request, z.object({ outcome: z.enum(["success", "failed"]) }));
  const provider = paymentProvider();
  if (provider.name !== "fake") throw new AppError("not_found");
  const organisation = await currentOrganisation();
  const ctx = { organisationId: organisation.id, correlationId };

  const [attempt] = await withOrganisation(ctx, (tx) => tx<{ amountPesewas: number; currency: string }[]>`
    select amount_pesewas, currency from app.payment_attempts where id = ${attemptId}`);
  if (!attempt) throw new AppError("not_found");
  const rawBody = JSON.stringify(fakeChargeEvent(attemptId, outcome, attempt.amountPesewas, attempt.currency));
  const headers = new Headers({ "x-paystack-signature": signBody(FAKE_PROVIDER_SECRET, rawBody) });
  const result = await receiveCallback(ctx, provider, rawBody, headers);
  return { data: { outcome: result.outcome } };
});
