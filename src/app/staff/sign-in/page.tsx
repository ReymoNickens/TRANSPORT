import type { Metadata } from "next";
import { StaffSignIn } from "@/components/StaffSignIn";
import { Page } from "@/components/ui";

export const metadata: Metadata = { title: "Staff boarding sign-in" };

export default function StaffSignInPage() {
  return (
    <Page title="Staff boarding">
      <StaffSignIn next="/staff" />
    </Page>
  );
}
