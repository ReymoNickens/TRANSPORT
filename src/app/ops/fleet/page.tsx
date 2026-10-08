import type { Metadata } from "next";
import { Suspense } from "react";
import { BusList } from "@/components/ops/Fleet";
import { OpsPage, OpsShell } from "@/components/ops/OpsShell";
import { Notice } from "@/components/ui";

export const metadata: Metadata = { title: "Buses" };

export default function Page() {
  return (
    <OpsPage title="Buses">
      <Suspense fallback={<Notice>Loading…</Notice>}>
        <OpsShell>{() => <BusList />}</OpsShell>
      </Suspense>
    </OpsPage>
  );
}
