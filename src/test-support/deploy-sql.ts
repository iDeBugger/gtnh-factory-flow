import { readFileSync } from "node:fs";
import path from "node:path";

/** Where the deploy's role and grant scripts live. */
export const DEPLOY_DB_DIR = path.join(process.cwd(), "tools", "deploy", "db");

/**
 * A deploy script from `tools/deploy/db` without its psql meta-commands and
 * the statements that read a psql variable (the passwords), so the roles it
 * makes stay nologin and a test enters them with `set role`.
 */
export function deploySqlWithoutPsql(file: string): string {
  return readFileSync(path.join(DEPLOY_DB_DIR, file), "utf8")
    .split("\n")
    .filter((line) => !line.startsWith("\\") && !line.includes(":'"))
    .join("\n");
}
