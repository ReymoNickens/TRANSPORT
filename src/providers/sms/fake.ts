import type { SmsMessage, SmsProvider, SmsResult } from "./types";

/**
 * Development and test provider. Keeps messages in memory and prints them
 * to the server console so a developer can read sign-in codes locally.
 * The environment check refuses it in production.
 */
export class FakeSmsProvider implements SmsProvider {
  readonly name = "fake";
  readonly sent: SmsMessage[] = [];

  async send(message: SmsMessage): Promise<SmsResult> {
    this.sent.push(message);
    if (process.env.NODE_ENV === "development") {
      console.log(`[fake sms] to ${message.to}: ${message.message}`);
    }
    return { providerReference: `fake-${this.sent.length}` };
  }
}
