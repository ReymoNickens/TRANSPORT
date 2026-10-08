/**
 * Text-message provider interface (spec 17, 20.9). Booking and sign-in code
 * never talk to Arkesel directly; they use this interface, so another
 * provider can be added without touching them.
 */
export type SmsMessage = {
  /** E.164 phone number, for example +233241234567. */
  to: string;
  message: string;
};

export type SmsResult = {
  /** The provider's id for the message, kept for delivery tracking. */
  providerReference: string | null;
};

export interface SmsProvider {
  readonly name: string;
  send(message: SmsMessage): Promise<SmsResult>;
}

export class SmsSendError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "SmsSendError";
  }
}
