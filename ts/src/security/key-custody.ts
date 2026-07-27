import { createHash, createPublicKey, sign as cryptoSign, generateKeyPairSync } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import type { Database } from "../persistence/index.js";
import { PrincipalKeyStore, PrincipalStore } from "../persistence/index.js";
import {
  EnvSigningBroker,
  importPkcs8,
  type SigningBroker,
  validateSigningHandle,
} from "./signing-broker.js";

/**
 * Key custody: where signing private keys live, per environment, and how a
 * deployment resolves which tier supplies its signer. This is the wave where a
 * private key first touches disk, so every rule here is enforced in code and
 * asserted in tests — nothing is a comment-level intention:
 *
 *   - file tier:   PKCS8 under a keys directory, file mode 0600, directory
 *                  mode 0700, never overwritten once written, re-checked at
 *                  EVERY use (a widened or symlinked key refuses to sign);
 *   - env tier:    CI/test only — the refusal to operate under any
 *                  production-ish signal lives INSIDE the broker, so no
 *                  embedding consumer can bypass it;
 *   - static tier: in-memory, tests and demos (StaticSigningBroker in
 *                  signing-broker.ts);
 *   - dev bootstrap: no configured key and an empty registry — the named
 *                  one-time ceremony in principal-bootstrap.ts.
 *
 * The custody boundary itself is unchanged from M1: every tier is a
 * SigningBroker — bytes in, signature out — and no path in this module ever
 * returns key material to a caller. Key generation and key-file reading are
 * module-private: the only exported ways key material moves are into a file
 * (writeSigningKeyFile) or into a signature (a SigningBroker). Key material
 * never appears in an error message: errors name handles, paths, tiers, and
 * public fingerprints only.
 */
export class CustodyError extends Error {}

const SIGNING_HANDLE_PREFIX = "signkey_";
const FILE_HANDLE_NAME = /^[a-z0-9_]+$/;
const DEFAULT_KEY_NAME = "operator";
const KEY_FILE_SUFFIX = ".pk8";
const FINGERPRINT_FILE_SUFFIX = ".fingerprint";

const KEY_FILE_MODE = 0o600;
const KEYS_DIR_MODE = 0o700;

const LOOPBACK_BINDINGS = new Set(["127.0.0.1", "localhost", "::1", "::ffff:127.0.0.1"]);

/**
 * Signals under which the env tier and the dev-bootstrap ceremony must refuse
 * to operate: an explicit production environment, or a configured non-loopback
 * bind address (a development convenience must not be reachable from a network
 * surface). Returns the NAMES of triggered signals only — never values.
 */
export function productionSignals(env: NodeJS.ProcessEnv): string[] {
  const signals: string[] = [];
  if (env.NODE_ENV === "production") {
    signals.push("NODE_ENV=production");
  }
  for (const variable of ["OPENMAO_HOST", "OPENMAO_BIND"] as const) {
    const value = env[variable];
    if (value !== undefined && value.trim() !== "" && !LOOPBACK_BINDINGS.has(value.trim())) {
      signals.push(`${variable} is non-loopback`);
    }
  }
  return signals;
}

/** Throws when any production-ish signal is present; `purpose` names the refusing operation. */
export function assertDevelopmentEnvironment(env: NodeJS.ProcessEnv, purpose: string): void {
  const signals = productionSignals(env);
  if (signals.length > 0) {
    throw new CustodyError(`${purpose} refuses to operate in production (${signals.join(", ")})`);
  }
}

function handleName(handle: string): string {
  validateSigningHandle(handle);
  const name = handle.slice(SIGNING_HANDLE_PREFIX.length);
  // Same injective-map rule as the env tier: only lowercase letters, digits,
  // and underscores, so distinct handles can never collapse onto one file name.
  if (!FILE_HANDLE_NAME.test(name) || name.length === 0) {
    throw new CustodyError(
      "file custody handles must match signkey_<name> with only lowercase letters, digits, and underscores",
    );
  }
  return name;
}

/**
 * The write/generate paths take a key NAME directly (not a handle) and must
 * enforce the same alphabet: the name is joined onto the custody directory,
 * so an unvalidated name carrying separators or `..` would escape it.
 */
function validateKeyName(name: string): void {
  if (!FILE_HANDLE_NAME.test(name)) {
    throw new CustodyError(
      "key names must contain only lowercase letters, digits, and underscores",
    );
  }
}

/**
 * The per-workspace custody namespace. Two workspaces must never share a key
 * file, a fingerprint, or a profile: namespacing keeps a second workspace's
 * bootstrap possible at all, and makes it structurally impossible for one
 * workspace's key file to be resolved as another's custody. The directory
 * name is the workspace id itself — canonical ids are already constrained to
 * a path-safe alphabet by the contract schema.
 */
export function workspaceCustodyDir(keysRoot: string, workspaceId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(workspaceId)) {
    throw new CustodyError("workspace id cannot be used as a custody directory name");
  }
  return join(keysRoot, workspaceId);
}

export function keyFilePath(keysDir: string, name: string): string {
  return join(keysDir, `${name}${KEY_FILE_SUFFIX}`);
}

export function fingerprintFilePath(keysDir: string, name: string): string {
  return join(keysDir, `${name}${FINGERPRINT_FILE_SUFFIX}`);
}

/** The directory half of custody, checked on its own for the fd-based read path. */
function assertKeysDirCustody(keysDir: string): void {
  const dirStat = lstatSync(keysDir, { throwIfNoEntry: false });
  if (
    !dirStat ||
    !dirStat.isDirectory() ||
    dirStat.isSymbolicLink() ||
    (dirStat.mode & 0o777) !== KEYS_DIR_MODE
  ) {
    throw new CustodyError(
      `signing key directory custody is wrong; expected a real directory at mode 0700: ${keysDir}`,
    );
  }
}

/**
 * Verifies custody state at USE time, not just at creation: the path must be
 * a regular file (never a symlink) at exactly 0600, inside a directory at
 * exactly 0700. A key whose file was widened, swapped for a link, or whose
 * directory was opened up refuses to sign — the permission bits are
 * evaluated, never assumed.
 */
export function assertCustodyPermissions(keysDir: string, path: string): void {
  assertKeysDirCustody(keysDir);
  const fileStat = lstatSync(path, { throwIfNoEntry: false });
  if (!fileStat || !fileStat.isFile() || (fileStat.mode & 0o777) !== KEY_FILE_MODE) {
    throw new CustodyError(
      `signing key custody is wrong; expected a regular file at mode 0600: ${path}`,
    );
  }
}

/**
 * The creation-time counterpart of the use-time checks: a custody directory
 * that already exists as a SYMLINK (or a plain file) is refused before any
 * mkdir/chmod touches it — recursive mkdir and chmod both follow a directory
 * symlink, which would land artefacts outside the custody root.
 */
function assertCustodyDirCreatable(keysDir: string): void {
  const stat = lstatSync(keysDir, { throwIfNoEntry: false });
  if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) {
    throw new CustodyError(
      `custody directory must be a real directory, not a symlink or a file: ${keysDir}`,
    );
  }
}

/**
 * Writes `contents` to `path` atomically: a uniquely-named temp file in the
 * same directory, created exclusively at the final mode, then rename() into
 * place. There is never a truncated or wide-mode window at the final path.
 * `overwrite: false` keeps the creation-time refuse-to-overwrite rule: the
 * existence check happens BEFORE any bytes land, and a loser of a create race
 * fails on its exclusive temp create or the pre-check, never by clobbering.
 * Any failure removes the temp file, so a partial write can never orphan
 * custody that a later run refuses to overwrite.
 */
function writeFileAtomic(input: {
  keysDir: string;
  path: string;
  contents: string;
  mode: number;
  overwrite: boolean;
  existsMessage: string;
}): void {
  assertCustodyDirCreatable(input.keysDir);
  mkdirSync(input.keysDir, { recursive: true });
  chmodSync(input.keysDir, KEYS_DIR_MODE);
  if (!input.overwrite && existsSync(input.path)) {
    throw new CustodyError(input.existsMessage);
  }
  const tempPath = `${input.path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  let renamed = false;
  try {
    writeFileSync(tempPath, input.contents, {
      encoding: "utf8",
      flag: "wx",
      mode: input.mode,
    });
    renameSync(tempPath, input.path);
    renamed = true;
  } finally {
    if (!renamed) {
      rmSync(tempPath, { force: true });
    }
  }
  chmodSync(input.path, input.mode);
  const stat = lstatSync(input.path);
  if (!stat.isFile() || (stat.mode & 0o777) !== input.mode) {
    // The write landed but not at custody state: remove it so a retry is
    // never refused by its own orphan.
    rmSync(input.path, { force: true });
    throw new CustodyError(
      `custody write did not land at the expected mode (${(stat.mode & 0o777).toString(8)}); expected ${input.mode.toString(8)}: ${input.path}`,
    );
  }
}

/**
 * Writes base64url PKCS8 key material to `<keysDir>/<name>.pk8`, atomically
 * (temp file + rename), with the file at mode 0600 and the directory at mode
 * 0700, and REFUSES to overwrite an existing key file. The modes are
 * re-stat'ed after the write — the permission bits are verified, not
 * requested — and re-verified at every use via assertCustodyPermissions.
 */
export function writeSigningKeyFile(input: {
  keysDir: string;
  name: string;
  pkcs8Base64Url: string;
}): string {
  validateKeyName(input.name);
  const path = keyFilePath(input.keysDir, input.name);
  writeFileAtomic({
    keysDir: input.keysDir,
    path,
    contents: input.pkcs8Base64Url,
    mode: KEY_FILE_MODE,
    overwrite: false,
    existsMessage: `signing key file already exists; refusing to overwrite: ${path}`,
  });
  const dirMode = statSync(input.keysDir).mode & 0o777;
  if (dirMode !== KEYS_DIR_MODE) {
    throw new CustodyError(
      `signing key custody permissions are wrong (directory ${dirMode.toString(8)}); expected 700`,
    );
  }
  return path;
}

/**
 * Reads the base64url PKCS8 material for a key name with custody verified
 * against the SAME object that is read: the file is opened once (refusing
 * symlinks via O_NOFOLLOW), fstat'ed on that descriptor, and read from that
 * descriptor — the checked object and the read object can never diverge.
 * Returns null only when no file exists; a present-but-wrong file (symlink,
 * widened mode, wrong kind, unreadable) or a wrong directory throws.
 * Module-private: no path out of this module returns key material to a
 * caller — the file tier and the resolver consume it in place.
 */
function readSigningKeyFileChecked(keysDir: string, name: string): string | null {
  const path = keyFilePath(keysDir, name);
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return null;
    }
    if (code === "ELOOP") {
      throw new CustodyError(
        `signing key custody is wrong; the key file must not be a symlink: ${path}`,
      );
    }
    throw new CustodyError(
      `signing key file cannot be opened (${code ?? "unknown error"}): ${path}`,
    );
  }
  try {
    assertKeysDirCustody(keysDir);
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o777) !== KEY_FILE_MODE) {
      throw new CustodyError(
        `signing key custody is wrong; expected a regular file at mode 0600: ${path}`,
      );
    }
    return readFileSync(fd, "utf8").trim();
  } finally {
    closeSync(fd);
  }
}

/**
 * Derives the public key behind a custody key file without the private
 * material ever leaving this module: the checked read happens here, and only
 * the public half is returned. Null when no key file exists.
 */
export function publicKeyFromCustodyFile(keysDir: string, name: string): string | null {
  validateKeyName(name);
  const material = readSigningKeyFileChecked(keysDir, name);
  if (material === null || material.length === 0) {
    return null;
  }
  return publicKeyFromPkcs8(material);
}

/**
 * The public-key fingerprint file lives OUTSIDE the database, alongside the
 * key file, so that replacing the database's root key together with its
 * enrolment rows is not indistinguishable from a legitimate first run: the
 * on-disk fingerprint and the enrolled key must agree. Public material only —
 * the private `d` member never appears here.
 */
export type KeyFingerprintRecord = {
  algorithm: "ed25519";
  public_key: string;
  fingerprint: string;
};

export function fingerprintForPublicKey(publicKeyBase64Url: string): string {
  return createHash("sha256").update(Buffer.from(publicKeyBase64Url, "base64url")).digest("hex");
}

export function writeFingerprintFile(input: {
  keysDir: string;
  name: string;
  publicKeyBase64Url: string;
}): string {
  validateKeyName(input.name);
  const record: KeyFingerprintRecord = {
    algorithm: "ed25519",
    public_key: input.publicKeyBase64Url,
    fingerprint: fingerprintForPublicKey(input.publicKeyBase64Url),
  };
  const path = fingerprintFilePath(input.keysDir, input.name);
  writeFileAtomic({
    keysDir: input.keysDir,
    path,
    contents: `${JSON.stringify(record, null, 2)}\n`,
    mode: 0o644,
    overwrite: false,
    existsMessage: `key fingerprint file already exists; refusing to overwrite: ${path}`,
  });
  return path;
}

export function readFingerprintFile(keysDir: string, name: string): KeyFingerprintRecord | null {
  const path = fingerprintFilePath(keysDir, name);
  if (!existsSync(path)) {
    return null;
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as KeyFingerprintRecord;
  return parsed;
}

/**
 * File-backed signing tier: `signkey_<name>` signs with the PKCS8 material in
 * `<keysDir>/<name>.pk8`. Returns null when the file is absent so an
 * unconfigured deployment simply has no signer. Custody is re-evaluated at
 * EVERY sign: a key file that is no longer a regular 0600 file inside a 0700
 * directory — or is a symlink — refuses rather than signing with widened
 * material. Material is imported under the same pinned-Ed25519, fixed-message
 * rules as every other tier.
 */
export class FileSigningBroker implements SigningBroker {
  readonly #keysDir: string;

  constructor(keysDir: string) {
    this.#keysDir = keysDir;
  }

  sign(handle: string, bytes: Buffer): Buffer | null {
    const name = handleName(handle);
    // Custody is re-evaluated at EVERY sign on the same opened object that is
    // read: a key file that is no longer a regular 0600 file inside a 0700
    // directory — or is a symlink — refuses rather than signing with widened
    // material.
    const material = readSigningKeyFileChecked(this.#keysDir, name);
    if (material === null || material.length === 0) {
      return null;
    }
    return cryptoSign(null, bytes, importPkcs8(handle, material));
  }
}

/**
 * Generates a fresh Ed25519 keypair, returning base64url PKCS8 + the raw
 * base64url public key. Module-private: key material moves from here into a
 * custody file write and nowhere else.
 */
function generateEd25519KeyMaterial(): {
  pkcs8Base64Url: string;
  publicKeyBase64Url: string;
} {
  const pair = generateKeyPairSync("ed25519");
  const pkcs8Base64Url = pair.privateKey
    .export({ format: "der", type: "pkcs8" })
    .toString("base64url");
  const jwk = pair.publicKey.export({ format: "jwk" }) as { x?: string };
  if (typeof jwk.x !== "string" || jwk.x.length === 0) {
    throw new CustodyError("generated Ed25519 key did not export a public key");
  }
  return { pkcs8Base64Url, publicKeyBase64Url: jwk.x };
}

/**
 * The one sanctioned path from generation to custody: fresh material is
 * written straight to the key file without the private bytes ever being
 * returned to a caller. Used by the dev-bootstrap ceremony.
 */
export function generateSigningKeyFile(input: { keysDir: string; name: string }): {
  keyPath: string;
  publicKeyBase64Url: string;
} {
  const material = generateEd25519KeyMaterial();
  const keyPath = writeSigningKeyFile({
    keysDir: input.keysDir,
    name: input.name,
    pkcs8Base64Url: material.pkcs8Base64Url,
  });
  return { keyPath, publicKeyBase64Url: material.publicKeyBase64Url };
}

/** Derives the raw base64url public key from base64url PKCS8 material. */
export function publicKeyFromPkcs8(pkcs8Base64Url: string): string {
  const jwk = createPublicKey(importPkcs8("signkey_derive", pkcs8Base64Url)).export({
    format: "jwk",
  }) as { x?: string };
  if (typeof jwk.x !== "string" || jwk.x.length === 0) {
    throw new CustodyError("PKCS8 material did not yield an Ed25519 public key");
  }
  return jwk.x;
}

export type CustodyTier = "configured_env" | "file" | "dev_bootstrap";

export type CustodyResolution = {
  tier: CustodyTier;
  handle: string;
  /** Null only for the dev_bootstrap tier, where no key exists yet. */
  broker: SigningBroker | null;
  /** The public key behind the configured tier, when a key exists. */
  publicKeyBase64Url: string | null;
};

/**
 * The documented custody resolution order:
 *
 *   1. an explicitly configured key (OPENMAO_SIGNKEY_<NAME>) — env tier;
 *   2. a file-backed key at <keysRoot>/<workspaceId>/<name>.pk8 — file tier;
 *   3. dev bootstrap — only reachable with an EMPTY principal registry.
 *
 * The directory is DERIVED from the custody root and the workspace id: the
 * pair is never supplied independently, so a mismatched (directory of
 * workspace A, id of workspace B) resolution cannot be expressed at all.
 *
 * Existing valid state always wins: when the registry already holds principals
 * for the workspace, the resolved key must correspond to an active enrolled
 * key. A missing key, or one whose public half matches nothing enrolled, is a
 * start-up REFUSAL — never a silently generated replacement identity. And a
 * key that matches an active key enrolled in ANOTHER workspace is refused
 * even when this workspace's registry is empty: an empty registry licenses
 * dev bootstrap, never the adoption of a foreign identity.
 */
export function resolveCustody(input: {
  env: NodeJS.ProcessEnv;
  keysRoot: string;
  database: Database;
  workspaceId: string;
  name?: string;
}): CustodyResolution {
  const name = input.name ?? DEFAULT_KEY_NAME;
  const handle = `${SIGNING_HANDLE_PREFIX}${name}`;
  const keysDir = workspaceCustodyDir(input.keysRoot, input.workspaceId);
  const registry = new PrincipalStore(input.database).listForWorkspace(input.workspaceId);

  const envBroker = new EnvSigningBroker(input.env);
  const envVarName = `OPENMAO_SIGNKEY_${name.toUpperCase()}`;
  const envValue = input.env[envVarName];
  if (envValue !== undefined && envValue.trim().length > 0) {
    const publicKeyBase64Url = publicKeyFromPkcs8(envValue.trim());
    assertCustodyMatchesRegistry(
      input.database,
      input.workspaceId,
      registry.length,
      publicKeyBase64Url,
      "env",
    );
    return { tier: "configured_env", handle, broker: envBroker, publicKeyBase64Url };
  }

  const fileMaterial = readSigningKeyFileChecked(keysDir, name);
  if (fileMaterial !== null && fileMaterial.length > 0) {
    const publicKeyBase64Url = publicKeyFromPkcs8(fileMaterial);
    assertCustodyMatchesRegistry(
      input.database,
      input.workspaceId,
      registry.length,
      publicKeyBase64Url,
      "file",
    );
    return {
      tier: "file",
      handle,
      broker: new FileSigningBroker(keysDir),
      publicKeyBase64Url,
    };
  }

  if (registry.length > 0) {
    throw new CustodyError(
      `workspace ${input.workspaceId} has principals but no configured or file-backed signing key; refusing to generate a replacement identity`,
    );
  }
  return { tier: "dev_bootstrap", handle, broker: null, publicKeyBase64Url: null };
}

/**
 * Fail-to-start rule: custody that does not map to an active enrolled key of
 * THIS workspace is a misconfiguration, not an invitation to re-mint — and a
 * key that maps to ANOTHER workspace's active enrolled key is refused even
 * with an empty registry, so one workspace's key material can never be
 * adopted as another workspace's identity.
 */
function assertCustodyMatchesRegistry(
  database: Database,
  workspaceId: string,
  registrySize: number,
  publicKeyBase64Url: string,
  tier: string,
): void {
  const keys = new PrincipalKeyStore(database);
  for (const principal of new PrincipalStore(database).listForWorkspace(workspaceId)) {
    for (const key of keys.listForPrincipal(workspaceId, principal.id)) {
      if (key.status === "active" && key.public_key === publicKeyBase64Url) {
        return;
      }
    }
  }
  const foreignHolder = keys.getActiveByPublicKey(publicKeyBase64Url);
  if (foreignHolder !== null && foreignHolder.workspace_id !== workspaceId) {
    throw new CustodyError(
      `${tier} signing key (public fingerprint ${fingerprintForPublicKey(publicKeyBase64Url)}) is an active enrolled key of workspace ${foreignHolder.workspace_id}; refusing to adopt another workspace's identity`,
    );
  }
  if (registrySize === 0) {
    // Pre-ceremony state: an orphan key file with no registry anywhere. The
    // key belongs to no workspace, so holding it is not identity adoption.
    return;
  }
  throw new CustodyError(
    `${tier} signing key (public fingerprint ${fingerprintForPublicKey(publicKeyBase64Url)}) matches no active enrolled key in workspace ${workspaceId}; refusing to start with a mismatched identity`,
  );
}
