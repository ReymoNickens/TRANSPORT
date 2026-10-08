import type { Metadata } from "next";
import { Suspense } from "react";
import { ScheduleList } from "@/components/ops/Schedules";
import { OpsPage, OpsShell } from "@/components/ops/OpsShell";
import { Notice } from "@/components/ui";

export const metadata: Metadata = { title: "Schedules" };

export default function Page() {
  return (
    <OpsPage title="Schedules">
      <Suspense fallback={<Notice>Loading…</Notice>}>
        <OpsShell>{() => <ScheduleList />}</OpsShell>
      </Suspense>
    </OpsPage>
  );
}
