import { beforeAll, describe, expect, it, vi } from "vitest";
import { Webhook } from "standardwebhooks";

const secret = "v1,whsec_" + Buffer.from("a-test-secret-of-enough-length!!").toString("base64");

beforeAll(() => {
  vi.stubEnv("DATABASE_URL", "postgres://localhost/unused");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost:54321");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
  vi.stubEnv("SEND_SMS_HOOK_SECRET", secret);
  vi.stubEnv("SMS_PROVIDER", "fake");
});

async function call(payload: unknown, sign = true) {
  const { POST } = await import("./route");
  const body = JSON.stringify(payload);
  const id = "msg_test";
  const timestamp = new Date();
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "webhook-id": id,
    "webhook-timestamp": Math.floor(timestamp.getTime() / 1000).toString(),
  };
  headers["webhook-signature"] = sign ? new Webhook(secret.replace("v1,whsec_", "")).sign(id, timestamp, body) : "v1,bad";
  return POST(new Request("https://example.test/api/hooks/send-sms", { method: "POST", headers, body }));
}

describe("Supabase send-SMS hook", () => {
  it("sends the code to a Ghana number through the SMS provider", async () => {
    const { smsProvider } = await import("@/providers/sms");
    const fake = smsProvider() as unknown as { sent: { to: string; message: string }[] };
    const response = await call({ user: { phone: "233241234567" }, sms: { otp: "123456" } });
    expect(response.status).toBe(200);
    expect(fake.sent.at(-1)).toMatchObject({ to: "+233241234567" });
    expect(fake.sent.at(-1)?.message).toContain("123456");
  });

  it("refuses an unsigned request", async () => {
    const response = await call({ user: { phone: "233241234567" }, sms: { otp: "123456" } }, false);
    expect(response.status).toBe(401);
  });

  it("refuses a non-Ghana number", async () => {
    const response = await call({ user: { phone: "447700900123" }, sms: { otp: "123456" } });
    expect(response.status).toBe(400);
  });
});
