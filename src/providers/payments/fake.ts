import {
  PaymentProviderError,
  type ProviderSettlement,
  type ProviderTransaction,
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

  /**
   * What the fake does with a refund, for tests: "processed" at once (the default),
   * "pending" until checked, "refused" (cannot refund this payment) or "unreachable".
   */
  refundBehaviour: "processed" | "pending" | "refused" | "unreachable" = "processed";
  /** What a later check of a pending refund reports. */
  refundCheckResult: RefundResult["status"] = "processed";

  /** The fake's own records, for reconciliation tests: set them to what "the provider" says. */
  transactions: ProviderTransaction[] = [];
  settlements: (ProviderSettlement & { transactionReferences: string[] })[] = [];

  constructor(private readonly baseUrl: string) {}

  async startPayment(input: StartPaymentInput): Promise<StartPaymentResult> {
    return {
      providerReference: input.attemptId,
      checkoutUrl: `${this.baseUrl}/pay/fake/${input.attemptId}?ref=${encodeURIComponent(input.bookingReference)}`,
    };
  }

  async checkPayment(reference: string): Promise<PaymentCheck> {
    // The fake checkout reports by callback only, so a check never knows more.
    return { status: "pending", amountPesewas: null, currency: null, providerFeePesewas: 0, providerReference: reference };
  }

  verifyCallback(rawBody: string, headers: Headers): VerifiedCallback | null {
    if (!signatureMatches(FAKE_PROVIDER_SECRET, rawBody, headers.get("x-paystack-signature"))) return null;
    const event = JSON.parse(rawBody) as { event: string; data: { id: string; reference: string } };
    const kind = event.event.startsWith("charge.") ? "charge" : event.event.startsWith("refund.") ? "refund" : "other";
    return { eventId: `${event.event}:${event.data.id}`, kind, reference: event.data.reference };
  }

  async refund(reference: string): Promise<RefundResult> {
    if (this.refundBehaviour === "unreachable") throw new PaymentProviderError("The fake provider did not respond", true);
    if (this.refundBehaviour === "refused") throw new PaymentProviderError("The fake provider cannot refund this payment", false);
    return { providerReference: `fake-refund-${reference}`, status: this.refundBehaviour };
  }

  async checkRefund(providerReference: string): Promise<RefundResult> {
    return { providerReference, status: this.refundCheckResult };
  }

  async listTransactions(from: Date, to: Date): Promise<ProviderTransaction[]> {
    return this.transactions.filter((t) => t.paidAt && t.paidAt >= from && t.paidAt < to);
  }

  async listSettlements(from: Date, to: Date) {
    const fromDay = from.toISOString().slice(0, 10);
    const toDay = to.toISOString().slice(0, 10);
    return this.settlements.filter((s) => s.settledOn >= fromDay && s.settledOn < toDay);
  }
}

/** The callback body the fake checkout sends, in Paystack's shape. */
export function fakeChargeEvent(attemptId: string, outcome: "success" | "failed", amountPesewas: number, currency: string) {
  return {
    event: outcome === "success" ? "charge.success" : "charge.failed",
    data: { id: `fake-${attemptId}-${outcome}`, reference: attemptId, status: outcome, amount: amountPesewas, currency, fees: 0 },
  };
}
