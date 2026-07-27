import { createPublicKey, verify as cryptoVerify, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceSchema } from "../src/contracts/index.js";
import {
  Database,
  PrincipalKeyStore,
  PrincipalStore,
  WorkspaceStore,
} from "../src/persistence/index.js";
import {
  CustodyError,
  FileSigningBroker,
  fingerprintForPublicKey,
  keyFilePath,
  productionSignals,
  publicKeyFromPkcs8,
  readFingerprintFile,
  resolveCustody,
  workspaceCustodyDir,
  writeFingerprintFile,
  writeSigningKeyFile,
} from "../src/security/key-custody.js";
import { bootstrapRootOperator } from "../src/security/principal-bootstrap.js";
import { assertNoSensitiveString } from "../src/security/sensitive-material.js";

/**
 * Test-local keypair generation: the custody module's own generator is
 * module-private — no exported surface returns key material — so tests
 * generate their own and read file bytes with fs directly.
 */
function generateEd25519KeyMaterial(): { pkcs8Base64Url: string; publicKeyBase64Url: string } {
  const pair = generateKeyPairSync("ed25519");
  return {
    pkcs8Base64Url: pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"),
    publicKeyBase64Url: (pair.publicKey.export({ format: "jwk" }) as { x: string }).x,
  };
}

function readSigningKeyFile(keysDir: string, name: string): string | null {
  const path = keyFilePath(keysDir, name);
  if (!existsSync(path)) {
    return null;
  }
  return readFileSync(path, "utf8").trim();
}

const WORKSPACE = `ws_${"a".repeat(32)}`;
const NOW = "2026-07-26T12:00:00Z";

let dir: string;
let keysRoot: string;
let keysDir: string;
let database: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "openmao-custody-"));
  keysRoot = join(dir, "keys");
  keysDir = workspaceCustodyDir(keysRoot, WORKSPACE);
  database = new Database(join(dir, "openmao.sqlite3"));
  database.initialize();
  new WorkspaceStore(database).save(
    WorkspaceSchema.parse({ id: WORKSPACE, name: "Custody Test", created_at: NOW }),
  );
});

afterEach(() => {
  database.close();
  rmSync(dir, { recursive: true, force: true });
});

function enrolPrincipalWithKey(publicKeyBase64Url: string): { principalId: string; keyId: string } {
  const principalId = `principal_${"b".repeat(32)}`;
  const keyId = `prinkey_${"c".repeat(32)}`;
  new PrincipalStore(database).create({
    id: principalId,
    workspace_id: WORKSPACE,
    kind: "human",
    display_name: "Enrolled Operator",
    created_at: NOW,
  });
  new PrincipalKeyStore(database).create({
    id: keyId,
    workspace_id: WORKSPACE,
    principal_id: principalId,
    public_key: publicKeyBase64Url,
    valid_from: NOW,
    created_at: NOW,
  });
  return { principalId, keyId };
}

describe("file-backed custody tier", () => {
  it("writes the key file at mode 0600 and the keys directory at mode 0700 — asserted, not intended", () => {
    const material = generateEd25519KeyMaterial();
    const path = writeSigningKeyFile({
      keysDir,
      name: "operator",
      pkcs8Base64Url: material.pkcs8Base64Url,
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(keysDir).mode & 0o777).toBe(0o700);
  });

  it("refuses to overwrite an existing key file", () => {
    const material = generateEd25519KeyMaterial();
    writeSigningKeyFile({ keysDir, name: "operator", pkcs8Base64Url: material.pkcs8Base64Url });
    expect(() =>
      writeSigningKeyFile({
        keysDir,
        name: "operator",
        pkcs8Base64Url: generateEd25519KeyMaterial().pkcs8Base64Url,
      }),
    ).toThrow(CustodyError);
    // The original material survives the refused overwrite.
    expect(readSigningKeyFile(keysDir, "operator")).toBe(material.pkcs8Base64Url);
  });

  it("signs through the FileSigningBroker without any API returning key material", () => {
    const material = generateEd25519KeyMaterial();
    writeSigningKeyFile({ keysDir, name: "operator", pkcs8Base64Url: material.pkcs8Base64Url });
    const broker = new FileSigningBroker(keysDir);
    const bytes = Buffer.from("custody test bytes", "utf8");
    const signature = broker.sign("signkey_operator", bytes);
    if (!signature) {
      throw new Error("expected a signature from the file tier");
    }
    const publicKey = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: material.publicKeyBase64Url },
      format: "jwk",
    });
    expect(cryptoVerify(null, bytes, publicKey, signature)).toBe(true);
  });

  it("returns null for a missing key file, and rejects non-injective handles", () => {
    const broker = new FileSigningBroker(keysDir);
    expect(broker.sign("signkey_absent", Buffer.from("x"))).toBeNull();
    expect(() => broker.sign("signkey_BAD.NAME", Buffer.from("x"))).toThrow(CustodyError);
  });

  it("round-trips the fingerprint file beside the key and never touches private material", () => {
    const material = generateEd25519KeyMaterial();
    writeFingerprintFile({
      keysDir,
      name: "operator",
      publicKeyBase64Url: material.publicKeyBase64Url,
    });
    const record = readFingerprintFile(keysDir, "operator");
    expect(record?.algorithm).toBe("ed25519");
    expect(record?.public_key).toBe(material.publicKeyBase64Url);
    expect(record?.fingerprint).toBe(fingerprintForPublicKey(material.publicKeyBase64Url));
    expect(() =>
      writeFingerprintFile({
        keysDir,
        name: "operator",
        publicKeyBase64Url: material.publicKeyBase64Url,
      }),
    ).toThrow(CustodyError);
  });

  it("derives the public key from PKCS8 material", () => {
    const material = generateEd25519KeyMaterial();
    expect(publicKeyFromPkcs8(material.pkcs8Base64Url)).toBe(material.publicKeyBase64Url);
  });
});

describe("production-ish signal detection", () => {
  it("flags NODE_ENV=production and non-loopback bindings by NAME only", () => {
    expect(productionSignals({})).toEqual([]);
    expect(productionSignals({ NODE_ENV: "development" })).toEqual([]);
    expect(productionSignals({ NODE_ENV: "production" })).toEqual(["NODE_ENV=production"]);
    expect(productionSignals({ OPENMAO_HOST: "127.0.0.1" })).toEqual([]);
    expect(productionSignals({ OPENMAO_HOST: "localhost" })).toEqual([]);
    expect(productionSignals({ OPENMAO_BIND: "0.0.0.0" })).toEqual([
      "OPENMAO_BIND is non-loopback",
    ]);
  });
});

describe("custody resolution order", () => {
  it("falls to dev_bootstrap only when no key is configured AND the registry is empty", () => {
    const resolution = resolveCustody({ env: {}, keysRoot, database, workspaceId: WORKSPACE });
    expect(resolution.tier).toBe("dev_bootstrap");
    expect(resolution.broker).toBeNull();
    expect(resolution.publicKeyBase64Url).toBeNull();
  });

  it("uses the file-backed tier when a key file exists", () => {
    const material = generateEd25519KeyMaterial();
    writeSigningKeyFile({ keysDir, name: "operator", pkcs8Base64Url: material.pkcs8Base64Url });
    const resolution = resolveCustody({ env: {}, keysRoot, database, workspaceId: WORKSPACE });
    expect(resolution.tier).toBe("file");
    expect(resolution.publicKeyBase64Url).toBe(material.publicKeyBase64Url);
    expect(resolution.broker?.sign(resolution.handle, Buffer.from("x"))).not.toBeNull();
  });

  it("prefers an explicitly configured env key over the file tier", () => {
    const envMaterial = generateEd25519KeyMaterial();
    writeSigningKeyFile({
      keysDir,
      name: "operator",
      pkcs8Base64Url: generateEd25519KeyMaterial().pkcs8Base64Url,
    });
    const resolution = resolveCustody({
      env: { OPENMAO_SIGNKEY_OPERATOR: envMaterial.pkcs8Base64Url },
      keysRoot,
      database,
      workspaceId: WORKSPACE,
    });
    expect(resolution.tier).toBe("configured_env");
    expect(resolution.publicKeyBase64Url).toBe(envMaterial.publicKeyBase64Url);
  });

  it("refuses the env tier under a production-ish signal — inside the broker, at sign time", () => {
    // The refusal moved inside EnvSigningBroker.sign: resolution returns the
    // broker, and any attempt to actually SIGN under a production-ish signal
    // refuses — an embedding consumer cannot bypass the invariant by
    // constructing the broker directly.
    const envMaterial = generateEd25519KeyMaterial();
    const resolution = resolveCustody({
      env: { OPENMAO_SIGNKEY_OPERATOR: envMaterial.pkcs8Base64Url, NODE_ENV: "production" },
      keysRoot,
      database,
      workspaceId: WORKSPACE,
    });
    expect(resolution.tier).toBe("configured_env");
    expect(() => resolution.broker?.sign(resolution.handle, Buffer.from("x"))).toThrow(
      /refuses to operate in production/,
    );
  });

  it("FAILS TO START when the registry has principals but no key is configured", () => {
    enrolPrincipalWithKey(generateEd25519KeyMaterial().publicKeyBase64Url);
    expect(() => resolveCustody({ env: {}, keysRoot, database, workspaceId: WORKSPACE })).toThrow(
      /refusing to generate a replacement identity/,
    );
  });

  it("FAILS TO START when the configured key matches no enrolled active key", () => {
    enrolPrincipalWithKey(generateEd25519KeyMaterial().publicKeyBase64Url);
    writeSigningKeyFile({
      keysDir,
      name: "operator",
      pkcs8Base64Url: generateEd25519KeyMaterial().pkcs8Base64Url,
    });
    expect(() => resolveCustody({ env: {}, keysRoot, database, workspaceId: WORKSPACE })).toThrow(
      /matches no active enrolled key/,
    );
  });

  it("accepts custody that matches an enrolled active key (existing valid state wins)", () => {
    const result = bootstrapRootOperator({ database, workspaceId: WORKSPACE, keysDir, now: NOW });
    const resolution = resolveCustody({ env: {}, keysRoot, database, workspaceId: WORKSPACE });
    expect(resolution.tier).toBe("file");
    expect(resolution.publicKeyBase64Url).toBe(result.public_key);
  });

  it("keeps key material out of every error message the resolver produces", () => {
    const enrolled = generateEd25519KeyMaterial();
    const configured = generateEd25519KeyMaterial();
    enrolPrincipalWithKey(enrolled.publicKeyBase64Url);
    writeSigningKeyFile({ keysDir, name: "operator", pkcs8Base64Url: configured.pkcs8Base64Url });
    let message = "";
    try {
      resolveCustody({ env: {}, keysRoot, database, workspaceId: WORKSPACE });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toBe("");
    expect(message).not.toContain(configured.pkcs8Base64Url);
    expect(message).not.toContain(enrolled.pkcs8Base64Url);
    // The scrubber agrees: nothing secret-shaped in the message.
    expect(() => assertNoSensitiveString(message, "error")).not.toThrow();
  });
});
