import type { Metadata } from "next";
import { Suspense } from "react";
import { Finance } from "@/components/ops/Finance";
import { OpsPage, OpsShell } from "@/components/ops/OpsShell";
import { Notice } from "@/components/ui";

export const metadata: Metadata = { title: "Finance" };

export default function Page() {
  return (
    <OpsPage title="Finance">
      <Suspense fallback={<Notice>Loading…</Notice>}>
        <OpsShell>{(can) => <Finance can={can} />}</OpsShell>
      </Suspense>
    </OpsPage>
  );
}
