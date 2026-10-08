import type { Metadata } from "next";
import { Suspense } from "react";
import { RouteDetail } from "@/components/ops/Routes";
import { OpsPage, OpsShell } from "@/components/ops/OpsShell";
import { Notice } from "@/components/ui";

export const metadata: Metadata = { title: "Route" };

export default function Page() {
  return (
    <OpsPage>
      <Suspense fallback={<Notice>Loading…</Notice>}>
        <OpsShell>{(can) => <RouteDetail can={can} />}</OpsShell>
      </Suspense>
    </OpsPage>
  );
}
