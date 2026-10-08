import type { Metadata } from "next";
import { Suspense } from "react";
import { NewRoute } from "@/components/ops/NewRoute";
import { OpsPage, OpsShell } from "@/components/ops/OpsShell";
import { Notice } from "@/components/ui";

export const metadata: Metadata = { title: "Create a route" };

export default function Page() {
  return (
    <OpsPage title="Create a route">
      <Suspense fallback={<Notice>Loading…</Notice>}>
        <OpsShell>{() => <NewRoute />}</OpsShell>
      </Suspense>
    </OpsPage>
  );
}
