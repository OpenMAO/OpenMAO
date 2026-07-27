import { newId, utcNow, WorkspaceSchema } from "../../src/contracts/index.js";
import { Database, PrincipalStore, WorkspaceStore } from "../../src/persistence/index.js";
import {
  type AuthenticatedPrincipal,
  enrichPrincipalIdentity,
} from "../../src/security/authenticated-principal.js";
import { PrincipalAuthService } from "../../src/security/principal-auth.js";
import { SpineService, WORKSPACE_ID } from "../../src/spine/index.js";

export type SeededPrincipal = {
  principal_id: string;
  credential_id: string;
  token: string;
};

/** An active human principal with a minted credential, created through the stores. */
export function createPrincipalWithToken(
  database: Database,
  workspaceId: string,
  displayName: string,
): SeededPrincipal {
  const principal = new PrincipalStore(database).create({
    id: newId("principal"),
    workspace_id: workspaceId,
    kind: "human",
    display_name: displayName,
    created_at: utcNow(),
  });
  const minted = new PrincipalAuthService(database).mint({
    workspace_id: workspaceId,
    principal_id: principal.id,
  });
  return {
    principal_id: principal.id,
    credential_id: minted.credential_id,
    token: minted.token,
  };
}

/**
 * Seeds a principal + credential straight into the sqlite file at `dbPath`
 * (ensuring the workspace row the principals tables FK to), so a server
 * reading the same path resolves the token. Returns the plaintext token —
 * the only thing the HTTP boundary ever sees.
 */
export function seedPrincipalAtPath(
  dbPath: string,
  workspaceId: string,
  displayName: string,
): SeededPrincipal {
  const database = new Database(dbPath);
  database.initialize();
  try {
    const workspaces = new WorkspaceStore(database);
    if (!workspaces.get(workspaceId)) {
      if (workspaceId === WORKSPACE_ID) {
        // The demo workspace must come up through the production seeder:
        // persistDefaultOrg re-saves the workspace row and throws "workspace
        // already exists" if a bare row was planted first.
        new SpineService(database).initDemoWorkspace();
      } else {
        workspaces.save(
          WorkspaceSchema.parse({ id: workspaceId, name: workspaceId, created_at: utcNow() }),
        );
      }
    }
    return createPrincipalWithToken(database, workspaceId, displayName);
  } finally {
    database.close();
  }
}

export function principalHeaders(token: string): Record<string, string> {
  return { "x-openmao-principal-token": token };
}

/**
 * Mints a real credential for a fresh human principal in `workspaceId` (which
 * must already exist) and resolves it back through the ordinary credential
 * path — so tests hold a genuinely AuthenticatedPrincipal, never a hand-built
 * lookalike.
 */
export function authenticateOperatorPrincipal(
  database: Database,
  workspaceId: string,
  displayName: string,
): AuthenticatedPrincipal {
  const seeded = createPrincipalWithToken(database, workspaceId, displayName);
  const identity = new PrincipalAuthService(database).resolve(seeded.token);
  const principal = identity ? enrichPrincipalIdentity(database, identity) : null;
  if (!principal) {
    throw new Error("failed to authenticate the seeded operator principal");
  }
  return principal;
}
