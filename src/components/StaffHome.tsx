import { redirect } from "next/navigation";
import { currentActor } from "@/lib/auth/actor";
import { SignOutButton } from "./SignOutButton";
import { StaffJourneys } from "./staff/StaffJourneys";

/** The staff boarding app's home: the journeys this person works on. */
export async function StaffHome() {
  const signInPath = "/staff/sign-in";
  const actor = await currentActor();
  if (!actor || actor.kind !== "staff") redirect(signInPath);
  if (actor.assuranceLevel !== "aal2") redirect(signInPath);

  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-lg font-medium">Today</h2>
      <StaffJourneys />
      <SignOutButton redirectTo={signInPath} />
    </div>
  );
}
