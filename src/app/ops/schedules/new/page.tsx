import type { Metadata } from "next";
import { Suspense } from "react";
import { NewSchedule } from "@/components/ops/Schedules";
import { OpsPage, OpsShell } from "@/components/ops/OpsShell";
import { Notice } from "@/components/ui";

export const metadata: Metadata = { title: "Create a schedule" };

export default function Page() {
  return (
    <OpsPage title="Create a schedule">
      <Suspense fallback={<Notice>Loading…</Notice>}>
        <OpsShell>{() => <NewSchedule />}</OpsShell>
      </Suspense>
    </OpsPage>
  );
}
