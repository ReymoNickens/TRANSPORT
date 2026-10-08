import { z } from "zod";
import { opsRoute } from "@/lib/api/ops";
import { bookingIdByReference } from "@/server/operations";
import { listRefunds, requestRefund, requestRefundInput } from "@/server/refunds";

const params = z.object({ reference: z.string().regex(/^[2-9A-HJ-NP-Za-hj-np-z]{8}$/) });

/** Every refund on one booking. */
export const GET = opsRoute({ permission: ["booking.view.scope", "payment.view", "refund.request"], params }, async ({ tx, params }) =>
  listRefunds(tx, { state: "open" }, await bookingIdByReference(tx, params.reference)),
);

/** A refund outside the policy (goodwill or a correction): waits for someone else to approve it (16.3). */
export const POST = opsRoute({ permission: "refund.request", params, body: requestRefundInput, status: 201 }, async ({ tx, params, body }) =>
  requestRefund(tx, await bookingIdByReference(tx, params.reference), body),
);
