import SqliteDatabase from "better-sqlite3";

import { initializeSchema } from "./schema.js";

export class Database {
  readonly connection: SqliteDatabase.Database;
  readonly path: string;

  constructor(path = ":memory:", options: { readonly?: boolean } = {}) {
    this.path = path;
    this.connection = new SqliteDatabase(path, { readonly: options.readonly ?? false });
    this.connection.pragma("foreign_keys = ON");
    this.connection.pragma("busy_timeout = 5000");
    // journal_mode = WAL is a persistent property of the database FILE and its
    // change can create -wal/-shm sidecars, so a read-only handle must never
    // issue it: opening an existing database to inspect it must not mutate it.
    if (path !== ":memory:" && !options.readonly) {
      this.connection.pragma("journal_mode = WAL");
    }
  }

  initialize(): void {
    initializeSchema(this.connection);
  }

  transaction<T>(body: () => T): T {
    if (this.connection.inTransaction) {
      return body();
    }

    return this.connection.transaction(body)();
  }

  close(): void {
    this.connection.close();
  }
}
