import "server-only";
import { env, isLive } from "@/lib/env";
import { ArkeselSmsProvider } from "./arkesel";
import { FakeSmsProvider } from "./fake";
import type { SmsProvider } from "./types";

let provider: SmsProvider | undefined;

export function smsProvider(): SmsProvider {
  if (!provider) {
    const e = env();
    if (e.SMS_PROVIDER === "arkesel") {
      if (!e.ARKESEL_API_KEY || !e.ARKESEL_SENDER_ID) {
        throw new Error("ARKESEL_API_KEY and ARKESEL_SENDER_ID are required when SMS_PROVIDER is arkesel");
      }
      provider = new ArkeselSmsProvider(e.ARKESEL_API_KEY, e.ARKESEL_SENDER_ID);
    } else {
      if (isLive(e)) throw new Error("The fake SMS provider cannot run on the live service");
      provider = new FakeSmsProvider();
    }
  }
  return provider;
}

export type { SmsProvider } from "./types";
