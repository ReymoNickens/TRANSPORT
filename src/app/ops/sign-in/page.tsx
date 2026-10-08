import type { Metadata } from "next";
import { StaffSignIn } from "@/components/StaffSignIn";
import { Page } from "@/components/ui";

export const metadata: Metadata = { title: "Operations sign-in" };

export default function OpsSignInPage() {
  return (
    <Page title="Operations">
      <StaffSignIn next="/ops" />
    </Page>
  );
}
