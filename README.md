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

## Deploying (later, when we go live)

1. **Supabase**: create a project, then `npx supabase link` and `npx supabase db push`.
   - Authentication → Hooks → Send SMS: HTTPS hook to `https://<your-domain>/api/hooks/send-sms`; copy its secret into `SEND_SMS_HOOK_SECRET`.
   - Authentication → Providers → Phone: enable; set the code expiry to 600 seconds and the length to 6 (spec 19.1).
   - Authentication → Multi-factor: enable TOTP.
   - Run `select app.create_organisation('<Name>', '<slug>');` once in the SQL editor.
2. **Vercel**: import the GitHub repo and add the environment variables from `.env.example`.
   `DATABASE_URL` is the Supabase **transaction pooler** connection string.
3. **Arkesel**: an API key and an approved sender ID. Set `SMS_PROVIDER=arkesel`.
