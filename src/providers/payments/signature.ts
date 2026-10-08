import { createHmac, timingSafeEqual } from "node:crypto";

/** HMAC-SHA512 of the raw body, as Paystack signs webhooks. */
export function signBody(secret: string, rawBody: string): string {
  return createHmac("sha512", secret).update(rawBody, "utf8").digest("hex");
}

/** Constant-time comparison of a hex signature (13.2a). */
export function signatureMatches(secret: string, rawBody: string, given: string | null): boolean {
  if (!given || !/^[0-9a-f]+$/i.test(given)) return false;
  const expected = Buffer.from(signBody(secret, rawBody), "hex");
  const actual = Buffer.from(given, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
