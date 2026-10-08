// The services read the server environment; give the database tests a complete, fake one.
process.env.DATABASE_URL ??= "postgres://unused.invalid/unused";
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://127.0.0.1:54321";
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??= "sb_publishable_test";
process.env.TICKET_TOKEN_SECRET ??= "test-ticket-secret-that-is-long-enough-0123456789";
process.env.APP_BASE_URL ??= "https://transport.test";
