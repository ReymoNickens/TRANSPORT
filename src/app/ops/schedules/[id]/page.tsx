import type { Metadata } from "next";
import { Suspense } from "react";
import { ScheduleDetail } from "@/components/ops/Schedules";
import { OpsPage, OpsShell } from "@/components/ops/OpsShell";
import { Notice } from "@/components/ui";

export const metadata: Metadata = { title: "Schedule" };

export default function Page() {
  return (
    <OpsPage>
      <Suspense fallback={<Notice>Loading…</Notice>}>
        <OpsShell>{() => <ScheduleDetail />}</OpsShell>
      </Suspense>
    </OpsPage>
  );
}
