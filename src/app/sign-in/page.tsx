import type { Metadata } from "next";
import { PhoneSignIn } from "@/components/PhoneSignIn";
import { Page } from "@/components/ui";

export const metadata: Metadata = { title: "Sign in" };

export default function SignInPage() {
  return (
    <Page title="Sign in">
      <PhoneSignIn />
    </Page>
  );
}
