import type { Metadata } from "next";
import { Suspense } from "react";
import { RefundQueue } from "@/components/ops/Refunds";
import { OpsPage, OpsShell } from "@/components/ops/OpsShell";
import { Notice } from "@/components/ui";

export const metadata: Metadata = { title: "Refunds" };

export default function Page() {
  return (
    <OpsPage title="Refunds">
      <Suspense fallback={<Notice>Loading…</Notice>}>
        <OpsShell>{(can) => <RefundQueue can={can} />}</OpsShell>
      </Suspense>
    </OpsPage>
  );
}
