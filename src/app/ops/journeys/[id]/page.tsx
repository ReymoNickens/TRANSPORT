import type { Metadata } from "next";
import { Suspense } from "react";
import { JourneyDetail } from "@/components/ops/JourneyDetail";
import { OpsPage, OpsShell } from "@/components/ops/OpsShell";
import { Notice } from "@/components/ui";

export const metadata: Metadata = { title: "Departure" };

export default function Page() {
  return (
    <OpsPage>
      <Suspense fallback={<Notice>Loading…</Notice>}>
        <OpsShell>{(can) => <JourneyDetail can={can} />}</OpsShell>
      </Suspense>
    </OpsPage>
  );
}
