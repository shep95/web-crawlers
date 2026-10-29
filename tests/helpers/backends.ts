import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { SqliteCorpus } from "../../src/corpus/store.js";
import { PgCorpus } from "../../src/corpus/pg-store.js";
import type { Corpus } from "../../src/corpus/types.js";

/**
 * Corpus backends under test. Postgres runs when TEST_DATABASE_URL points at a
 * server (CI provides one; locally any Postgres ≥ 13). Each suite gets its own
 * freshly created database, dropped afterwards.
 */
export interface Backend {
  name: "sqlite" | "postgres";
  open(): Promise<Corpus>;
  /** Re-open the same storage (restart simulation). */
  reopen(): Promise<Corpus>;
  dispose(): Promise<void>;
}

export function backends(): Array<() => Backend> {
  const list: Array<() => Backend> = [
    () => {
      const path = join(mkdtempSync(join(tmpdir(), "omni-")), "corpus.db");
      return { name: "sqlite", open: async () => new SqliteCorpus(path), reopen: async () => new SqliteCorpus(path), dispose: async () => undefined };
    },
  ];
  const base = process.env.TEST_DATABASE_URL;
  if (base) {
    list.push(() => {
      const db = `omni_test_${randomBytes(4).toString("hex")}`;
      const url = new URL(base);
      const admin = () => new pg.Client({ connectionString: base });
      const target = (() => {
        const u = new URL(base);
        u.pathname = `/${db}`;
        return u.toString();
      })();
      return {
        name: "postgres",
        async open() {
          const c = admin();
          await c.connect();
          await c.query(`CREATE DATABASE ${db}`);
          await c.end();
          return PgCorpus.connect(target, { max: 6 });
        },
        reopen: () => PgCorpus.connect(target, { max: 6 }),
        async dispose() {
          const c = admin();
          await c.connect();
          await c.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
          await c.end();
          void url;
        },
      };
    });
  }
  return list;
}
