/**
 * Payment provider interface (spec 13.2). Booking logic only ever talks to
 * this; Paystack details stay in paystack.ts. A provider's own fields never
 * leak into booking code.
 *
 * The settlement report of 13.2 is listTransactions and listSettlements.
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

/** One of the provider's own transaction records, for daily reconciliation (18.4a). */
export type ProviderTransaction = {
  /** The reference we sent: our payment attempt id. */
  reference: string;
  status: PaymentStatus;
  amountPesewas: number;
  currency: string;
  feePesewas: number;
  channel: string | null;
  paidAt: Date | null;
  /** The provider's settlement this transaction was paid out in, if any. */
  settlementId: string | null;
  raw: unknown;
};

/** A payout from the provider to the organisation's bank (18.4a step 5). */
export type ProviderSettlement = {
  id: string;
  /** YYYY-MM-DD, the day the money reached the bank. */
  settledOn: string;
  currency: string;
  grossPesewas: number;
  feesPesewas: number;
  refundsPesewas: number;
  netPesewas: number;
  raw: unknown;
};

export interface PaymentProvider {
  readonly name: "fake" | "paystack";
  startPayment(input: StartPaymentInput): Promise<StartPaymentResult>;
  /** Asks the provider for the current status of an attempt (12.2). */
  checkPayment(reference: string): Promise<PaymentCheck>;
  /** Proves a callback is genuine (13.2a); null when the signature is wrong. */
  verifyCallback(rawBody: string, headers: Headers): VerifiedCallback | null;
  /** Asks the provider to return money for a charge (16.4a route paystack_refund). A non-retryable error means refused. */
  refund(reference: string, amountPesewas: number): Promise<RefundResult>;
  /** Asks the provider how a refund it accepted is going. */
  checkRefund(providerReference: string): Promise<RefundResult>;
  /** The provider's transactions between two times (the settlement report of 13.2). */
  listTransactions(from: Date, to: Date): Promise<ProviderTransaction[]>;
  /** The provider's settlements paid between two times, with the transactions each one paid out. */
  listSettlements(from: Date, to: Date): Promise<(ProviderSettlement & { transactionReferences: string[] })[]>;
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
