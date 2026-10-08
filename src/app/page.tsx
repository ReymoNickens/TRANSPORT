import Link from "next/link";

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-8 px-4 py-10">
      <div className="flex flex-col gap-3">
        <h1 className="text-4xl font-semibold tracking-tight">Book a real seat on a real bus.</h1>
        <p className="text-muted">
          Online booking for our first route is being prepared. Sign in now and you&apos;ll be ready when seats go on sale.
        </p>
      </div>
      <Link href="/sign-in" className="flex h-12 items-center justify-center rounded-lg bg-accent font-medium text-accent-foreground">
        Sign in with your phone
      </Link>
      <nav className="flex gap-4 text-sm text-muted">
        <Link href="/staff" className="underline">Staff boarding</Link>
        <Link href="/ops" className="underline">Operations</Link>
      </nav>
    </main>
  );
}
