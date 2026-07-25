import { randomBytes } from "node:crypto";

import { newId, utcNow } from "../contracts/index.js";
import {
  type Database,
  hashWorkerToken,
  WorkerCredentialStore,
  WorkerIdentityStore,
} from "../persistence/index.js";

export type WorkerPrincipal = { worker_id: string; workspace_id: string };

export class WorkerAuthError extends Error {}

/**
 * Mints and resolves per-worker authentication tokens. A worker token authenticates a worker
 * principal (worker_id + workspace) to the loopback API with strictly fewer rights than the
 * operator token: it can request capabilities AS ITSELF and submit ITS OWN outcomes, but cannot
 * issue envelopes, approve, or act as another worker. Only the SHA-256 of the token is stored.
 */
export class WorkerAuthService {
  private readonly credentials: WorkerCredentialStore;
  private readonly workers: WorkerIdentityStore;

  constructor(database: Database) {
    this.credentials = new WorkerCredentialStore(database);
    this.workers = new WorkerIdentityStore(database);
  }

  /** Mint a token for an existing worker. Returns the PLAINTEXT once; only its hash is persisted. */
  mint(input: { workspace_id: string; worker_id: string }): {
    credential_id: string;
    worker_id: string;
    token: string;
  } {
    const worker = this.workers.get(input.worker_id);
    if (!worker || worker.workspace_id !== input.workspace_id) {
      throw new WorkerAuthError(`worker identity not found in workspace: ${input.worker_id}`);
    }
    const token = `wkr_${randomBytes(32).toString("hex")}`;
    const credential = this.credentials.create({
      id: newId("wkrcred"),
      workspace_id: input.workspace_id,
      worker_id: input.worker_id,
      token_hash: hashWorkerToken(token),
      created_at: utcNow(),
    });
    return { credential_id: credential.id, worker_id: input.worker_id, token };
  }

  /** Resolve a presented token to a worker principal, or null if it is absent/invalid/revoked. */
  resolve(token: string | null): WorkerPrincipal | null {
    if (!token) {
      return null;
    }
    const credential = this.credentials.getActiveByTokenHash(hashWorkerToken(token));
    if (!credential) {
      return null;
    }
    return { worker_id: credential.worker_id, workspace_id: credential.workspace_id };
  }
}
