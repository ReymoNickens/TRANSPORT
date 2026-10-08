import "server-only";
import { env } from "@/lib/env";
import { ArkeselSmsProvider } from "./arkesel";
import { FakeSmsProvider } from "./fake";
import type { SmsProvider } from "./types";

let provider: SmsProvider | undefined;

export function smsProvider(): SmsProvider {
  if (!provider) {
    const e = env();
    provider =
      e.SMS_PROVIDER === "arkesel"
        ? new ArkeselSmsProvider(e.ARKESEL_API_KEY!, e.ARKESEL_SENDER_ID!)
        : new FakeSmsProvider();
  }
  return provider;
}

export type { SmsProvider } from "./types";
