import { describe, expect, it, vi } from "vitest";
import { ArkeselSmsProvider } from "./arkesel";
import { SmsSendError } from "./types";

describe("ArkeselSmsProvider", () => {
  it("sends to Arkesel's v2 API with the number in 233 form", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ status: "success", data: [{ recipient: "233241234567", id: "msg-1" }] }));
    const provider = new ArkeselSmsProvider("key-123", "TRANSPORT", fetchImpl as unknown as typeof fetch);

    const result = await provider.send({ to: "+233241234567", message: "Hello" });

    expect(result.providerReference).toBe("msg-1");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://sms.arkesel.com/api/v2/sms/send");
    expect((init.headers as Record<string, string>)["api-key"]).toBe("key-123");
    expect(JSON.parse(init.body as string)).toEqual({ sender: "TRANSPORT", message: "Hello", recipients: ["233241234567"] });
  });

  it("marks server errors as retryable and client errors as not", async () => {
    const server = new ArkeselSmsProvider("k", "S", (async () => new Response("down", { status: 503 })) as unknown as typeof fetch);
    await expect(server.send({ to: "+233241234567", message: "x" })).rejects.toMatchObject({ retryable: true });

    const client = new ArkeselSmsProvider(
      "k",
      "S",
      (async () => Response.json({ status: "error", message: "Insufficient balance" }, { status: 422 })) as unknown as typeof fetch,
    );
    await expect(client.send({ to: "+233241234567", message: "x" })).rejects.toBeInstanceOf(SmsSendError);
    await expect(client.send({ to: "+233241234567", message: "x" })).rejects.toMatchObject({ retryable: false });
  });

  it("treats a network failure as retryable", async () => {
    const provider = new ArkeselSmsProvider("k", "S", (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch);
    await expect(provider.send({ to: "+233241234567", message: "x" })).rejects.toMatchObject({ retryable: true });
  });
});
