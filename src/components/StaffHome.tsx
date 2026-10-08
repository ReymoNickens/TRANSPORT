import { redirect } from "next/navigation";
import { currentActor } from "@/lib/auth/actor";
import { SignOutButton } from "./SignOutButton";
import { Notice } from "./ui";

/**
 * What a signed-in staff member may do. The operational screens arrive in
 * later phases; this proves sign-in, the second factor and permissions end to end.
 */
export async function StaffHome({ area }: { area: "staff" | "ops" }) {
  const signInPath = `/${area}/sign-in`;
  const actor = await currentActor();
  if (!actor || actor.kind !== "staff") redirect(signInPath);
  if (actor.assuranceLevel !== "aal2") redirect(signInPath);

  const permissions = [...new Set(actor.grants.map((grant) => grant.code))].sort();
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
