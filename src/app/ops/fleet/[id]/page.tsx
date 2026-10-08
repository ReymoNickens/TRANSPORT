import type { Metadata } from "next";
import { Suspense } from "react";
import { BusDetail } from "@/components/ops/Fleet";
import { OpsPage, OpsShell } from "@/components/ops/OpsShell";
import { Notice } from "@/components/ui";

export const metadata: Metadata = { title: "Bus" };

export default function Page() {
  return (
    <OpsPage>
      <Suspense fallback={<Notice>Loading…</Notice>}>
        <OpsShell>{() => <BusDetail />}</OpsShell>
      </Suspense>
    </OpsPage>
  );
}
