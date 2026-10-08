import type { Metadata } from "next";
import { Suspense } from "react";
import { BookingLookup } from "@/components/ops/BookingLookup";
import { OpsPage, OpsShell } from "@/components/ops/OpsShell";
import { Notice } from "@/components/ui";

export const metadata: Metadata = { title: "Look up a booking" };

export default function Page() {
  return (
    <OpsPage title="Look up a booking">
      <Suspense fallback={<Notice>Loading…</Notice>}>
        <OpsShell>{() => <BookingLookup />}</OpsShell>
      </Suspense>
    </OpsPage>
  );
}
