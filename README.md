# Ghana Student Transport Platform

Booking and operations for a student transport organisation in Ghana:
passengers search, choose stops and a seat, pay with mobile money or card,
and board with a QR ticket. Staff scan tickets; managers run journeys,
vehicles, refunds and reconciliation.

- What the product must do: [`docs/spec/specification-v1.3.md`](docs/spec/specification-v1.3.md)
- Where the build is: [`docs/PROGRESS.md`](docs/PROGRESS.md)
- Decisions and defaults: [`docs/decisions.md`](docs/decisions.md)

**Stack:** Next.js 16 on Vercel · Supabase (Postgres + Auth) · Paystack · Arkesel SMS

## Running it locally

You need Node 22+ and Docker (for the local Supabase stack).

```bash
npm install
cp .env.example .env.local
npx supabase start          # local Postgres + Auth; prints the URLs and keys
npx supabase db reset       # applies migrations and supabase/seed.sql
```

Put the printed **API URL** and **publishable key** into `.env.local`, then:

```bash
npm run dev
```

Open http://localhost:3000. With `SMS_PROVIDER=fake`, sign-in codes are
printed in the terminal running `npm run dev` instead of being texted.

Local Supabase calls the Send-SMS hook at `host.docker.internal:3000`, so
`npm run dev` must be running when you request a code.

### Making a staff account (local)

Staff are never self-registered. Until the staff screens exist (phase E),
create one in Supabase Studio (http://127.0.0.1:54323) → Authentication →
Add user (email + password), then run in the SQL editor:

```sql
with org as (select id from app.organisations where slug = 'pilot'),
u as (
  insert into app.users (organisation_id, auth_user_id, kind, full_name, email)
  select org.id, au.id, 'staff', 'Your Name', au.email
  from org, auth.users au where au.email = 'you@example.com'
  returning id, organisation_id
)
insert into app.user_roles (organisation_id, user_id, role_id, scope_type)
select u.organisation_id, u.id, r.id, 'organisation'
from u join app.roles r on r.organisation_id = u.organisation_id and r.name = 'Administrator';
```

Sign in at http://localhost:3000/ops/sign-in. The first sign-in sets up an
authenticator app.

## Tests

```bash
npm test                    # unit tests
npm run test:db             # database integrity tests
npm run check               # lint + typecheck + all tests
```

### Running the database tests

They build a fresh `transport_test` database from the migrations on any
Postgres server. Point `TEST_DATABASE_URL` at it, for example the local
Supabase database:

```bash
TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npm run test:db
```

CI runs them on every push.

## Hosted environments

| Service | Name | Notes |
|---|---|---|
| Supabase | project `transport` (ref `wrspeyuvmyxmjhvsnbrt`), London (eu-west-2) | Migrations applied; organisation `pilot` created |
| Vercel | project `transport` (team "reymonickens' projects") | Linked to this repo; every push deploys |

### How the app logs in to the database

The app never uses the Supabase `postgres` admin password. It logs in as
`app_api`, a role that can do nothing except switch to `app_runtime`, the
restricted role every business transaction runs as (decision T5). It
cannot bypass row-level security.

`DATABASE_URL` is the Supabase **Transaction pooler** connection string
(Supabase → Connect → Transaction pooler) with the user changed from
`postgres.<ref>` to `app_api.<ref>` and the `app_api` password filled in.

To rotate the password, run in the Supabase SQL editor
`alter role app_api password '<new password>';` and update `DATABASE_URL`
in Vercel.

### Applying new migrations to Supabase

`npx supabase link --project-ref wrspeyuvmyxmjhvsnbrt` once, then
`npx supabase db push`. (Claude can also apply them through the Supabase
connector; it then renames the local file to the version Supabase recorded.)

### Still to switch on (Supabase dashboard)

- Authentication → Sign In / Providers → **Phone**: enable; code length 6, expiry 600 seconds (spec 19.1).
- Authentication → Hooks → **Send SMS hook**: HTTPS, URL `https://<vercel-domain>/api/hooks/send-sms`;
  generate the secret and put it in Vercel as `SEND_SMS_HOOK_SECRET`.
- Authentication → Multi-factor: **TOTP** enabled.
- Arkesel: put `ARKESEL_API_KEY`, `ARKESEL_SENDER_ID` in Vercel and set `SMS_PROVIDER=arkesel`.
