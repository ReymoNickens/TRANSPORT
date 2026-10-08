import type { Metadata } from "next";
import { Suspense } from "react";
import { StaffHome } from "@/components/StaffHome";
import { Notice, Page } from "@/components/ui";

export const metadata: Metadata = { title: "Staff boarding" };

export default function StaffPage() {
  return (
    <Page title="Staff boarding">
      <Suspense fallback={<Notice>Loading…</Notice>}>
        <StaffHome />
      </Suspense>
    </Page>
  );
}
