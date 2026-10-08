import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";
import type { TestProject } from "vitest/node";

/**
 * Builds a fresh test database: the Supabase stand-in, then every migration
 * in order, exactly as they will run on Supabase. Needs TEST_DATABASE_URL
 * pointing at a Postgres server where the user may create databases.
 */
export default async function setup(project: TestProject) {
  const adminUrl = process.env.TEST_DATABASE_URL;
  if (!adminUrl) {
    throw new Error("TEST_DATABASE_URL is not set. See README: Running the database tests.");
  }
  const testUrl = new URL(adminUrl);
  testUrl.pathname = "/transport_test";

  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  await admin.unsafe("drop database if exists transport_test with (force)");
  await admin.unsafe("create database transport_test");
  await admin.end();

  const sql = postgres(testUrl.toString(), { max: 1, onnotice: () => {} });
  const root = path.resolve(import.meta.dirname, "../..");
  await sql.file(path.join(root, "tests/db/supabase-stub.sql"));
  const migrationsDir = path.join(root, "supabase/migrations");
  const migrations = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  for (const file of migrations) {
    try {
      await sql.unsafe(await readFile(path.join(migrationsDir, file), "utf8"));
    } catch (error) {
      throw new Error(`Migration ${file} failed: ${(error as Error).message}`);
    }
  }
  await sql.end();

  project.provide("testDatabaseUrl", testUrl.toString());
}

declare module "vitest" {
  export interface ProvidedContext {
    testDatabaseUrl: string;
  }
}
