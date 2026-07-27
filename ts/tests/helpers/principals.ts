import { generateKeyPairSync } from "node:crypto";
import { dirname, join } from "node:path";

import { newId, utcNow, WorkspaceSchema } from "../../src/contracts/index.js";
import type { DecisionSigner } from "../../src/governance/index.js";
import {
  Database,
  PrincipalKeyStore,
  PrincipalStore,
  WorkspaceStore,
} from "../../src/persistence/index.js";
import {
  type AuthenticatedPrincipal,
  enrichPrincipalIdentity,
} from "../../src/security/authenticated-principal.js";
import { workspaceCustodyDir, writeSigningKeyFile } from "../../src/security/key-custody.js";
import { PrincipalAuthService } from "../../src/security/principal-auth.js";
import { StaticSigningBroker } from "../../src/security/signing-broker.js";
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

export type SeededSigningOperator = {
  /** The DecisionSigner the four authority-moving transitions take. */
  signer: DecisionSigner;
  /** The same identity as signer.principal, for convenience. */
  principal: AuthenticatedPrincipal;
  keyId: string;
  publicKeyBase64Url: string;
  /** The enrolled private key — tests use it to seed a WRONG-key broker. */
  pkcs8Base64Url: string;
};

/**
 * A signing operator for the M5 decision tests: a human principal with a
 * minted credential AND an active enrolled Ed25519 key, re-resolved through
 * the ordinary credential path so the identity carries `key_id` and the
 * unforgeable brand. The returned broker is a StaticSigningBroker holding the
 * enrolled key under `signkey_operator`, matching production custody handles.
 */
export function createSigningOperator(
  database: Database,
  workspaceId: string,
  displayName: string,
  options: { validFrom?: string } = {},
): SeededSigningOperator {
  // Principals are unique per (workspace, display name), so asking for the same
  // operator twice in one test returns the SAME operator — the natural reading
  // of "the operator signs again" — rather than violating the uniqueness rule.
  let byKey = signingOperatorCache.get(database);
  if (!byKey) {
    byKey = new Map();
    signingOperatorCache.set(database, byKey);
  }
  const cacheKey = `${workspaceId} ${displayName} ${options.validFrom ?? ""}`;
  const cached = byKey.get(cacheKey);
  if (cached) {
    return cached;
  }
  const seeded = createPrincipalWithToken(database, workspaceId, displayName);
  const pair = generateKeyPairSync("ed25519");
  const pkcs8Base64Url = pair.privateKey
    .export({ format: "der", type: "pkcs8" })
    .toString("base64url");
  const publicKeyBase64Url = (pair.publicKey.export({ format: "jwk" }) as { x: string }).x;
  const key = new PrincipalKeyStore(database).create({
    id: newId("prinkey"),
    workspace_id: workspaceId,
    principal_id: seeded.principal_id,
    public_key: publicKeyBase64Url,
    valid_from: options.validFrom ?? utcNow(),
    created_at: utcNow(),
  });
  const identity = new PrincipalAuthService(database).resolve(seeded.token);
  const principal = identity ? enrichPrincipalIdentity(database, identity) : null;
  if (!principal || principal.key_id !== key.id) {
    throw new Error("failed to resolve the seeded signing operator with its enrolled key");
  }
  const operator: SeededSigningOperator = {
    signer: {
      principal,
      broker: new StaticSigningBroker({ signkey_operator: pkcs8Base64Url }),
      handle: "signkey_operator",
    },
    principal,
    keyId: key.id,
    publicKeyBase64Url,
    pkcs8Base64Url,
  };
  byKey.set(cacheKey, operator);
  return operator;
}

const signingOperatorCache = new WeakMap<Database, Map<string, SeededSigningOperator>>();

/**
 * Seeds a principal + credential + active enrolled Ed25519 key straight into
 * the sqlite file at `dbPath`, and writes the matching custody key file where
 * a server reading the same path resolves it (`<dirname(dbPath)>/keys/
 * <workspace>/operator.pk8`). This is the HTTP-boundary counterpart of
 * createSigningOperator: the server holds custody, the test holds the token.
 */
export function seedSigningPrincipalAtPath(
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
        new SpineService(database).initDemoWorkspace();
      } else {
        workspaces.save(
          WorkspaceSchema.parse({ id: workspaceId, name: workspaceId, created_at: utcNow() }),
        );
      }
    }
    const seeded = createPrincipalWithToken(database, workspaceId, displayName);
    const pair = generateKeyPairSync("ed25519");
    const pkcs8Base64Url = pair.privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64url");
    const publicKeyBase64Url = (pair.publicKey.export({ format: "jwk" }) as { x: string }).x;
    new PrincipalKeyStore(database).create({
      id: newId("prinkey"),
      workspace_id: workspaceId,
      principal_id: seeded.principal_id,
      public_key: publicKeyBase64Url,
      valid_from: utcNow(),
      created_at: utcNow(),
    });
    writeSigningKeyFile({
      keysDir: workspaceCustodyDir(join(dirname(dbPath), "keys"), workspaceId),
      name: "operator",
      pkcs8Base64Url,
    });
    return seeded;
  } finally {
    database.close();
  }
}
