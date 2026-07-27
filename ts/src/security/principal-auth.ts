import { randomBytes } from "node:crypto";

import { newId, utcNow } from "../contracts/index.js";
import {
  type Database,
  hashPrincipalToken,
  PrincipalCredentialStore,
  PrincipalStore,
} from "../persistence/index.js";

/**
 * The narrow identity a presented token resolves to. The full boundary shape —
 * kind, derived actor, key, signing capability, trust flag — is
 * AuthenticatedPrincipal in authenticated-principal.ts; enrichPrincipalIdentity
 * upgrades this to it.
 */
export type ResolvedPrincipalIdentity = { principal_id: string; workspace_id: string };

export class PrincipalAuthError extends Error {}

/**
 * Mints and resolves per-principal authentication tokens, the human/agent analogue of
 * WorkerAuthService. A principal token authenticates a principal (principal_id + workspace);
 * the resolved identity is FORCED from the stored credential row — never from a caller-supplied
 * value. Only the SHA-256 of the token is stored; the plaintext is returned once at mint time.
 */
export class PrincipalAuthService {
  private readonly credentials: PrincipalCredentialStore;
  private readonly principals: PrincipalStore;

  constructor(database: Database) {
    this.credentials = new PrincipalCredentialStore(database);
    this.principals = new PrincipalStore(database);
  }

  /** Mint a token for an existing principal. Returns the PLAINTEXT once; only its hash is persisted. */
  mint(input: { workspace_id: string; principal_id: string }): {
    credential_id: string;
    principal_id: string;
    token: string;
  } {
    const principal = this.principals.get(input.principal_id);
    if (!principal || principal.workspace_id !== input.workspace_id) {
      throw new PrincipalAuthError(`principal not found in workspace: ${input.principal_id}`);
    }
    const token = `prt_${randomBytes(32).toString("hex")}`;
    const credential = this.credentials.create({
      id: newId("prtcred"),
      workspace_id: input.workspace_id,
      principal_id: input.principal_id,
      token_hash: hashPrincipalToken(token),
      created_at: utcNow(),
    });
    return { credential_id: credential.id, principal_id: input.principal_id, token };
  }

  /**
   * Resolve a presented token to a principal, or null if it is absent/invalid/revoked — or if the
   * principal itself is no longer active. The credential AND the principal must both be active:
   * a token must not outlive the standing of the identity it authenticates.
   */
  resolve(token: string | null): ResolvedPrincipalIdentity | null {
    if (!token) {
      return null;
    }
    const credential = this.credentials.getActiveByTokenHash(hashPrincipalToken(token));
    if (!credential) {
      return null;
    }
    const principal = this.principals.get(credential.principal_id);
    if (principal?.status !== "active") {
      return null;
    }
    return { principal_id: credential.principal_id, workspace_id: credential.workspace_id };
  }

  revoke(credentialId: string): void {
    this.credentials.revoke(credentialId);
  }
}
