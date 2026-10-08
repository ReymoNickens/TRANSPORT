import type { Metadata } from "next";
import { Suspense } from "react";
import { NewDeparture } from "@/components/ops/NewDeparture";
import { OpsPage, OpsShell } from "@/components/ops/OpsShell";
import { Notice } from "@/components/ui";

export const metadata: Metadata = { title: "Create a departure" };

export default function Page() {
  return (
    <OpsPage title="Create a departure">
      <Suspense fallback={<Notice>Loading…</Notice>}>
        <OpsShell>{() => <NewDeparture />}</OpsShell>
      </Suspense>
    </OpsPage>
  );
}
