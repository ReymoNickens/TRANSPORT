import {
  PaymentProviderError,
  type PaymentCheck,
  type PaymentProvider,
  type PaymentStatus,
  type RefundResult,
  type StartPaymentInput,
  type StartPaymentResult,
  type VerifiedCallback,
} from "./types";
import { signatureMatches } from "./signature";

const API = "https://api.paystack.co";

/**
 * Paystack (D11, D29, spec 13.2a). Hosted checkout: the passenger pays on
 * Paystack's page, so card details and mobile money prompts never touch our
 * servers. The exact status words are confirmed by the contract test
 * against Paystack's test mode before the first live payment (24.8).
 */
export class PaystackProvider implements PaymentProvider {
  readonly name = "paystack" as const;

  constructor(
    private readonly secretKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async startPayment(input: StartPaymentInput): Promise<StartPaymentResult> {
    const body = await this.call<{ authorization_url: string; reference: string }>("POST", "/transaction/initialize", {
      email: input.email,
      // Paystack's smallest unit for GHS is the pesewa, our stored unit.
      amount: input.amountPesewas,
      currency: input.currency,
      reference: input.attemptId,
      callback_url: input.returnUrl,
      channels: input.method === "card" ? ["card"] : input.method === "mobile_money" ? ["mobile_money"] : ["mobile_money", "card"],
      // Only the booking reference: no personal data in metadata.
      metadata: { booking_reference: input.bookingReference },
    });
    return { providerReference: body.reference, checkoutUrl: body.authorization_url };
  }

  async checkPayment(reference: string): Promise<PaymentCheck> {
    const data = await this.call<{ status: string; amount: number; currency: string; fees: number | null; reference: string }>(
      "GET",
      `/transaction/verify/${encodeURIComponent(reference)}`,
    );
    return {
      status: mapStatus(data.status),
      amountPesewas: typeof data.amount === "number" ? data.amount : null,
      currency: data.currency ?? null,
      providerFeePesewas: typeof data.fees === "number" ? data.fees : 0,
      providerReference: data.reference ?? null,
    };
  }

  verifyCallback(rawBody: string, headers: Headers): VerifiedCallback | null {
    if (!signatureMatches(this.secretKey, rawBody, headers.get("x-paystack-signature"))) return null;
    let event: { event?: string; data?: { id?: number | string; reference?: string } };
    try {
      event = JSON.parse(rawBody);
    } catch {
      return null;
    }
    const name = event.event ?? "unknown";
    const kind = name.startsWith("charge.") ? "charge" : name.startsWith("refund.") ? "refund" : name.startsWith("transfer.") ? "transfer" : "other";
    return {
      eventId: `${name}:${event.data?.id ?? event.data?.reference ?? "none"}`,
      kind,
      reference: event.data?.reference ?? null,
    };
  }

  async refund(reference: string, amountPesewas: number): Promise<RefundResult> {
    const data = await this.call<{ status?: string; id?: number }>("POST", "/refund", { transaction: reference, amount: amountPesewas });
    return {
      providerReference: data.id != null ? String(data.id) : null,
      status: data.status === "processed" ? "processed" : data.status === "failed" ? "failed" : "pending",
    };
  }

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${API}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.secretKey}`, "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new PaymentProviderError("Paystack did not respond", true);
    }
    const json = (await response.json().catch(() => null)) as { status?: boolean; message?: string; data?: T } | null;
    if (!response.ok || !json?.status || json.data === undefined) {
      throw new PaymentProviderError(
        `Paystack refused the request (HTTP ${response.status}: ${json?.message ?? "no message"})`,
        response.status >= 500 || response.status === 429,
      );
    }
    return json.data;
  }
}

/** Paystack status → ours. An unknown status never confirms a booking (13.2a). */
export function mapStatus(status: string | undefined): PaymentStatus {
  switch (status) {
    case "success":
      return "success";
    case "failed":
      return "failed";
    case "reversed":
      return "reversed";
    default:
      // abandoned, ongoing, pending, processing, queued and anything new stay pending.
      return "pending";
  }
}
