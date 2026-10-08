import type { Metadata } from "next";
import { Suspense } from "react";
import { NewBus } from "@/components/ops/Fleet";
import { OpsPage, OpsShell } from "@/components/ops/OpsShell";
import { Notice } from "@/components/ui";

export const metadata: Metadata = { title: "Add a bus" };

export default function Page() {
  return (
    <OpsPage title="Add a bus">
      <Suspense fallback={<Notice>Loading…</Notice>}>
        <OpsShell>{() => <NewBus />}</OpsShell>
      </Suspense>
    </OpsPage>
  );
}
