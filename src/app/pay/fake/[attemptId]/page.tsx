import type { Metadata } from "next";
import { Suspense } from "react";
import { FakeCheckout } from "@/components/passenger/FakeCheckout";
import { Notice, Page } from "@/components/ui";

export const metadata: Metadata = { title: "Test payment" };

/** Stands in for Paystack's checkout in development and previews. The live service refuses it. */
export default function FakeCheckoutPage() {
  return (
    <Page title="Test payment">
      <Suspense fallback={<Notice>Loading…</Notice>}>
        <FakeCheckout />
      </Suspense>
    </Page>
  );
}
