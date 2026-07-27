import { type Database, PrincipalKeyStore, PrincipalStore } from "../persistence/index.js";
import type { PrincipalKind } from "../persistence/principals.js";
import { PrincipalAuthService, type ResolvedPrincipalIdentity } from "./principal-auth.js";
import { readProfileFile } from "./principal-bootstrap.js";

/**
 * The single authenticated-identity shape the whole boundary resolves to, so
 * M4 can flip HTTP, console, and CLI ATOMICALLY by changing resolvers — never
 * by editing call sites. `key_id` is nullable (an identity may authenticate
 * without a signing key), `can_sign` reports whether an active enrolled key
 * exists, and `dev_bootstrap` carries the honesty valve forward so a
 * development identity can never present itself as production trust.
 */
export type AuthenticatedPrincipal = {
  principal_id: string;
  workspace_id: string;
  kind: PrincipalKind;
  /** The actor string derived from the principal — never caller-supplied. */
  actor: string;
  key_id: string | null;
  can_sign: boolean;
  dev_bootstrap: boolean;
};

/**
 * The pre-cutover CLI identity. Until M4, `resolveCliPrincipal` must yield
 * exactly this so no command's observable behaviour changes; the point of the
 * abstraction is that M4 becomes a change in one function, not thirteen.
 */
export const LEGACY_CLI_ACTOR = "cli_operator";

/**
 * The one resolver every CLI actor call site goes through. M3 behaviour is
 * deliberately the legacy hardcoded identity; the database parameter exists so
 * M4 can resolve a real principal here without touching any call site.
 */
export function resolveCliPrincipal(
  database: Database,
  workspaceId: string,
): AuthenticatedPrincipal {
  void database;
  return {
    principal_id: LEGACY_CLI_ACTOR,
    workspace_id: workspaceId,
    kind: "human",
    actor: LEGACY_CLI_ACTOR,
    key_id: null,
    can_sign: false,
    dev_bootstrap: false,
  };
}

/**
 * Enriches a resolved token identity with the stored principal row and its
 * active key. Returns null when the principal no longer resolves in the
 * workspace — fail closed, matching PrincipalAuthService.resolve.
 */
export function enrichPrincipalIdentity(
  database: Database,
  identity: ResolvedPrincipalIdentity,
): AuthenticatedPrincipal | null {
  const principal = new PrincipalStore(database).get(identity.principal_id);
  if (!principal || principal.workspace_id !== identity.workspace_id) {
    return null;
  }
  const activeKey =
    new PrincipalKeyStore(database)
      .listForPrincipal(identity.workspace_id, principal.id)
      .find((key) => key.status === "active") ?? null;
  return {
    principal_id: principal.id,
    workspace_id: identity.workspace_id,
    kind: principal.kind,
    // The stable principal id is the derived actor string: unique, and immune
    // to display-name collisions.
    actor: principal.id,
    key_id: activeKey?.id ?? null,
    can_sign: activeKey !== null,
    dev_bootstrap: principal.dev_bootstrap,
  };
}

/**
 * Second-invocation authentication: reads the plaintext token from the local
 * operator profile (0600, beside the key — never the database) and resolves it
 * through the ordinary credential path. This is what makes the command after
 * `principals init` authenticate at all: minting persists only a hash.
 */
export function authenticateFromProfile(
  database: Database,
  keysDir: string,
): AuthenticatedPrincipal | null {
  const profile = readProfileFile(keysDir);
  if (!profile) {
    return null;
  }
  const identity = new PrincipalAuthService(database).resolve(profile.token);
  if (!identity) {
    return null;
  }
  return enrichPrincipalIdentity(database, identity);
}
