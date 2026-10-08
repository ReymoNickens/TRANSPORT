import type { Metadata } from "next";
import { Suspense } from "react";
import { BookingDetail } from "@/components/ops/BookingDetail";
import { OpsPage, OpsShell } from "@/components/ops/OpsShell";
import { Notice } from "@/components/ui";

export const metadata: Metadata = { title: "Booking" };

export default function Page() {
  return (
    <OpsPage>
      <Suspense fallback={<Notice>Loading…</Notice>}>
        <OpsShell>{() => <BookingDetail />}</OpsShell>
      </Suspense>
    </OpsPage>
  );
}
