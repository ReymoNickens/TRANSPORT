import { redirect } from "next/navigation";
import { currentActor } from "@/lib/auth/actor";
import { SignOutButton } from "./SignOutButton";
import { StaffJourneys } from "./staff/StaffJourneys";
import { Notice } from "./ui";

/**
 * The signed-in staff member's home. In the staff boarding app it lists the
 * journeys they work on; the operations screens arrive in a later slice.
 */
export async function StaffHome({ area }: { area: "staff" | "ops" }) {
  const signInPath = `/${area}/sign-in`;
  const actor = await currentActor();
  if (!actor || actor.kind !== "staff") redirect(signInPath);
  if (actor.assuranceLevel !== "aal2") redirect(signInPath);

  const permissions = [...new Set(actor.grants.map((grant) => grant.code))].sort();
  if (area === "staff") {
    return (
      <div className="flex flex-col gap-4">
        <h2 className="text-lg font-medium">Today</h2>
        <StaffJourneys />
        <SignOutButton redirectTo={signInPath} />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <Notice>You are signed in with your second factor.</Notice>
      <section className="rounded-lg border border-border p-4">
        <h2 className="mb-2 font-medium">What you can do</h2>
        {permissions.length ? (
          <ul className="list-disc pl-5 text-sm text-muted">
            {permissions.map((code) => <li key={code}>{code}</li>)}
          </ul>
        ) : (
          <Notice>No roles are assigned to you yet. Ask an administrator.</Notice>
        )}
      </section>
      <SignOutButton redirectTo={signInPath} />
    </div>
  );
}
