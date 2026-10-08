import { SmsSendError, type SmsMessage, type SmsProvider, type SmsResult } from "./types";

const ENDPOINT = "https://sms.arkesel.com/api/v2/sms/send";

/** Arkesel SMS API v2. Recipients are sent as 233XXXXXXXXX. */
export class ArkeselSmsProvider implements SmsProvider {
  readonly name = "arkesel";

  constructor(
    private readonly apiKey: string,
    private readonly senderId: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send({ to, message }: SmsMessage): Promise<SmsResult> {
    let response: Response;
    try {
      response = await this.fetchImpl(ENDPOINT, {
        method: "POST",
        headers: { "api-key": this.apiKey, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ sender: this.senderId, message, recipients: [to.replace(/^\+/, "")] }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new SmsSendError("Arkesel did not respond", true);
    }

    const body = (await response.json().catch(() => null)) as
      | { status?: string; message?: string; data?: { id?: string }[] }
      | null;

    if (!response.ok || body?.status !== "success") {
      // 5xx and rate limits are worth retrying; other failures (bad number, no credit) are not.
      const retryable = response.status >= 500 || response.status === 429;
      throw new SmsSendError(`Arkesel refused the message (HTTP ${response.status}: ${body?.message ?? "no message"})`, retryable);
    }
    return { providerReference: body.data?.[0]?.id ?? null };
  }
}
