import "server-only";
import { env, isLive } from "@/lib/env";
import { FakePaymentProvider } from "./fake";
import { PaystackProvider } from "./paystack";
import type { PaymentProvider } from "./types";

let provider: PaymentProvider | undefined;

export function paymentProvider(): PaymentProvider {
  if (!provider) {
    const e = env();
    if (e.PAYMENT_PROVIDER === "paystack") {
      if (!e.PAYSTACK_SECRET_KEY) throw new Error("PAYSTACK_SECRET_KEY is required when PAYMENT_PROVIDER is paystack");
      provider = new PaystackProvider(e.PAYSTACK_SECRET_KEY);
    } else {
      if (isLive(e)) throw new Error("The fake payment provider cannot run on the live service");
      provider = new FakePaymentProvider(e.APP_BASE_URL);
    }
  }
  return provider;
}

/** For tests: use a specific provider. */
export function setPaymentProviderForTests(p: PaymentProvider | undefined) {
  provider = p;
}

export type { PaymentProvider } from "./types";
