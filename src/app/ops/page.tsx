import type { Metadata } from "next";
import { Suspense } from "react";
import { StaffHome } from "@/components/StaffHome";
import { Notice, Page } from "@/components/ui";

export const metadata: Metadata = { title: "Operations" };

export default function OpsPage() {
  return (
    <Page title="Operations">
      <Suspense fallback={<Notice>Loading…</Notice>}>
        <StaffHome area="ops" />
      </Suspense>
    </Page>
  );
}
