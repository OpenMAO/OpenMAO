import { randomBytes } from "node:crypto";
import { existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { newId, utcNow } from "../contracts/index.js";
import {
  type Database,
  EventStore,
  hashPrincipalToken,
  PrincipalCredentialStore,
  PrincipalKeyStore,
  PrincipalStore,
} from "../persistence/index.js";
import {
  assertDevelopmentEnvironment,
  CustodyError,
  fingerprintForPublicKey,
  generateSigningKeyFile,
  keyFilePath,
  publicKeyFromCustodyFile,
  readFingerprintFile,
  writeFingerprintFile,
} from "./key-custody.js";
import { readProfileWithCustody, writeProfileAtomic } from "./operator-profile.js";
import { PrincipalAuthService } from "./principal-auth.js";
import { assertNoSensitiveMaterial } from "./sensitive-material.js";

/**
 * The root-of-trust ceremony. The first operator key cannot be attested by
 * anyone — there is no prior root — so it is enrolled by a NAMED one-time
 * ceremony, not by ordinary enrolment:
 *
 *   - valid ONLY on an empty principal registry for the workspace — the
 *     predicate is EVALUATED INSIDE the enrolment transaction, so no
 *     concurrent enrolment can slip between the check and the insert;
 *   - records the predicates it EVALUATED (registry_empty,
 *     private_key_mode_0600, database-file ownership) with their observed
 *     values, not their intent — a predicate that cannot be evaluated is a
 *     refusal, never a recorded true;
 *   - enrols the public key through M2's PrincipalKeyStore, keeping its
 *     low-order/off-curve refusal intact;
 *   - marks the principal dev_bootstrap, so its signatures verify but never
 *     claim production trust;
 *   - writes the public-key fingerprint OUTSIDE the database, beside the key;
 *   - mints a credential and writes the plaintext token to a local profile
 *     file at mode 0600 beside the key — never into the database. Minting
 *     persists only a hash, so without this file the very next command could
 *     not authenticate;
 *   - every custody artefact lands atomically (temp file at the final mode,
 *     then rename), and any failure after key generation removes what was
 *     created so a retry is always possible;
 *   - refuses outright under NODE_ENV=production or a non-loopback binding;
 *   - never emits the private key: not in the event, not in the result's
 *     persisted rows, not in any error message. Key material never leaves
 *     key-custody.ts at all — the ceremony receives only the key path and
 *     the public key.
 */
export class BootstrapRefusedError extends Error {}

export const BOOTSTRAP_KEY_NAME = "operator";
export const BOOTSTRAP_MODE = "development_bootstrap";
export const PRINCIPAL_BOOTSTRAPPED_EVENT = "principal.bootstrapped";

/** A ceremony predicate with its EVALUATED outcome and what was observed. */
export type BootstrapPredicate = {
  predicate: "registry_empty" | "private_key_mode_0600" | "database_file_owned_by_current_user";
  result: boolean;
  observed: string;
};

/**
 * The local operator profile: how the NEXT invocation authenticates. Holds the
 * plaintext credential token, so it lives at mode 0600 beside the key file and
 * never in the database.
 */
export type OperatorProfile = {
  version: 1;
  workspace_id: string;
  principal_id: string;
  key_id: string;
  token: string;
};

export type BootstrapResult = {
  /** True when a previous ceremony's state was recognised and nothing was mutated. */
  already_bootstrapped: boolean;
  mode: typeof BOOTSTRAP_MODE;
  workspace_id: string;
  principal_id: string;
  key_id: string;
  public_key: string;
  fingerprint: string;
  key_path: string;
  fingerprint_path: string;
  profile_path: string;
  /** The plaintext token — from the ceremony once, thereafter from the local profile. */
  token: string;
  predicates: BootstrapPredicate[];
  bootstrapped_event_id: string | null;
};

export function profilePathFor(keysDir: string, name: string = BOOTSTRAP_KEY_NAME): string {
  return join(keysDir, `${name}.profile.json`);
}

export function readProfileFile(
  keysDir: string,
  name: string = BOOTSTRAP_KEY_NAME,
): OperatorProfile | null {
  // Custody is verified at EVERY read (O_NOFOLLOW open, fstat on the same
  // descriptor, directory re-checked): a widened or symlinked profile refuses
  // authentication rather than silently authenticating with tampered custody.
  const contents = readProfileWithCustody(keysDir, profilePathFor(keysDir, name));
  if (contents === null) {
    return null;
  }
  return JSON.parse(contents) as OperatorProfile;
}

function writeProfileFile(keysDir: string, profile: OperatorProfile): string {
  const path = profilePathFor(keysDir);
  writeProfileAtomic({ keysDir, path, profile, overwrite: false });
  return path;
}

/**
 * Replaces the token inside an existing profile after a deliberate re-mint.
 * The write is atomic: a temp file at 0600 in the same directory, renamed
 * into place — there is never a truncated profile, and never a window where
 * the new token sits at a widened mode.
 */
export function rotateProfileToken(keysDir: string, token: string): OperatorProfile {
  const current = readProfileFile(keysDir);
  if (!current) {
    throw new BootstrapRefusedError("no operator profile to rotate; run the bootstrap first");
  }
  const updated: OperatorProfile = { ...current, token };
  writeProfileAtomic({ keysDir, path: profilePathFor(keysDir), profile: updated, overwrite: true });
  return updated;
}

/**
 * Ownership must be EVALUATED to count. On a platform without getuid the
 * predicate is not evaluable, and a predicate that was not evaluated can never
 * be recorded as true: the ceremony refuses, saying exactly why.
 */
function evaluateDatabaseOwnership(database: Database): BootstrapPredicate {
  if (database.path === ":memory:") {
    return {
      predicate: "database_file_owned_by_current_user",
      result: true,
      observed: "in_memory",
    };
  }
  const ownerUid = statSync(database.path).uid;
  if (typeof process.getuid !== "function") {
    return {
      predicate: "database_file_owned_by_current_user",
      result: false,
      observed: `not_evaluable (process.getuid unavailable); owner_uid=${ownerUid}`,
    };
  }
  return {
    predicate: "database_file_owned_by_current_user",
    result: ownerUid === process.getuid(),
    observed: `owner_uid=${ownerUid}`,
  };
}

function evaluateKeyFileMode(keyPath: string): BootstrapPredicate {
  const mode = statSync(keyPath).mode & 0o777;
  return {
    predicate: "private_key_mode_0600",
    result: mode === 0o600,
    observed: `mode=${mode.toString(8).padStart(4, "0")}`,
  };
}

function refuseOnFailedPredicates(predicates: BootstrapPredicate[]): void {
  const failed = predicates.filter((predicate) => !predicate.result);
  if (failed.length > 0) {
    throw new BootstrapRefusedError(
      `bootstrap ceremony predicates failed: ${failed
        .map((predicate) => `${predicate.predicate} (${predicate.observed})`)
        .join(", ")}`,
    );
  }
}

/**
 * The ceremony itself. Refuses on ANY non-empty registry — idempotent re-runs
 * go through ensureRootOperator, which recognises its own prior state.
 */
export function bootstrapRootOperator(input: {
  database: Database;
  workspaceId: string;
  keysDir: string;
  env?: NodeJS.ProcessEnv;
  now?: string;
}): BootstrapResult {
  const env = input.env ?? process.env;
  try {
    assertDevelopmentEnvironment(env, "dev bootstrap");
  } catch (error) {
    if (error instanceof CustodyError) {
      throw new BootstrapRefusedError(error.message);
    }
    throw error;
  }

  const ownershipPredicate = evaluateDatabaseOwnership(input.database);
  refuseOnFailedPredicates([ownershipPredicate]);

  // Key material never crosses this module boundary: generation writes
  // straight into custody, and only the path and public key come back.
  //
  // Failure discipline: cleanup removes ONLY the artefacts THIS ceremony
  // created. A refusal caused by a pre-existing fingerprint or profile must
  // never destroy that pre-existing custody, and every artefact the ceremony
  // did create is removed so a retry is always possible.
  const created: string[] = [];
  const cleanup = (): void => {
    for (const path of created) {
      rmSync(path, { force: true });
    }
  };
  let generated: { keyPath: string; publicKeyBase64Url: string };
  try {
    generated = generateSigningKeyFile({ keysDir: input.keysDir, name: BOOTSTRAP_KEY_NAME });
    created.push(generated.keyPath);
    const fingerprintPath = writeFingerprintFile({
      keysDir: input.keysDir,
      name: BOOTSTRAP_KEY_NAME,
      publicKeyBase64Url: generated.publicKeyBase64Url,
    });
    created.push(fingerprintPath);
  } catch (error) {
    cleanup();
    throw error;
  }
  const keyPath = generated.keyPath;
  const modePredicate = evaluateKeyFileMode(keyPath);
  refuseOnFailedPredicates([modePredicate]);

  const now = input.now ?? utcNow();
  const principalId = newId("principal");
  const keyId = newId("prinkey");
  const fingerprint = fingerprintForPublicKey(generated.publicKeyBase64Url);
  const token = `prt_${randomBytes(32).toString("hex")}`;

  // Custody becomes durable BEFORE anything commits: the profile — the only
  // plaintext copy of the token — is written ahead of the enrolment
  // transaction, so no ordering exists in which the database holds a
  // committed principal/key/credential whose token was never persisted. If
  // the profile cannot be written the registry is still empty and a retry is
  // a fresh ceremony; if the transaction later refuses, every artefact above
  // came from this run and is removed.
  try {
    const profilePath = writeProfileFile(input.keysDir, {
      version: 1,
      workspace_id: input.workspaceId,
      principal_id: principalId,
      key_id: keyId,
      token,
    });
    created.push(profilePath);
  } catch (error) {
    cleanup();
    throw error;
  }

  // The enrolment transaction: principal row, key row, credential hash, and
  // the ceremony event land together or not at all. The registry_empty
  // predicate is EVALUATED HERE, inside the transaction — checking it outside
  // would let a concurrent enrolment slip between the check and the insert
  // while the record still claimed the registry was empty. The public key
  // passes through PrincipalKeyStore's curve validation — never bypassed.
  let predicates: BootstrapPredicate[];
  let eventId: string;
  try {
    const outcome = input.database.transaction(() => {
      const principals = new PrincipalStore(input.database);
      const registry = principals.listForWorkspace(input.workspaceId);
      const registryPredicate: BootstrapPredicate = {
        predicate: "registry_empty",
        result: registry.length === 0,
        observed: `count=${registry.length}`,
      };
      refuseOnFailedPredicates([registryPredicate]);

      principals.create({
        id: principalId,
        workspace_id: input.workspaceId,
        kind: "human",
        display_name: "Operator (dev bootstrap)",
        dev_bootstrap: true,
        created_at: now,
      });
      new PrincipalKeyStore(input.database).create({
        id: keyId,
        workspace_id: input.workspaceId,
        principal_id: principalId,
        public_key: generated.publicKeyBase64Url,
        valid_from: now,
        created_at: now,
      });
      // Only the token's hash is persisted; the plaintext lives solely in the
      // profile file already written above.
      new PrincipalCredentialStore(input.database).create({
        id: newId("prtcred"),
        workspace_id: input.workspaceId,
        principal_id: principalId,
        token_hash: hashPrincipalToken(token),
        created_at: now,
      });

      const ceremonyPredicates = [registryPredicate, modePredicate, ownershipPredicate];
      const eventData = {
        mode: BOOTSTRAP_MODE,
        principal_id: principalId,
        key_id: keyId,
        public_key: generated.publicKeyBase64Url,
        fingerprint,
        key_path: keyPath,
        predicates: ceremonyPredicates,
      };
      // The event is a durable record: assert the private key can never ride
      // along inside it, structurally, before it is appended.
      assertNoSensitiveMaterial(eventData, "principal.bootstrapped");
      const event = new EventStore(input.database).append({
        workspace_id: input.workspaceId,
        kind: PRINCIPAL_BOOTSTRAPPED_EVENT,
        actor: principalId,
        payload: {
          data: eventData,
          refs: [principalId, keyId],
          actor_ref: null,
          produced_refs: [],
          consumed_refs: [],
          causal_parent_id: null,
        },
        timestamp: now,
      });
      return { eventId: event.id, ceremonyPredicates };
    });
    predicates = outcome.ceremonyPredicates;
    eventId = outcome.eventId;
  } catch (error) {
    cleanup();
    throw error;
  }

  return {
    already_bootstrapped: false,
    mode: BOOTSTRAP_MODE,
    workspace_id: input.workspaceId,
    principal_id: principalId,
    key_id: keyId,
    public_key: generated.publicKeyBase64Url,
    fingerprint,
    key_path: keyPath,
    fingerprint_path: join(input.keysDir, `${BOOTSTRAP_KEY_NAME}.fingerprint`),
    profile_path: profilePathFor(input.keysDir),
    token,
    predicates,
    bootstrapped_event_id: eventId,
  };
}

/**
 * Idempotent entry point: a fresh registry gets the ceremony; a registry that
 * provably matches THIS installation's on-disk bootstrap state AND still
 * presents usable custody is returned unchanged — no second identity, no
 * overwritten key, no second ceremony event. "Recognised" means more than
 * metadata agreement: the key file must exist as a regular 0600 file inside
 * a 0700 directory and match the enrolled fingerprint, the fingerprint file
 * must agree with the enrolled active key, the profile token must resolve to
 * an ACTIVE credential, and the principal itself must be ACTIVE. Any
 * inconsistency refuses with a specific reason — the next signature or
 * authentication must never be the thing that discovers broken custody.
 */
export function ensureRootOperator(input: {
  database: Database;
  workspaceId: string;
  keysDir: string;
  env?: NodeJS.ProcessEnv;
  now?: string;
}): BootstrapResult {
  const principals = new PrincipalStore(input.database);
  const registry = principals.listForWorkspace(input.workspaceId);
  if (registry.length === 0) {
    return bootstrapRootOperator(input);
  }

  const mismatch = (reason: string): BootstrapRefusedError =>
    new BootstrapRefusedError(
      `principal registry for workspace ${input.workspaceId} does not match usable on-disk bootstrap state (${reason}); refusing to bootstrap over an existing identity`,
    );

  const keyPath = keyFilePath(input.keysDir, BOOTSTRAP_KEY_NAME);
  if (!existsSync(keyPath)) {
    throw mismatch("key file is missing");
  }
  // The on-disk public key is derived through the custody-checked read: the
  // file is opened once (symlinks refused), fstat'ed on that descriptor, and
  // read from it — the checked object and the read object are the same.
  let onDiskPublicKey: string;
  try {
    const derived = publicKeyFromCustodyFile(input.keysDir, BOOTSTRAP_KEY_NAME);
    if (derived === null) {
      throw mismatch("key file is missing");
    }
    onDiskPublicKey = derived;
  } catch (error) {
    if (error instanceof BootstrapRefusedError) {
      throw error;
    }
    if (error instanceof CustodyError) {
      throw mismatch(
        "key custody permissions are wrong; expected a regular file at 0600 in a 0700 directory",
      );
    }
    throw mismatch("key file does not hold valid PKCS8 Ed25519 material");
  }

  const fingerprintRecord = readFingerprintFile(input.keysDir, BOOTSTRAP_KEY_NAME);
  const profile = readProfileFile(input.keysDir, BOOTSTRAP_KEY_NAME);
  if (!fingerprintRecord) {
    throw mismatch("fingerprint file is missing");
  }
  if (!profile) {
    throw mismatch("profile file is missing");
  }
  if (profile.workspace_id !== input.workspaceId) {
    throw mismatch("profile belongs to a different workspace");
  }
  if (fingerprintRecord.public_key !== onDiskPublicKey) {
    throw mismatch("key file does not match the on-disk fingerprint");
  }

  const keys = new PrincipalKeyStore(input.database);
  for (const principal of registry) {
    if (!principal.dev_bootstrap || principal.id !== profile.principal_id) {
      continue;
    }
    if (principal.status !== "active") {
      throw mismatch("bootstrapped principal is not active");
    }
    for (const key of keys.listForPrincipal(input.workspaceId, principal.id)) {
      if (
        key.id === profile.key_id &&
        key.status === "active" &&
        key.public_key === fingerprintRecord.public_key &&
        fingerprintForPublicKey(key.public_key) === fingerprintRecord.fingerprint
      ) {
        const identity = new PrincipalAuthService(input.database).resolve(profile.token);
        if (!identity || identity.principal_id !== principal.id) {
          throw mismatch("profile token resolves to no active credential");
        }
        return {
          already_bootstrapped: true,
          mode: BOOTSTRAP_MODE,
          workspace_id: input.workspaceId,
          principal_id: principal.id,
          key_id: key.id,
          public_key: key.public_key,
          fingerprint: fingerprintRecord.fingerprint,
          key_path: keyPath,
          fingerprint_path: join(input.keysDir, `${BOOTSTRAP_KEY_NAME}.fingerprint`),
          profile_path: profilePathFor(input.keysDir),
          token: profile.token,
          predicates: [],
          bootstrapped_event_id: null,
        };
      }
    }
  }

  throw mismatch("no enrolled active key matches the on-disk root of trust");
}
