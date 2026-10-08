// Writes supabase/manual/pending-supabase-changes.sql: every migration newer than
// the last one applied on Supabase, in one transaction, recorded in Supabase's
// migration history. Usage: node scripts/pending-sql.mjs <last applied version>
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const appliedUpTo = process.argv[2];
if (!/^\d{14}$/.test(appliedUpTo ?? "")) {
  console.error("Usage: node scripts/pending-sql.mjs <last applied version, e.g. 20261008075326>");
  process.exit(1);
}
const dir = "supabase/migrations";
const files = readdirSync(dir).filter((f) => f.endsWith(".sql") && f.slice(0, 14) > appliedUpTo).sort();
const name = (f) => f.slice(15, -4);
const parts = [
  `-- Run this once in Supabase → project "transport" → SQL Editor → Run.
-- It applies every database change not yet on Supabase, in order, in one
-- transaction: all of it applies, or none of it. It also records each change in
-- Supabase's migration history so later updates line up.
-- Included: ${files.map(name).join(", ")}

begin;
`,
];
for (const f of files) {
  parts.push(`\n-- ====================================================================\n-- ${f}\n-- ====================================================================\n`);
  parts.push(readFileSync(`${dir}/${f}`, "utf8"));
}
parts.push(`\ninsert into supabase_migrations.schema_migrations (version, name) values\n`);
parts.push(files.map((f) => `  ('${f.slice(0, 14)}', '${name(f)}')`).join(",\n"));
parts.push(`\non conflict (version) do nothing;\n\ncommit;\n`);
writeFileSync("supabase/manual/pending-supabase-changes.sql", parts.join(""));
console.log(`Wrote ${files.length} migrations: ${files.map(name).join(", ")}`);
