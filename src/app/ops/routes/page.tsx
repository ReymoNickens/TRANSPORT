import type { Metadata } from "next";
import { Suspense } from "react";
import { RouteList } from "@/components/ops/Routes";
import { OpsPage, OpsShell } from "@/components/ops/OpsShell";
import { Notice } from "@/components/ui";

export const metadata: Metadata = { title: "Routes" };

export default function Page() {
  return (
    <OpsPage title="Routes">
      <Suspense fallback={<Notice>Loading…</Notice>}>
        <OpsShell>{() => <RouteList />}</OpsShell>
      </Suspense>
    </OpsPage>
  );
}
