/**
 * Payment provider interface (spec 13.2). Booking logic only ever talks to
 * this; Paystack details stay in paystack.ts. A provider's own fields never
 * leak into booking code.
 *
 * The fifth operation of 13.2, the settlement report, arrives with
 * reconciliation in phase F.
 */

/** Our normalised view of a provider's status (13.2a mapping). */
export type PaymentStatus = "success" | "failed" | "pending" | "reversed";

export type StartPaymentInput = {
  /** Our attempt id, sent as the provider's unique reference. */
  attemptId: string;
  amountPesewas: number;
  currency: string;
  /** The passenger's email, or the non-receiving placeholder of D30. */
  email: string;
  phone: string;
  bookingReference: string;
  method: "mobile_money" | "card" | "any";
  /** Where the provider sends the passenger back. Proves nothing (12.6). */
  returnUrl: string;
};

export type StartPaymentResult = {
  providerReference: string;
  checkoutUrl: string;
};

export type PaymentCheck = {
  status: PaymentStatus;
  amountPesewas: number | null;
  currency: string | null;
  providerFeePesewas: number;
  providerReference: string | null;
};

export type VerifiedCallback = {
  /** Unique per provider event, for the webhook inbox. */
  eventId: string;
  kind: "charge" | "refund" | "transfer" | "other";
  /** Our attempt id, for charge events. */
  reference: string | null;
};

export type RefundResult = { providerReference: string | null; status: "pending" | "processed" | "failed" };

export interface PaymentProvider {
  readonly name: "fake" | "paystack";
  startPayment(input: StartPaymentInput): Promise<StartPaymentResult>;
  /** Asks the provider for the current status of an attempt (12.2). */
  checkPayment(reference: string): Promise<PaymentCheck>;
  /** Proves a callback is genuine (13.2a); null when the signature is wrong. */
  verifyCallback(rawBody: string, headers: Headers): VerifiedCallback | null;
  refund(reference: string, amountPesewas: number): Promise<RefundResult>;
}

/** A call to the provider failed. Retryable failures are never treated as a failed payment (13.2a rule 5). */
export class PaymentProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "PaymentProviderError";
  }
}
