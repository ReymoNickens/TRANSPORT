# Ghana Student Transport Platform

@AGENTS.md

A booking and operations platform for one transport organisation that owns
its buses, routes, seats and fares. Passengers book a real seat on a real
departure. It is **not a marketplace**.

## Read first

- `docs/spec/specification-v1.3.md`: the specification. "must" is a requirement.
- `docs/decisions.md`: business decisions D1–D34 and technical decisions T1–T9.
- `docs/PROGRESS.md`: what is built and what comes next. **Update it at the end of every session.**

## Stack

Next.js 16 (App Router) on Vercel · Supabase (Postgres + Auth) · Paystack · Arkesel SMS · Vitest.
One app serves three areas: passenger (`/`), staff boarding (`/staff`), operations (`/ops`).

## Layout

```
src/app/            pages and API route handlers (src/app/api/**/route.ts)
src/components/     UI components
src/lib/            server library: db, env, api (errors, handler), auth (actor, permissions)
src/domain/         pure business rules: state machines, pricing, refund policy (no I/O) [from phase B]
src/providers/      provider adapters behind interfaces: sms/ (fake, arkesel), payments/ (fake, paystack) [phase D]
supabase/migrations SQL migrations, applied in filename order
tests/db/           database integrity tests against a real Postgres
```

## Rules that must never be broken (spec section 27)

1. The server decides availability, price, payment state, ticket validity and permissions. The browser only displays.
2. Never store a status in two places; derive it. Never change a status outside its state machine function.
3. No provider-specific code (Paystack, Arkesel) in booking logic; use the interfaces in `src/providers`.
4. Never mutate seat layouts or fares used by existing bookings or journey snapshots.
5. Never delete financial, ticketing or audit records. People and vehicles are deactivated.
6. A payment page redirect or any client report is never proof of payment. Only a verified webhook or verify call is.
7. No raw database access as an API. Every endpoint is a business operation with its own permission check.

## How the code works

- **Database access.** All business queries go through `withOrganisation(context, tx => ...)` in `src/lib/db.ts`.
  It runs the transaction as role `app_runtime` with the organisation set, so row-level security enforces the
  organisation boundary. `db()` directly is only for pre-organisation platform lookups.
- **Tables** live in schema `app` (not exposed by Supabase's REST API). Follow the conventions at the top of
  `supabase/migrations/20261008065500_foundations.sql`: uuid v7 ids, bigint pesewas plus currency, timestamptz,
  `organisation_id` with composite foreign keys, the `org_boundary` policy, grants to `app_runtime`, audit triggers.
- **New migrations**: a new file `supabase/migrations/<yyyymmddhhmmss>_<name>.sql`. Never edit a migration that has been pushed. Every function sets `search_path = ''` and schema-qualifies names (Supabase advisor 0011). Run the Supabase security advisor after each migration.
- **State changes** use conditional updates (`where id = ? and state = <expected>`) and check the row count.
- **Endpoints** use `apiRoute` from `src/lib/api/handler.ts`: `{ data }` or `{ error: { code, message, correlationId } }`.
  Error codes come from `src/lib/api/errors.ts`; add new ones there. Validate every body with zod via `readJson`.
- **Permissions**: `requireActor()` then `requirePermission(actor, "code", scope?)`. Check a permission code, never a role name.
  High-risk permissions (`isHighRisk`) need a reason passed into `withOrganisation({ reason })`.
- **Money** is integer pesewas (`bigint` in SQL, integer `number` in TypeScript). Never floating point.
- **Time** is stored in UTC; service dates are dates in Africa/Accra.
- **Logs** use `log()` with the correlation id. Never log sign-in codes, QR tokens, secrets or full phone numbers.

## Commands

```
npm run dev        # app at http://localhost:3000 (needs .env.local, see README)
npm test           # unit tests
npm run test:db    # database tests (needs TEST_DATABASE_URL)
npm run check      # lint + typecheck + all tests: run before every commit
npm run build      # production build
```

## Working style

- Build in the vertical slices of spec section 26.1. Each slice is proven by tests before the next starts.
- Write the integrity test for a database invariant (spec 11.8, 24.2) together with the constraint, not after.
- Keep `docs/PROGRESS.md` and `docs/decisions.md` current. Record any assumption made about an open decision.
- Before a phase starts, list the decisions it depends on (spec 26, rule 5).
