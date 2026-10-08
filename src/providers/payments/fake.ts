import {
  type PaymentCheck,
  type PaymentProvider,
  type RefundResult,
  type StartPaymentInput,
  type StartPaymentResult,
  type VerifiedCallback,
} from "./types";
import { signatureMatches } from "./signature";

/** Callbacks from the fake checkout page are signed with this. Never used on the live service. */
export const FAKE_PROVIDER_SECRET = "fake-provider-secret-not-for-production";

/**
 * The fake provider (spec 13.2): the same interface, for tests and
 * demonstrations. Its checkout page is our own /pay/fake page, where a
 * tester approves or declines; that page sends a signed callback in
 * Paystack's format through the same webhook path. Refused on the live service.
 */
export class FakePaymentProvider implements PaymentProvider {
  readonly name = "fake" as const;

  constructor(private readonly baseUrl: string) {}

  async startPayment(input: StartPaymentInput): Promise<StartPaymentResult> {
    return {
      providerReference: input.attemptId,
      checkoutUrl: `${this.baseUrl}/pay/fake/${input.attemptId}`,
    };
  }

  async checkPayment(reference: string): Promise<PaymentCheck> {
    // The fake checkout reports by callback only, so a check never knows more.
    return { status: "pending", amountPesewas: null, currency: null, providerFeePesewas: 0, providerReference: reference };
  }

  verifyCallback(rawBody: string, headers: Headers): VerifiedCallback | null {
    if (!signatureMatches(FAKE_PROVIDER_SECRET, rawBody, headers.get("x-paystack-signature"))) return null;
    const event = JSON.parse(rawBody) as { event: string; data: { id: string; reference: string } };
    return { eventId: `${event.event}:${event.data.id}`, kind: event.event.startsWith("charge.") ? "charge" : "other", reference: event.data.reference };
  }

  async refund(): Promise<RefundResult> {
    return { providerReference: `fake-refund-${Date.now()}`, status: "processed" };
  }
}

/** The callback body the fake checkout sends, in Paystack's shape. */
export function fakeChargeEvent(attemptId: string, outcome: "success" | "failed", amountPesewas: number, currency: string) {
  return {
    event: outcome === "success" ? "charge.success" : "charge.failed",
    data: { id: `fake-${attemptId}-${outcome}`, reference: attemptId, status: outcome, amount: amountPesewas, currency, fees: 0 },
  };
}
