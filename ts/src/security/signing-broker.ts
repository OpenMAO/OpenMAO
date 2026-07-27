import { createPrivateKey, sign as cryptoSign, type KeyObject } from "node:crypto";

import { assertNoSensitiveString, SensitiveMaterialError } from "./sensitive-material.js";

/**
 * Signs bytes with the key material behind a non-secret `signkey_*` handle.
 * The custody boundary is the entire contract: callers hand in bytes and
 * receive signatures — there is deliberately no API that returns, resolves,
 * or exposes key material, and none may be added. Key material is never
 * logged, persisted, returned, or embedded in an error message; import
 * failures throw a fixed-message SigningBrokerError that names only the
 * (validated, non-secret) handle.
 */
export type SigningBroker = {
  sign(handle: string, bytes: Buffer): Buffer | null | Promise<Buffer | null>;
};

export class SigningBrokerError extends Error {}

const SIGNING_HANDLE_PREFIX = "signkey_";
const DEFAULT_ENV_PREFIX = "OPENMAO_SIGNKEY_";
const ENV_HANDLE_NAME = /^[a-z0-9_]+$/;
const SIGNING_HANDLE_PATTERN = /^signkey_[A-Za-z0-9_.:-]+$/;

export function validateSigningHandle(handle: string): void {
  if (!SIGNING_HANDLE_PATTERN.test(handle)) {
    throw new SensitiveMaterialError("signing handle must be a non-secret signkey_* identifier");
  }
  assertNoSensitiveString(handle, "signing_handle");
}

function handleToEnvKey(handle: string, prefix: string): string {
  const name = handle.slice(SIGNING_HANDLE_PREFIX.length);
  // Environment variable names can only carry [A-Z0-9_]. Restrict the handle
  // name to lowercase letters, digits, and underscores so the handle -> env-key
  // map is injective: without this, `signkey_foo.bar`, `signkey_foo-bar`, and
  // `signkey_foo_bar` would all collapse onto OPENMAO_SIGNKEY_FOO_BAR and
  // could sign with the wrong key. StaticSigningBroker has no such restriction.
  if (!ENV_HANDLE_NAME.test(name)) {
    throw new SigningBrokerError(
      "EnvSigningBroker handles must match signkey_<name> with only lowercase letters, digits, and underscores",
    );
  }
  return `${prefix}${name.toUpperCase()}`;
}

/**
 * Imports base64/base64url PKCS8 DER key material. Any failure throws a
 * fixed-message error: the material itself must never appear in a message,
 * log, or stack-adjacent string. The algorithm is pinned to Ed25519 here too:
 * `crypto.sign(null, …)` derives its behaviour from whatever key it is handed,
 * so a non-Ed25519 key is refused at import rather than signed with silently.
 * Exported for the file-backed custody tier in key-custody.ts, which imports
 * under exactly the same rules.
 */
export function importPkcs8(handle: string, material: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey({
      key: Buffer.from(material, "base64url"),
      format: "der",
      type: "pkcs8",
    });
  } catch {
    throw new SigningBrokerError(`signing key material is not valid PKCS8 for handle: ${handle}`);
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new SigningBrokerError(`signing key material is not Ed25519 for handle: ${handle}`);
  }
  return key;
}

const LOOPBACK_BINDINGS = new Set(["127.0.0.1", "localhost", "::1", "::ffff:127.0.0.1"]);

/**
 * Signals under which the env tier must refuse to operate: an explicit
 * production environment, or a configured non-loopback bind address (a
 * development convenience must not be reachable from a network surface).
 * Returns the NAMES of triggered signals only — never values.
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

/**
 * Signs with key material held in environment variables: `signkey_operator`
 * reads `OPENMAO_SIGNKEY_OPERATOR`, expected to hold base64/base64url PKCS8
 * DER. Returns null when the variable is absent or empty so an unconfigured
 * deployment simply has no signer. The env tier is a development convenience:
 * the refusal to operate under production-ish signals lives HERE, inside the
 * broker, so an embedding consumer cannot bypass it by constructing the
 * broker directly.
 */
export class EnvSigningBroker implements SigningBroker {
  // ECMAScript-private fields: the custody boundary is runtime-enforced, not
  // TypeScript-only. Neither enumeration, serialization, nor a cast can reach
  // the key store.
  readonly #env: NodeJS.ProcessEnv;
  readonly #prefix: string;

  constructor(env: NodeJS.ProcessEnv = process.env, prefix: string = DEFAULT_ENV_PREFIX) {
    this.#env = env;
    this.#prefix = prefix;
  }

  sign(handle: string, bytes: Buffer): Buffer | null {
    validateSigningHandle(handle);
    const signals = productionSignals(this.#env);
    if (signals.length > 0) {
      throw new SigningBrokerError(
        `env signing tier refuses to operate in production (${signals.join(", ")})`,
      );
    }
    const value = this.#env[handleToEnvKey(handle, this.#prefix)];
    if (value === undefined || value.trim().length === 0) {
      return null;
    }
    return cryptoSign(null, bytes, importPkcs8(handle, value.trim()));
  }
}

/**
 * In-memory broker for deterministic demos and tests. Holds an explicit
 * handle -> base64/base64url PKCS8 map; never reads the environment.
 */
export class StaticSigningBroker implements SigningBroker {
  readonly #handles: Map<string, string>;

  constructor(handles: Record<string, string> = {}) {
    this.#handles = new Map(Object.entries(handles));
  }

  sign(handle: string, bytes: Buffer): Buffer | null {
    validateSigningHandle(handle);
    const value = this.#handles.get(handle);
    if (value === undefined || value.trim().length === 0) {
      return null;
    }
    return cryptoSign(null, bytes, importPkcs8(handle, value.trim()));
  }
}

export function isSigningBroker(value: unknown): value is SigningBroker {
  return typeof (value as { sign?: unknown } | null)?.sign === "function";
}
