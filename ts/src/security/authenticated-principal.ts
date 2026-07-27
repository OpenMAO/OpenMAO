import { utcNow, WorkspaceSchema } from "../contracts/index.js";
import {
  type Database,
  PrincipalKeyStore,
  PrincipalStore,
  WorkspaceStore,
} from "../persistence/index.js";
import type { PrincipalKind } from "../persistence/principals.js";
import { PrincipalAuthService, type ResolvedPrincipalIdentity } from "./principal-auth.js";
import { ensureRootOperator, readProfileFile } from "./principal-bootstrap.js";

/**
 * The unforgeable marker on an authenticated principal. The symbol is
 * module-private: it never appears in .d.ts consumers can name, so an object
 * literal carrying it does not typecheck outside the authentication paths in
 * this module, and at runtime only objects this module minted carry it.
 * `assertAuthenticatedPrincipal` is the exported runtime half of the pair.
 */
const AUTHENTICATED: unique symbol = Symbol("openmao.authenticated-principal");

/**
 * Identity-based registry of principals this module actually minted.
 *
 * The `AUTHENTICATED` symbol alone is not sufficient at runtime: assigned in an
 * object literal it is an *enumerable* own symbol, so `{ ...principal, actor:
 * victim }` copies the brand and a spread forgery passes an `in` check. A
 * caller holding any valid credential could therefore record events as any
 * principal — the identity-naming the cutover exists to remove.
 *
 * Membership is by object identity, and a spread produces a new object, so it
 * cannot be forged by copying properties. The symbol is retained for typing.
 */
const MINTED_PRINCIPALS = new WeakSet<object>();

/**
 * The single authenticated-identity shape the whole boundary resolves to, so
 * M4 can flip HTTP, console, and CLI ATOMICALLY by changing resolvers — never
 * by editing call sites. `key_id` is nullable (an identity may authenticate
 * without a signing key), `can_sign` reports whether an active enrolled key
 * exists, and `dev_bootstrap` carries the honesty valve forward so a
 * development identity can never present itself as production trust.
 *
 * The branded marker makes the identity unforgeable by construction: only the
 * resolvers in this module can mint a value of this type, so a boundary taking
 * an AuthenticatedPrincipal cannot be handed a caller-invented identity.
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
  readonly [AUTHENTICATED]: true;
};

/**
 * Runtime half of the brand: a hand-built context fails HERE, at the boundary
 * that was asked to record under it — not silently downstream. Type-checked
 * callers never reach the throw; it exists for untyped (or `as`-cast) callers.
 */
export function assertAuthenticatedPrincipal(
  value: unknown,
): asserts value is AuthenticatedPrincipal {
  if (typeof value !== "object" || value === null || !MINTED_PRINCIPALS.has(value)) {
    throw new Error(
      "identity must be an authenticated principal resolved through the credential path (resolveCliPrincipal / authenticateFromProfile / enrichPrincipalIdentity) — a hand-built context is not an identity",
    );
  }
}

/**
 * The one resolver every CLI actor call site goes through. Identity is real:
 * the operator profile's token is resolved through the ordinary credential
 * path, so the actor every command records is the stored principal's id —
 * never a typed-in name.
 *
 * When no usable profile exists, the resolver runs the M3 root-of-trust
 * ceremony (ensureRootOperator) and authenticates with the identity it
 * establishes. The ceremony is idempotent on its own prior state, refuses to
 * bootstrap over a mismatched identity, and refuses outright under
 * production signals — so `make demo` stays one command in development while
 * no production deployment can silently manufacture a root of trust.
 */
export function resolveCliPrincipal(
  database: Database,
  workspaceId: string,
  keysDir: string,
): AuthenticatedPrincipal {
  const existing = authenticateFromProfile(database, keysDir);
  if (existing && existing.workspace_id === workspaceId) {
    return existing;
  }
  // The principals tables FK to workspaces, so the ceremony needs the row.
  const workspaces = new WorkspaceStore(database);
  if (!workspaces.get(workspaceId)) {
    workspaces.save(
      WorkspaceSchema.parse({ id: workspaceId, name: workspaceId, created_at: utcNow() }),
    );
  }
  ensureRootOperator({ database, workspaceId, keysDir });
  const principal = authenticateFromProfile(database, keysDir);
  if (!principal || principal.workspace_id !== workspaceId) {
    throw new Error(
      "no authenticated operator profile for this workspace; run `principals init` first",
    );
  }
  return principal;
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
  const minted: AuthenticatedPrincipal = {
    principal_id: principal.id,
    workspace_id: identity.workspace_id,
    kind: principal.kind,
    // The stable principal id is the derived actor string: unique, and immune
    // to display-name collisions.
    actor: principal.id,
    key_id: activeKey?.id ?? null,
    can_sign: activeKey !== null,
    dev_bootstrap: principal.dev_bootstrap,
    [AUTHENTICATED]: true,
  };
  MINTED_PRINCIPALS.add(minted);
  return minted;
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
