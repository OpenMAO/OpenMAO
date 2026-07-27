import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
import { dumpJson } from "../src/persistence/serialization.js";
import {
  CustodyError,
  FileSigningBroker,
  keyFilePath,
  resolveCustody,
  workspaceCustodyDir,
  writeFingerprintFile,
  writeSigningKeyFile,
} from "../src/security/key-custody.js";
import { bootstrapRootOperator } from "../src/security/principal-bootstrap.js";
import { assertNoSensitiveString } from "../src/security/sensitive-material.js";
import {
  buildProtectedHeader,
  encodeSegment,
  loadVerificationKeys,
  payloadBytesForBody,
  signObject,
  verifyObject,
} from "../src/security/signing.js";
import { EnvSigningBroker } from "../src/security/signing-broker.js";

const WORKSPACE = `ws_${"a".repeat(32)}`;
const WORKSPACE_B = `ws_${"b".repeat(32)}`;
const NOW = "2026-07-26T12:00:00Z";

/**
 * Test-local keypair generation: custody tests must not import key material
 * out of the custody module — the module's own generator/readers are
 * module-private, and tests read file bytes with fs directly.
 */
function freshKeyMaterial(): { pkcs8Base64Url: string; publicKeyBase64Url: string } {
  const pair = generateKeyPairSync("ed25519");
  const pkcs8Base64Url = pair.privateKey
    .export({ format: "der", type: "pkcs8" })
    .toString("base64url");
  const jwk = pair.publicKey.export({ format: "jwk" }) as { x: string };
  return { pkcs8Base64Url, publicKeyBase64Url: jwk.x };
}

function readKeyFile(keysDir: string, name: string): string {
  return readFileSync(keyFilePath(keysDir, name), "utf8").trim();
}

function dirEntries(dirPath: string): string[] {
  return readdirSync(dirPath).sort();
}

let dir: string;
let keysDir: string;
let database: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "openmao-custody-hardening-"));
  keysDir = join(dir, "keys");
  database = new Database(join(dir, "openmao.sqlite3"));
  database.initialize();
  const workspaces = new WorkspaceStore(database);
  workspaces.save(WorkspaceSchema.parse({ id: WORKSPACE, name: "A", created_at: NOW }));
  workspaces.save(WorkspaceSchema.parse({ id: WORKSPACE_B, name: "B", created_at: NOW }));
});

afterEach(() => {
  database.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("atomic custody writes", () => {
  it("leaves no orphaned temp files after a successful key write", () => {
    const material = freshKeyMaterial();
    writeSigningKeyFile({ keysDir, name: "operator", pkcs8Base64Url: material.pkcs8Base64Url });
    expect(dirEntries(keysDir)).toEqual(["operator.pk8"]);
    expect(statSync(keyFilePath(keysDir, "operator")).mode & 0o777).toBe(0o600);
    expect(statSync(keysDir).mode & 0o777).toBe(0o700);
  });

  it("refuses to overwrite an existing key file and keeps the original bytes, atomically", () => {
    const material = freshKeyMaterial();
    writeSigningKeyFile({ keysDir, name: "operator", pkcs8Base64Url: material.pkcs8Base64Url });
    expect(() =>
      writeSigningKeyFile({
        keysDir,
        name: "operator",
        pkcs8Base64Url: freshKeyMaterial().pkcs8Base64Url,
      }),
    ).toThrow(CustodyError);
    expect(readKeyFile(keysDir, "operator")).toBe(material.pkcs8Base64Url);
    expect(dirEntries(keysDir)).toEqual(["operator.pk8"]);
  });

  it("refuses to overwrite an existing fingerprint file without leaving temp debris", () => {
    const material = freshKeyMaterial();
    writeFingerprintFile({
      keysDir,
      name: "operator",
      publicKeyBase64Url: material.publicKeyBase64Url,
    });
    expect(() =>
      writeFingerprintFile({
        keysDir,
        name: "operator",
        publicKeyBase64Url: material.publicKeyBase64Url,
      }),
    ).toThrow(CustodyError);
    expect(dirEntries(keysDir)).toEqual(["operator.fingerprint"]);
  });
});

describe("use-time custody checks", () => {
  it("FileSigningBroker refuses a key file whose mode is no longer 0600", () => {
    const material = freshKeyMaterial();
    const path = writeSigningKeyFile({
      keysDir,
      name: "operator",
      pkcs8Base64Url: material.pkcs8Base64Url,
    });
    const broker = new FileSigningBroker(keysDir);
    expect(broker.sign("signkey_operator", Buffer.from("x"))).not.toBeNull();
    chmodSync(path, 0o644);
    expect(() => broker.sign("signkey_operator", Buffer.from("x"))).toThrow(CustodyError);
  });

  it("FileSigningBroker refuses when the keys directory is no longer 0700", () => {
    const material = freshKeyMaterial();
    writeSigningKeyFile({ keysDir, name: "operator", pkcs8Base64Url: material.pkcs8Base64Url });
    chmodSync(keysDir, 0o755);
    const broker = new FileSigningBroker(keysDir);
    expect(() => broker.sign("signkey_operator", Buffer.from("x"))).toThrow(CustodyError);
  });

  it("FileSigningBroker refuses a symlinked keys DIRECTORY too", () => {
    const material = freshKeyMaterial();
    const realDir = join(dir, "real-keys");
    mkdirSync(realDir, { recursive: true });
    chmodSync(realDir, 0o700);
    writeFileSync(join(realDir, "operator.pk8"), material.pkcs8Base64Url, { mode: 0o600 });
    symlinkSync(realDir, keysDir);
    const broker = new FileSigningBroker(keysDir);
    expect(() => broker.sign("signkey_operator", Buffer.from("x"))).toThrow(CustodyError);
  });

  it("FileSigningBroker refuses a symlinked key file even at 0600", () => {
    const material = freshKeyMaterial();
    const realPath = join(dir, "elsewhere.pk8");
    writeFileSync(realPath, material.pkcs8Base64Url, { mode: 0o600 });
    mkdirSync(keysDir, { recursive: true });
    chmodSync(keysDir, 0o700);
    symlinkSync(realPath, keyFilePath(keysDir, "operator"));
    const broker = new FileSigningBroker(keysDir);
    expect(() => broker.sign("signkey_operator", Buffer.from("x"))).toThrow(CustodyError);
  });

  it("resolveCustody refuses a widened key file rather than silently accepting it", () => {
    const material = freshKeyMaterial();
    const wsDir = workspaceCustodyDir(keysDir, WORKSPACE);
    const path = writeSigningKeyFile({
      keysDir: wsDir,
      name: "operator",
      pkcs8Base64Url: material.pkcs8Base64Url,
    });
    chmodSync(path, 0o640);
    expect(() =>
      resolveCustody({ env: {}, keysRoot: keysDir, database, workspaceId: WORKSPACE }),
    ).toThrow(CustodyError);
  });
});

describe("workspace-namespaced custody", () => {
  it("workspaceCustodyDir derives a stable per-workspace directory under the shared root", () => {
    const a = workspaceCustodyDir(keysDir, WORKSPACE);
    const b = workspaceCustodyDir(keysDir, WORKSPACE_B);
    expect(a).not.toBe(b);
    expect(a.startsWith(keysDir)).toBe(true);
    expect(b.startsWith(keysDir)).toBe(true);
  });

  it("two workspaces bootstrap independently into the same shared keys root", () => {
    const a = bootstrapRootOperator({
      database,
      workspaceId: WORKSPACE,
      keysDir: workspaceCustodyDir(keysDir, WORKSPACE),
      now: NOW,
    });
    const b = bootstrapRootOperator({
      database,
      workspaceId: WORKSPACE_B,
      keysDir: workspaceCustodyDir(keysDir, WORKSPACE_B),
      now: NOW,
    });
    expect(a.key_path).not.toBe(b.key_path);
    expect(a.principal_id).not.toBe(b.principal_id);
    expect(existsSync(a.key_path)).toBe(true);
    expect(existsSync(b.key_path)).toBe(true);
    expect(existsSync(a.profile_path)).toBe(true);
    expect(existsSync(b.profile_path)).toBe(true);
    expect(statSync(workspaceCustodyDir(keysDir, WORKSPACE)).mode & 0o777).toBe(0o700);
  });

  it("workspace A's key file does not resolve as custody for empty workspace B", () => {
    const material = freshKeyMaterial();
    writeSigningKeyFile({
      keysDir: workspaceCustodyDir(keysDir, WORKSPACE),
      name: "operator",
      pkcs8Base64Url: material.pkcs8Base64Url,
    });
    // The resolver takes a ROOT and derives B's directory itself: there is no
    // argument pair with which a caller could point B at A's directory.
    const resolution = resolveCustody({
      env: {},
      keysRoot: keysDir,
      database,
      workspaceId: WORKSPACE_B,
    });
    expect(resolution.tier).toBe("dev_bootstrap");
    expect(resolution.broker).toBeNull();
  });

  it("workspace A's enrolled key placed in B's custody directory is refused, even with B's registry empty", () => {
    // The mismatched-argument attack, at the only layer it can still be
    // attempted: the filesystem. A's key is an ACTIVE ENROLLED identity; an
    // empty registry for B licenses dev bootstrap, never the adoption of A's
    // key. The old empty-registry early-return waved this through.
    const a = bootstrapRootOperator({
      database,
      workspaceId: WORKSPACE,
      keysDir: workspaceCustodyDir(keysDir, WORKSPACE),
      now: NOW,
    });
    const bDir = workspaceCustodyDir(keysDir, WORKSPACE_B);
    mkdirSync(bDir, { recursive: true });
    chmodSync(bDir, 0o700);
    writeFileSync(keyFilePath(bDir, "operator"), readFileSync(a.key_path, "utf8"), {
      mode: 0o600,
    });
    expect(() =>
      resolveCustody({ env: {}, keysRoot: keysDir, database, workspaceId: WORKSPACE_B }),
    ).toThrow(/another workspace's identity/);
  });

  it("custody creation refuses a symlinked keys directory before any mkdir or chmod follows it", () => {
    const realDir = join(dir, "real-target");
    mkdirSync(realDir, { recursive: true });
    chmodSync(realDir, 0o755);
    const linkedDir = join(dir, "linked-keys");
    symlinkSync(realDir, linkedDir);
    expect(() =>
      writeSigningKeyFile({
        keysDir: linkedDir,
        name: "operator",
        pkcs8Base64Url: freshKeyMaterial().pkcs8Base64Url,
      }),
    ).toThrow(CustodyError);
    // Nothing landed outside the custody root, and the target was not
    // re-moded: mkdir/chmod never followed the link.
    expect(dirEntries(realDir)).toEqual([]);
    expect(statSync(realDir).mode & 0o777).toBe(0o755);
  });

  it("write paths validate key names: a name carrying separators cannot escape the custody dir", () => {
    const material = freshKeyMaterial();
    expect(() =>
      writeSigningKeyFile({ keysDir, name: "../escape", pkcs8Base64Url: material.pkcs8Base64Url }),
    ).toThrow(CustodyError);
    expect(() =>
      writeFingerprintFile({
        keysDir,
        name: "../escape",
        publicKeyBase64Url: material.publicKeyBase64Url,
      }),
    ).toThrow(CustodyError);
    expect(existsSync(join(dir, "escape.pk8"))).toBe(false);
    expect(existsSync(join(dir, "escape.fingerprint"))).toBe(false);
  });
});

describe("env broker production refusal is inside the broker", () => {
  it("EnvSigningBroker refuses to sign under a production-ish signal", () => {
    const material = freshKeyMaterial();
    const broker = new EnvSigningBroker({
      OPENMAO_SIGNKEY_OPERATOR: material.pkcs8Base64Url,
      NODE_ENV: "production",
    });
    expect(() => broker.sign("signkey_operator", Buffer.from("x"))).toThrow(
      /refuses to operate in production/,
    );
  });

  it("EnvSigningBroker still signs under development signals", () => {
    const material = freshKeyMaterial();
    const broker = new EnvSigningBroker({ OPENMAO_SIGNKEY_OPERATOR: material.pkcs8Base64Url });
    expect(broker.sign("signkey_operator", Buffer.from("x"))).not.toBeNull();
  });
});

describe("registry-backed verification key loader", () => {
  function bootstrapDev() {
    return bootstrapRootOperator({ database, workspaceId: WORKSPACE, keysDir, now: NOW });
  }

  function envelopeFor(input: {
    keyId: string;
    principalId: string;
    objectId: string;
    pkcs8Base64Url: string;
  }) {
    const body = {
      workspace_id: WORKSPACE,
      object_id: input.objectId,
      signer: input.principalId,
      decision: "approved",
      decided_at: NOW,
    };
    const privateKey = createPrivateKey({
      key: Buffer.from(input.pkcs8Base64Url, "base64url"),
      format: "der",
      type: "pkcs8",
    });
    const signed = signObject({
      objectClass: "governance_decision",
      keyId: input.keyId,
      body,
      privateKey,
    });
    const headerSegment = encodeSegment(
      Buffer.from(dumpJson(buildProtectedHeader("governance_decision", input.keyId)), "utf8"),
    );
    return {
      protectedHeaderSegment: headerSegment,
      payloadSegment: encodeSegment(payloadBytesForBody(body)),
      signatureSegment: signed.signatureSegment,
    };
  }

  it("a dev-bootstrap key reports development_bootstrap trust derived from stored state — the caller presents no flag at all", () => {
    const result = bootstrapDev();
    const envelope = envelopeFor({
      keyId: result.key_id,
      principalId: result.principal_id,
      objectId: "appr_loader_1",
      pkcs8Base64Url: readKeyFile(keysDir, "operator"),
    });
    // The verifier receives a database, not keys: there is no caller-supplied
    // trust flag anywhere on this path.
    const verdict = verifyObject({
      database,
      workspaceId: WORKSPACE,
      expectedClass: "governance_decision",
      expectedObjectId: "appr_loader_1",
      envelope,
      now: NOW,
    });
    expect(verdict).toEqual({
      ok: true,
      objectClass: "governance_decision",
      keyId: result.key_id,
      signerPrincipalId: result.principal_id,
      trust: "development_bootstrap",
    });
  });

  it("a hand-built key set cannot reach the verifier — the caller-supplied-keys parameter is gone", () => {
    const result = bootstrapDev();
    const envelope = envelopeFor({
      keyId: result.key_id,
      principalId: result.principal_id,
      objectId: "appr_smuggled",
      pkcs8Base64Url: readKeyFile(keysDir, "operator"),
    });
    // The old probe: a hand-built key omitting dev_bootstrap reported
    // trust:"standard". Smuggle the same crafted key set in through a cast —
    // it is ignored; only the registry decides, and the registry says
    // dev-bootstrap. The trust label cannot be made "standard" by any input.
    const smuggledKeys = [
      {
        keyId: result.key_id,
        publicKeyBase64Url: result.public_key,
        ownerPrincipalId: result.principal_id,
        enrolled: true,
        status: "active" as const,
        validUntil: null,
        conditions: [],
        dev_bootstrap: false,
      },
    ];
    const verdict = verifyObject({
      database,
      workspaceId: WORKSPACE,
      expectedClass: "governance_decision",
      expectedObjectId: "appr_smuggled",
      envelope,
      now: NOW,
      keys: smuggledKeys,
    } as unknown as Parameters<typeof verifyObject>[0]);
    expect(verdict).toEqual({
      ok: true,
      objectClass: "governance_decision",
      keyId: result.key_id,
      signerPrincipalId: result.principal_id,
      trust: "development_bootstrap",
    });
  });

  it("a signature under an unenrolled key is unknown_key even when a crafted caller key claims it", () => {
    bootstrapDev();
    const stranger = freshKeyMaterial();
    const envelope = envelopeFor({
      keyId: "prinkey_stranger",
      principalId: "principal_stranger",
      objectId: "appr_stranger",
      pkcs8Base64Url: stranger.pkcs8Base64Url,
    });
    const crafted = [
      {
        keyId: "prinkey_stranger",
        publicKeyBase64Url: stranger.publicKeyBase64Url,
        ownerPrincipalId: "principal_stranger",
        enrolled: true,
        status: "active" as const,
        validUntil: null,
        conditions: [],
        dev_bootstrap: false,
      },
    ];
    const verdict = verifyObject({
      database,
      workspaceId: WORKSPACE,
      expectedClass: "governance_decision",
      expectedObjectId: "appr_stranger",
      envelope,
      now: NOW,
      keys: crafted,
    } as unknown as Parameters<typeof verifyObject>[0]);
    expect(verdict).toEqual({ ok: false, reason: "unknown_key", keyId: "prinkey_stranger" });
  });

  it("a disabled principal's keys verify as revoked — the loader consults principal standing", () => {
    const result = bootstrapDev();
    const envelope = envelopeFor({
      keyId: result.key_id,
      principalId: result.principal_id,
      objectId: "appr_disabled",
      pkcs8Base64Url: readKeyFile(keysDir, "operator"),
    });
    new PrincipalStore(database).setStatus(result.principal_id, "disabled");
    const verdict = verifyObject({
      database,
      workspaceId: WORKSPACE,
      expectedClass: "governance_decision",
      expectedObjectId: "appr_disabled",
      envelope,
      now: NOW,
    });
    expect(verdict).toEqual({ ok: false, reason: "key_revoked", keyId: result.key_id });
  });

  it("the loader's trust label cannot be spoofed in either direction", () => {
    const dev = bootstrapDev();
    const material = freshKeyMaterial();
    const principalId = `principal_${"c".repeat(32)}`;
    const keyId = `prinkey_${"d".repeat(32)}`;
    new PrincipalStore(database).create({
      id: principalId,
      workspace_id: WORKSPACE,
      kind: "human",
      display_name: "Enrolled Human",
      created_at: NOW,
    });
    new PrincipalKeyStore(database).create({
      id: keyId,
      workspace_id: WORKSPACE,
      principal_id: principalId,
      public_key: material.publicKeyBase64Url,
      valid_from: NOW,
      created_at: NOW,
    });

    const keys = loadVerificationKeys(database, WORKSPACE);
    const byId = new Map(keys.map((key) => [key.keyId, key]));
    // Stored truth: the dev key is flagged, the ordinary key is not — and the
    // flag's provenance is the stored principal row, not any caller input.
    expect(byId.get(dev.key_id)?.dev_bootstrap).toBe(true);
    expect(byId.get(keyId)?.dev_bootstrap).toBe(false);

    const verdict = verifyObject({
      database,
      workspaceId: WORKSPACE,
      expectedClass: "governance_decision",
      expectedObjectId: "appr_loader_2",
      envelope: envelopeFor({
        keyId,
        principalId,
        objectId: "appr_loader_2",
        pkcs8Base64Url: material.pkcs8Base64Url,
      }),
      now: NOW,
    });
    expect(verdict.ok && verdict.trust).toBe("standard");
  });

  it("the loader carries stored key standing through to the verifier", () => {
    const dev = bootstrapDev();
    new PrincipalKeyStore(database).revoke(dev.key_id);
    const key = loadVerificationKeys(database, WORKSPACE).find(
      (candidate) => candidate.keyId === dev.key_id,
    );
    expect(key?.status).toBe("revoked");
  });
});

describe("the scrubber catches operator tokens", () => {
  it("assertNoSensitiveString flags prt_ tokens", () => {
    const token = `prt_${"ab".repeat(32)}`;
    expect(() => assertNoSensitiveString(token, "stdout")).toThrow();
    expect(() => assertNoSensitiveString(`token: ${token}`, "stdout")).toThrow();
  });
});

describe("public surface never returns key material", () => {
  it("key-custody's exported API includes no function returning private key bytes", async () => {
    const custody = await import("../src/security/key-custody.js");
    expect("readSigningKeyFile" in custody).toBe(false);
    expect("generateEd25519KeyMaterial" in custody).toBe(false);
    const result = bootstrapRootOperator({ database, workspaceId: WORKSPACE, keysDir, now: NOW });
    expect(JSON.stringify(result)).not.toContain(readKeyFile(keysDir, "operator"));
  });
});
