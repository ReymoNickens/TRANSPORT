import type { Metadata } from "next";
import { Suspense } from "react";
import { SeatPicker } from "@/components/passenger/SeatPicker";
import { Notice, Page } from "@/components/ui";

export const metadata: Metadata = { title: "Choose seats" };

export default function JourneyPage() {
  return (
    <Page title="Choose your seats">
      <Suspense fallback={<Notice>Loading the bus…</Notice>}>
        <SeatPicker />
      </Suspense>
    </Page>
  );
}
