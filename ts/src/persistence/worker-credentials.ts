import { createHash } from "node:crypto";

import type { Database } from "./database.js";

export type WorkerCredential = {
  id: string;
  workspace_id: string;
  worker_id: string;
  token_hash: string;
  status: "active" | "revoked";
  created_at: string;
};

type WorkerCredentialRow = {
  id: string;
  workspace_id: string;
  worker_id: string;
  token_hash: string;
  status: string;
  created_at: string;
};

/** Hash a worker token for storage/lookup. Only the hash is ever persisted. */
export function hashWorkerToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class WorkerCredentialStore {
  constructor(private readonly database: Database) {}

  create(input: {
    id: string;
    workspace_id: string;
    worker_id: string;
    token_hash: string;
    created_at: string;
  }): WorkerCredential {
    const credential: WorkerCredential = { ...input, status: "active" };
    this.database.connection
      .prepare(
        `INSERT INTO worker_credentials (id, workspace_id, worker_id, token_hash, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        credential.id,
        credential.workspace_id,
        credential.worker_id,
        credential.token_hash,
        credential.status,
        credential.created_at,
      );
    return credential;
  }

  get(credentialId: string): WorkerCredential | null {
    const row = this.database.connection
      .prepare(
        `SELECT id, workspace_id, worker_id, token_hash, status, created_at
         FROM worker_credentials WHERE id = ?`,
      )
      .get(credentialId) as WorkerCredentialRow | undefined;
    return row ? this.fromRow(row) : null;
  }

  getActiveByTokenHash(tokenHash: string): WorkerCredential | null {
    const row = this.database.connection
      .prepare(
        `SELECT id, workspace_id, worker_id, token_hash, status, created_at
         FROM worker_credentials WHERE token_hash = ? AND status = 'active'`,
      )
      .get(tokenHash) as WorkerCredentialRow | undefined;
    return row ? this.fromRow(row) : null;
  }

  listForWorker(workspaceId: string, workerId: string): WorkerCredential[] {
    const rows = this.database.connection
      .prepare(
        `SELECT id, workspace_id, worker_id, token_hash, status, created_at
         FROM worker_credentials WHERE workspace_id = ? AND worker_id = ? ORDER BY created_at`,
      )
      .all(workspaceId, workerId) as WorkerCredentialRow[];
    return rows.map((row) => this.fromRow(row));
  }

  /** The missing writer for the modelled `revoked` status (#63's unlanded fast-follow). */
  revoke(credentialId: string): WorkerCredential {
    const current = this.get(credentialId);
    if (!current) {
      throw new Error(`worker credential not found: ${credentialId}`);
    }
    if (current.status === "revoked") {
      return current;
    }
    this.database.connection
      .prepare("UPDATE worker_credentials SET status = 'revoked' WHERE id = ?")
      .run(credentialId);
    return { ...current, status: "revoked" };
  }

  private fromRow(row: WorkerCredentialRow): WorkerCredential {
    return {
      id: row.id,
      workspace_id: row.workspace_id,
      worker_id: row.worker_id,
      token_hash: row.token_hash,
      status: row.status === "revoked" ? "revoked" : "active",
      created_at: row.created_at,
    };
  }
}
