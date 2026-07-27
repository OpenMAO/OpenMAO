import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { WorkspaceSchema } from "../src/contracts/index.js";
import {
  Database,
  EventStore,
  PrincipalKeyAttestationStore,
  PrincipalKeyRevocationStore,
  PrincipalKeyStore,
  PrincipalStore,
  WorkspaceStore,
} from "../src/persistence/index.js";
import { dumpJson } from "../src/persistence/serialization.js";
import {
  authenticateFromProfile,
  resolveCliPrincipal,
} from "../src/security/authenticated-principal.js";
import {
  fingerprintForPublicKey,
  keyFilePath,
  workspaceCustodyDir,
} from "../src/security/key-custody.js";
import { PrincipalAuthService } from "../src/security/principal-auth.js";
import {
  BootstrapRefusedError,
  bootstrapRootOperator,
  ensureRootOperator,
  PRINCIPAL_BOOTSTRAPPED_EVENT,
} from "../src/security/principal-bootstrap.js";
import { assertNoSensitiveMaterial } from "../src/security/sensitive-material.js";
import {
  buildProtectedHeader,
  encodeSegment,
  payloadBytesForBody,
  type SignedObjectClass,
  signObject,
  verifyObject,
} from "../src/security/signing.js";

const WORKSPACE = `ws_${"a".repeat(32)}`;
const NOW = "2026-07-26T12:00:00Z";

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

function capture(): { lines: string[]; write: (message: string) => void } {
  const lines: string[] = [];
  return { lines, write: (message) => lines.push(message) };
}

let dir: string;
let dbPath: string;
let keysDir: string;
let database: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "openmao-bootstrap-"));
  dbPath = join(dir, "openmao.sqlite3");
  // Custody is namespaced per workspace; the CLI resolves the same path.
  keysDir = workspaceCustodyDir(join(dir, "keys"), WORKSPACE);
  database = new Database(dbPath);
  database.initialize();
  new WorkspaceStore(database).save(
    WorkspaceSchema.parse({ id: WORKSPACE, name: "Bootstrap Test", created_at: NOW }),
  );
});

afterEach(() => {
  database.close();
  rmSync(dir, { recursive: true, force: true });
});

function bootstrap() {
  return bootstrapRootOperator({ database, workspaceId: WORKSPACE, keysDir, now: NOW });
}

function bootstrappedEvents() {
  return new EventStore(database)
    .listForWorkspace(WORKSPACE)
    .filter((event) => event.kind === PRINCIPAL_BOOTSTRAPPED_EVENT);
}

describe("the root-of-trust ceremony", () => {
  it("enrols principal + key, writes key/fingerprint/profile files, and emits the ceremony event", () => {
    const result = bootstrap();

    expect(result.mode).toBe("development_bootstrap");
    expect(result.already_bootstrapped).toBe(false);

    // File custody: 0600 key file, 0700 directory, fingerprint beside the key.
    expect(statSync(result.key_path).mode & 0o777).toBe(0o600);
    expect(statSync(keysDir).mode & 0o777).toBe(0o700);
    expect(statSync(result.profile_path).mode & 0o777).toBe(0o600);
    expect(result.fingerprint).toBe(fingerprintForPublicKey(result.public_key));

    // Registry rows: dev-bootstrap principal, enrolled key, hash-only credential.
    const principal = new PrincipalStore(database).get(result.principal_id);
    expect(principal?.dev_bootstrap).toBe(true);
    expect(principal?.status).toBe("active");
    const key = new PrincipalKeyStore(database).get(result.key_id);
    expect(key?.public_key).toBe(result.public_key);
    expect(key?.status).toBe("active");

    // The ceremony event records mode, principal, key, and public key — never the private key.
    const events = bootstrappedEvents();
    expect(events).toHaveLength(1);
    const data = events[0]?.payload.data as Record<string, unknown>;
    expect(data.mode).toBe("development_bootstrap");
    expect(data.principal_id).toBe(result.principal_id);
    expect(data.key_id).toBe(result.key_id);
    expect(data.public_key).toBe(result.public_key);
    expect(() => assertNoSensitiveMaterial(events[0]?.payload, "event")).not.toThrow();
    const privateMaterial = readSigningKeyFile(keysDir, "operator");
    expect(JSON.stringify(events[0])).not.toContain(privateMaterial);
  });

  it("stores the EVALUATED predicates — registry_empty, private_key_mode_0600, database ownership", () => {
    const result = bootstrap();
    const byName = new Map(result.predicates.map((predicate) => [predicate.predicate, predicate]));
    expect(byName.get("registry_empty")).toEqual({
      predicate: "registry_empty",
      result: true,
      observed: "count=0",
    });
    expect(byName.get("private_key_mode_0600")).toEqual({
      predicate: "private_key_mode_0600",
      result: true,
      observed: "mode=0600",
    });
    expect(byName.get("database_file_owned_by_current_user")?.result).toBe(true);

    // The same evaluated results — not the intent — are on the durable event.
    const data = bootstrappedEvents()[0]?.payload.data as { predicates: unknown };
    expect(data.predicates).toEqual(result.predicates);
  });

  it("refuses on a non-empty registry", () => {
    new PrincipalStore(database).create({
      id: `principal_${"d".repeat(32)}`,
      workspace_id: WORKSPACE,
      kind: "human",
      display_name: "Pre-existing",
      created_at: NOW,
    });
    // The registry check runs inside the enrolment transaction — before any
    // registry mutation — so the refusal names registry_empty, and the
    // ceremony cleans up the key/fingerprint artefacts it created.
    expect(() =>
      bootstrapRootOperator({ database, workspaceId: WORKSPACE, keysDir, now: NOW }),
    ).toThrow(BootstrapRefusedError);
    expect(() =>
      bootstrapRootOperator({ database, workspaceId: WORKSPACE, keysDir, now: NOW }),
    ).toThrow(/registry_empty/);
  });

  it("refuses outright under NODE_ENV=production", () => {
    expect(() =>
      bootstrapRootOperator({
        database,
        workspaceId: WORKSPACE,
        keysDir,
        env: { NODE_ENV: "production" },
        now: NOW,
      }),
    ).toThrow(/refuses to operate in production/);
    expect(existsSync(keysDir)).toBe(false);
    expect(new PrincipalStore(database).listForWorkspace(WORKSPACE)).toHaveLength(0);
  });

  it("refuses outright when a non-loopback binding is enabled", () => {
    expect(() =>
      bootstrapRootOperator({
        database,
        workspaceId: WORKSPACE,
        keysDir,
        env: { OPENMAO_HOST: "0.0.0.0" },
        now: NOW,
      }),
    ).toThrow(/refuses to operate in production/);
  });

  it("never persists the plaintext token or the private key in the database", () => {
    const result = bootstrap();
    const credentialRows = database.connection
      .prepare("SELECT * FROM principal_credentials")
      .all() as Array<Record<string, unknown>>;
    expect(credentialRows).toHaveLength(1);
    for (const row of credentialRows) {
      expect(Object.values(row).join("|")).not.toContain(result.token);
    }
    const privateMaterial = readSigningKeyFile(keysDir, "operator");
    const eventRows = database.connection
      .prepare("SELECT payload_json FROM events")
      .all() as Array<{
      payload_json: string;
    }>;
    for (const row of eventRows) {
      expect(row.payload_json).not.toContain(result.token);
      expect(row.payload_json).not.toContain(privateMaterial);
    }
  });
});

describe("bootstrap idempotency", () => {
  it("a second run creates no second identity, overwrites no key, and emits no second event", () => {
    const first = ensureRootOperator({ database, workspaceId: WORKSPACE, keysDir, now: NOW });
    const keyBytesBefore = readFileSync(keyFilePath(keysDir, "operator"), "utf8");

    const second = ensureRootOperator({ database, workspaceId: WORKSPACE, keysDir, now: NOW });

    expect(second.already_bootstrapped).toBe(true);
    expect(second.principal_id).toBe(first.principal_id);
    expect(second.key_id).toBe(first.key_id);
    expect(second.token).toBe(first.token);
    expect(readFileSync(keyFilePath(keysDir, "operator"), "utf8")).toBe(keyBytesBefore);
    expect(new PrincipalStore(database).listForWorkspace(WORKSPACE)).toHaveLength(1);
    expect(bootstrappedEvents()).toHaveLength(1);
  });

  it("refuses when the registry does not match the on-disk fingerprint (root substitution is visible)", () => {
    ensureRootOperator({ database, workspaceId: WORKSPACE, keysDir, now: NOW });
    // Tamper: replace the outside-the-database fingerprint with a different key's.
    const other = generateEd25519KeyMaterial();
    writeFileSync(
      join(keysDir, "operator.fingerprint"),
      `${JSON.stringify({
        algorithm: "ed25519",
        public_key: other.publicKeyBase64Url,
        fingerprint: fingerprintForPublicKey(other.publicKeyBase64Url),
      })}\n`,
    );
    expect(() =>
      ensureRootOperator({ database, workspaceId: WORKSPACE, keysDir, now: NOW }),
    ).toThrow(/does not match usable on-disk bootstrap state/);
  });
});

describe("token custody across invocations", () => {
  it("a second, separate invocation authenticates from the profile file", () => {
    const first = bootstrap();
    const principalId = first.principal_id;
    database.close();

    // A genuinely separate invocation: fresh Database object on the same file.
    database = new Database(dbPath);
    database.initialize();

    // The profile holds the only plaintext copy; the DB holds only the hash.
    const resolved = new PrincipalAuthService(database).resolve(
      (
        JSON.parse(readFileSync(join(keysDir, "operator.profile.json"), "utf8")) as {
          token: string;
        }
      ).token,
    );
    expect(resolved).toEqual({ principal_id: principalId, workspace_id: WORKSPACE });

    const principal = authenticateFromProfile(database, keysDir);
    expect(principal?.principal_id).toBe(principalId);
    expect(principal?.kind).toBe("human");
    expect(principal?.key_id).toBe(first.key_id);
    expect(principal?.can_sign).toBe(true);
    expect(principal?.dev_bootstrap).toBe(true);
  });

  it("authenticateFromProfile returns null when no profile exists", () => {
    expect(authenticateFromProfile(database, keysDir)).toBeNull();
  });
});

describe("the honesty valve", () => {
  it("a dev-bootstrap key's signature VERIFIES but reports development_bootstrap trust", () => {
    const result = bootstrap();
    const privateKey = createPrivateKey({
      key: Buffer.from(readSigningKeyFile(keysDir, "operator") ?? "", "base64url"),
      format: "der",
      type: "pkcs8",
    });
    const body = {
      workspace_id: WORKSPACE,
      object_id: "appr_honesty_valve",
      signer: result.principal_id,
      decision: "approved",
      decided_at: NOW,
    };
    const envelope = signObject({
      objectClass: "governance_decision",
      keyId: result.key_id,
      body,
      privateKey,
    });
    // The verifier takes a database, not keys: the trust label is derived
    // from the stored principal row, with no caller input of any kind.
    const verdict = verifyObject({
      database,
      workspaceId: WORKSPACE,
      expectedClass: "governance_decision",
      expectedObjectId: "appr_honesty_valve",
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
});

describe("the CLI surface", () => {
  it("principals init runs the ceremony with no prompt and no new argument, and never prints the private key", async () => {
    const out = capture();
    const code = await runCli(["principals", "init", "--workspace", WORKSPACE], {
      dbPath,
      write: out.write,
    });
    expect(code).toBe(0);
    const printed = out.lines.join("\n");
    const parsed = JSON.parse(printed) as Record<string, unknown>;
    expect(parsed.mode).toBe("development_bootstrap");
    expect(parsed.already_bootstrapped).toBe(false);
    // The plaintext token never prints: it lives only in the 0600 profile.
    expect(parsed.token).toBeUndefined();
    expect(printed).not.toMatch(/prt_[0-9a-f]{64}/);
    // The private key material is nowhere in what the operator saw.
    const privateMaterial = readSigningKeyFile(keysDir, "operator");
    expect(printed).not.toContain(privateMaterial);
    expect(() => assertNoSensitiveMaterial(printed, "stdout")).not.toThrow();
  });

  it("principals init is idempotent at the command level", async () => {
    const first = capture();
    await runCli(["principals", "init", "--workspace", WORKSPACE], { dbPath, write: first.write });
    const second = capture();
    const code = await runCli(["principals", "init", "--workspace", WORKSPACE], {
      dbPath,
      write: second.write,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(second.lines.join("\n")) as Record<string, unknown>;
    expect(parsed.already_bootstrapped).toBe(true);
    expect(parsed.token).toBeUndefined();
    const principals = new PrincipalStore(database).listForWorkspace(WORKSPACE);
    expect(principals).toHaveLength(1);
    expect(bootstrappedEvents()).toHaveLength(1);
  });

  it("principals mint-token rotates the profile token and the NEXT invocation authenticates with it", async () => {
    await runCli(["principals", "init", "--workspace", WORKSPACE], {
      dbPath,
      write: capture().write,
    });
    const out = capture();
    const code = await runCli(["principals", "mint-token", "--workspace", WORKSPACE], {
      dbPath,
      write: out.write,
    });
    expect(code).toBe(0);
    const minted = JSON.parse(out.lines.join("\n")) as { principal_id: string; token?: string };
    expect(minted.token).toBeUndefined();
    expect(out.lines.join("\n")).not.toMatch(/prt_[0-9a-f]{64}/);
    expect(statSync(join(keysDir, "operator.profile.json")).mode & 0o777).toBe(0o600);

    // Next invocation: the rotated token in the profile resolves.
    const principal = authenticateFromProfile(database, keysDir);
    expect(principal?.principal_id).toBe(minted.principal_id);
  });

  it("principals attest signs through custody and records evaluated predicates", async () => {
    await runCli(["principals", "init", "--workspace", WORKSPACE], {
      dbPath,
      write: capture().write,
    });

    // Enrol a second key (an agent) for the operator to attest.
    const agentMaterial = generateEd25519KeyMaterial();
    const agentPrincipalId = `principal_${"e".repeat(32)}`;
    const agentKeyId = `prinkey_${"f".repeat(32)}`;
    new PrincipalStore(database).create({
      id: agentPrincipalId,
      workspace_id: WORKSPACE,
      kind: "agent",
      display_name: "Demo Agent",
      created_at: NOW,
    });
    new PrincipalKeyStore(database).create({
      id: agentKeyId,
      workspace_id: WORKSPACE,
      principal_id: agentPrincipalId,
      public_key: agentMaterial.publicKeyBase64Url,
      valid_from: NOW,
      created_at: NOW,
    });

    const out = capture();
    const code = await runCli(
      ["principals", "attest", "--subject-key", agentKeyId, "--workspace", WORKSPACE],
      { dbPath, write: out.write },
    );
    expect(code).toBe(0);
    const attestations = new PrincipalKeyAttestationStore(database).listForSubjectKey(
      WORKSPACE,
      agentKeyId,
    );
    expect(attestations).toHaveLength(1);
    const predicates = JSON.parse(attestations[0]?.conditions_json ?? "[]") as Array<{
      predicate: string;
      result: boolean;
    }>;
    expect(predicates.map((predicate) => predicate.predicate).sort()).toEqual([
      "attestor_is_active_operator",
      "fingerprint_is_unique",
      "public_key_is_ed25519",
      "subject_exists",
      "workspace_exists",
    ]);
    expect(predicates.every((predicate) => predicate.result)).toBe(true);
  });

  it("principals attest refuses when a predicate fails", async () => {
    await runCli(["principals", "init", "--workspace", WORKSPACE], {
      dbPath,
      write: capture().write,
    });
    await expect(
      runCli(
        ["principals", "attest", "--subject-key", "prinkey_nonexistent", "--workspace", WORKSPACE],
        {
          dbPath,
          write: capture().write,
        },
      ),
    ).rejects.toThrow(/attestation refused/);
  });

  it("principals revoke-key records a signed revocation and stands the key down atomically", async () => {
    await runCli(["principals", "init", "--workspace", WORKSPACE], {
      dbPath,
      write: capture().write,
    });
    const agentMaterial = generateEd25519KeyMaterial();
    const agentKeyId = `prinkey_${"1".repeat(32)}`;
    new PrincipalStore(database).create({
      id: `principal_${"2".repeat(32)}`,
      workspace_id: WORKSPACE,
      kind: "agent",
      display_name: "Doomed Agent",
      created_at: NOW,
    });
    new PrincipalKeyStore(database).create({
      id: agentKeyId,
      workspace_id: WORKSPACE,
      principal_id: `principal_${"2".repeat(32)}`,
      public_key: agentMaterial.publicKeyBase64Url,
      valid_from: NOW,
      created_at: NOW,
    });

    const code = await runCli(["principals", "revoke-key", agentKeyId, "--workspace", WORKSPACE], {
      dbPath,
      write: capture().write,
    });
    expect(code).toBe(0);
    expect(new PrincipalKeyStore(database).get(agentKeyId)?.status).toBe("revoked");
    const revocation = new PrincipalKeyRevocationStore(database).getForKey(agentKeyId);
    expect(revocation?.reason_code).toBe("operator_initiated");
    expect(revocation?.signature.length).toBeGreaterThan(0);
  });

  it("verify-chain never provisions or mutates the database", async () => {
    await runCli(["principals", "init", "--workspace", WORKSPACE], {
      dbPath,
      write: capture().write,
    });
    // Simulate a legacy, unmigrated database. A verify-chain that provisioned
    // (routed through openLocalDatabase → initialize) would run migrations
    // and stamp the current schema version; a row-count check would wave
    // that through, so this test watches the version stamp AND the full
    // contents of every table.
    database.connection.pragma("user_version = 7");
    const dumpAll = () => {
      const tables = database.connection
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as Array<{ name: string }>;
      return tables.map(
        (table) =>
          [
            table.name,
            database.connection.prepare(`SELECT * FROM ${table.name} ORDER BY rowid`).all(),
          ] as const,
      );
    };
    const before = dumpAll();
    const out = capture();
    const code = await runCli(["verify-chain", "--workspace", WORKSPACE], {
      dbPath,
      write: out.write,
    });
    expect(code).toBe(0);
    expect(dumpAll()).toEqual(before);
    expect(Number(database.connection.pragma("user_version", { simple: true }))).toBe(7);
  });

  it("verify-chain on a fresh database creates no keys directory and no identity rows", async () => {
    const out = capture();
    await runCli(["verify-chain", "--workspace", WORKSPACE], { dbPath, write: out.write });
    expect(existsSync(keysDir)).toBe(false);
    expect(new PrincipalStore(database).listForWorkspace(WORKSPACE)).toHaveLength(0);
  });

  it("the 13 routed CLI call sites still record the legacy cli_operator actor", async () => {
    await runCli(["init"], { dbPath, write: capture().write });
    const code = await runCli(["org", "pause"], { dbPath, write: capture().write });
    expect(code).toBe(0);
    const workspaceId = "ws_11111111111111111111111111111111";
    const events = new EventStore(database).listForWorkspace(workspaceId);
    const pauseEvent = events.find((event) => event.kind.startsWith("org_control"));
    expect(pauseEvent?.actor).toBe("cli_operator");
    expect(resolveCliPrincipal(database, workspaceId)).toEqual({
      principal_id: "cli_operator",
      workspace_id: workspaceId,
      kind: "human",
      actor: "cli_operator",
      key_id: null,
      can_sign: false,
      dev_bootstrap: false,
    });
  });
});

/**
 * Rebuilds an envelope from a stored signature plus a body re-derived from
 * stored row fields — the timestamp round-trip proof: if persistence ever
 * normalises a timestamp away from what was signed, this stops verifying.
 */
function envelopeFromStored(
  objectClass: SignedObjectClass,
  keyId: string,
  body: Record<string, unknown>,
  signatureSegment: string,
): { protectedHeaderSegment: string; payloadSegment: string; signatureSegment: string } {
  return {
    protectedHeaderSegment: encodeSegment(
      Buffer.from(dumpJson(buildProtectedHeader(objectClass, keyId)), "utf8"),
    ),
    payloadSegment: encodeSegment(payloadBytesForBody(body)),
    signatureSegment,
  };
}

describe("stored attestation and revocation signatures verify from the stored row", () => {
  it("rebuilding the signed bodies from stored rows re-verifies both signatures", async () => {
    const out = capture();
    await runCli(["principals", "init", "--workspace", WORKSPACE], { dbPath, write: out.write });

    const agentMaterial = generateEd25519KeyMaterial();
    const agentPrincipalId = `principal_${"7".repeat(32)}`;
    const agentKeyId = `prinkey_${"8".repeat(32)}`;
    new PrincipalStore(database).create({
      id: agentPrincipalId,
      workspace_id: WORKSPACE,
      kind: "agent",
      display_name: "Round-trip Agent",
      created_at: NOW,
    });
    new PrincipalKeyStore(database).create({
      id: agentKeyId,
      workspace_id: WORKSPACE,
      principal_id: agentPrincipalId,
      public_key: agentMaterial.publicKeyBase64Url,
      valid_from: NOW,
      created_at: NOW,
    });

    expect(
      await runCli(
        ["principals", "attest", "--subject-key", agentKeyId, "--workspace", WORKSPACE],
        { dbPath, write: capture().write },
      ),
    ).toBe(0);
    expect(
      await runCli(["principals", "revoke-key", agentKeyId, "--workspace", WORKSPACE], {
        dbPath,
        write: capture().write,
      }),
    ).toBe(0);

    // Every body field comes from a stored row — including the signer, which
    // is derived from the stored attester/revoker KEY row's principal, never
    // from the profile. The verifier likewise takes the database, so the
    // whole round-trip is registry-truth in, registry-truth out.
    const keys = new PrincipalKeyStore(database);

    const attestation = new PrincipalKeyAttestationStore(database).listForSubjectKey(
      WORKSPACE,
      agentKeyId,
    )[0];
    expect(attestation).toBeDefined();
    const attesterKeyRow = keys.get(attestation?.attester_key_id ?? "");
    expect(attesterKeyRow).not.toBeNull();
    const attestedBody = {
      workspace_id: attestation?.workspace_id,
      object_id: attestation?.subject_key_id,
      signer: attesterKeyRow?.principal_id,
      attester_key_id: attestation?.attester_key_id,
      attested_at: attestation?.attested_at,
      predicates: JSON.parse(attestation?.conditions_json ?? "[]"),
    };
    const attestedVerdict = verifyObject({
      database,
      workspaceId: WORKSPACE,
      expectedClass: "principal_enrolment",
      expectedObjectId: agentKeyId,
      envelope: envelopeFromStored(
        "principal_enrolment",
        attestation?.attester_key_id ?? "",
        attestedBody as Record<string, unknown>,
        attestation?.signature ?? "",
      ),
      now: NOW,
    });
    expect(attestedVerdict.ok).toBe(true);

    const revocation = new PrincipalKeyRevocationStore(database).getForKey(agentKeyId);
    expect(revocation).toBeDefined();
    const revokerKeyRow = keys.get(revocation?.revoked_by_key_id ?? "");
    expect(revokerKeyRow).not.toBeNull();
    const revokedBody = {
      workspace_id: revocation?.workspace_id,
      object_id: revocation?.key_id,
      signer: revokerKeyRow?.principal_id,
      reason_code: revocation?.reason_code,
      revoked_at: revocation?.revoked_at,
    };
    const revokedVerdict = verifyObject({
      database,
      workspaceId: WORKSPACE,
      expectedClass: "revocation",
      expectedObjectId: agentKeyId,
      envelope: envelopeFromStored(
        "revocation",
        revocation?.revoked_by_key_id ?? "",
        revokedBody as Record<string, unknown>,
        revocation?.signature ?? "",
      ),
      now: NOW,
    });
    expect(revokedVerdict.ok).toBe(true);
  });
});
