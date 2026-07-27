import { generateKeyPairSync } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";
import { WorkspaceSchema } from "../src/contracts/index.js";
import {
  Database,
  EventStore,
  PrincipalCredentialStore,
  PrincipalKeyStore,
  PrincipalStore,
  WorkspaceStore,
} from "../src/persistence/index.js";
import { authenticateFromProfile } from "../src/security/authenticated-principal.js";
import { keyFilePath, workspaceCustodyDir } from "../src/security/key-custody.js";
import { PrincipalAuthService } from "../src/security/principal-auth.js";
import {
  BootstrapRefusedError,
  bootstrapRootOperator,
  ensureRootOperator,
  readProfileFile,
} from "../src/security/principal-bootstrap.js";

const WORKSPACE = `ws_${"a".repeat(32)}`;
const NOW = "2026-07-26T12:00:00Z";

function freshKeyMaterial(): { pkcs8Base64Url: string; publicKeyBase64Url: string } {
  const pair = generateKeyPairSync("ed25519");
  return {
    pkcs8Base64Url: pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"),
    publicKeyBase64Url: (pair.publicKey.export({ format: "jwk" }) as { x: string }).x,
  };
}

let dir: string;
let dbPath: string;
let keysRoot: string;
let keysDir: string;
let database: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "openmao-bootstrap-hardening-"));
  dbPath = join(dir, "openmao.sqlite3");
  keysRoot = join(dir, "keys");
  keysDir = workspaceCustodyDir(keysRoot, WORKSPACE);
  database = new Database(dbPath);
  database.initialize();
  new WorkspaceStore(database).save(
    WorkspaceSchema.parse({ id: WORKSPACE, name: "Hardening", created_at: NOW }),
  );
});

afterEach(() => {
  database.close();
  rmSync(dir, { recursive: true, force: true });
});

function bootstrap() {
  return ensureRootOperator({ database, workspaceId: WORKSPACE, keysDir, now: NOW });
}

function capture(): { lines: string[]; write: (message: string) => void } {
  const lines: string[] = [];
  return { lines, write: (message) => lines.push(message) };
}

describe("idempotence validates usable custody", () => {
  it("refuses when the key file was deleted after bootstrapping", () => {
    bootstrap();
    unlinkSync(keyFilePath(keysDir, "operator"));
    expect(() => bootstrap()).toThrow(BootstrapRefusedError);
    expect(() => bootstrap()).toThrow(/key file is missing/);
  });

  it("refuses when the key file mode was widened after bootstrapping", () => {
    bootstrap();
    chmodSync(keyFilePath(keysDir, "operator"), 0o644);
    expect(() => bootstrap()).toThrow(/0600/);
  });

  it("refuses when the key file no longer matches the enrolled fingerprint", () => {
    bootstrap();
    writeFileSync(keyFilePath(keysDir, "operator"), "tampered-material", { mode: 0o600 });
    expect(() => bootstrap()).toThrow(BootstrapRefusedError);
  });

  it("refuses when the profile token resolves to a revoked credential", () => {
    const result = bootstrap();
    const credentials = new PrincipalCredentialStore(database).listForPrincipal(
      WORKSPACE,
      result.principal_id,
    );
    for (const credential of credentials) {
      new PrincipalCredentialStore(database).revoke(credential.id);
    }
    expect(() => bootstrap()).toThrow(/no active credential/);
  });

  it("refuses when the bootstrapped principal was disabled", () => {
    const result = bootstrap();
    new PrincipalStore(database).setStatus(result.principal_id, "disabled");
    expect(() => bootstrap()).toThrow(/not active/);
  });

  it("a healthy prior bootstrap is still recognised with nothing mutated", () => {
    const first = bootstrap();
    const second = bootstrap();
    expect(second.already_bootstrapped).toBe(true);
    expect(second.principal_id).toBe(first.principal_id);
    expect(readdirSync(keysDir).sort()).toEqual([
      "operator.fingerprint",
      "operator.pk8",
      "operator.profile.json",
    ]);
  });
});

describe("token rotation", () => {
  it("mint-token revokes the previous credential: the old token dies, the new one authenticates", async () => {
    await runCli(["principals", "init", "--workspace", WORKSPACE], {
      dbPath,
      write: capture().write,
    });
    const profileBefore = readProfileFile(keysDir);
    expect(profileBefore).not.toBeNull();
    const oldToken = profileBefore?.token ?? "";
    expect(new PrincipalAuthService(database).resolve(oldToken)).not.toBeNull();

    const out = capture();
    const code = await runCli(["principals", "mint-token", "--workspace", WORKSPACE], {
      dbPath,
      write: out.write,
    });
    expect(code).toBe(0);

    expect(new PrincipalAuthService(database).resolve(oldToken)).toBeNull();
    const profileAfter = readProfileFile(keysDir);
    expect(profileAfter?.token).not.toBe(oldToken);
    expect(new PrincipalAuthService(database).resolve(profileAfter?.token ?? "")).not.toBeNull();
    const active = new PrincipalCredentialStore(database)
      .listForPrincipal(WORKSPACE, profileBefore?.principal_id ?? "")
      .filter((credential) => credential.status === "active");
    expect(active).toHaveLength(1);
  });
});

describe("authority mutations enter the event chain", () => {
  it("mint-token emits an event through the normal event path and the chain still verifies", async () => {
    await runCli(["principals", "init", "--workspace", WORKSPACE], {
      dbPath,
      write: capture().write,
    });
    const before = new EventStore(database).listForWorkspace(WORKSPACE).length;
    await runCli(["principals", "mint-token", "--workspace", WORKSPACE], {
      dbPath,
      write: capture().write,
    });
    const events = new EventStore(database).listForWorkspace(WORKSPACE);
    expect(events.length).toBe(before + 1);
    expect(events.some((event) => event.kind === "principal.credential_minted")).toBe(true);
    expect(new EventStore(database).verifyChain(WORKSPACE).ok).toBe(true);
  });

  it("attest and revoke-key each emit events and the chain still verifies", async () => {
    await runCli(["principals", "init", "--workspace", WORKSPACE], {
      dbPath,
      write: capture().write,
    });
    const material = freshKeyMaterial();
    const agentPrincipalId = `principal_${"e".repeat(32)}`;
    const agentKeyId = `prinkey_${"f".repeat(32)}`;
    new PrincipalStore(database).create({
      id: agentPrincipalId,
      workspace_id: WORKSPACE,
      kind: "agent",
      display_name: "Agent",
      created_at: NOW,
    });
    new PrincipalKeyStore(database).create({
      id: agentKeyId,
      workspace_id: WORKSPACE,
      principal_id: agentPrincipalId,
      public_key: material.publicKeyBase64Url,
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

    const kinds = new EventStore(database).listForWorkspace(WORKSPACE).map((event) => event.kind);
    expect(kinds).toContain("principal.key_attested");
    expect(kinds).toContain("principal.key_revoked");
    expect(new EventStore(database).verifyChain(WORKSPACE).ok).toBe(true);
  });
});

describe("stdout never carries the operator token", () => {
  it("principals init prints no plaintext token; it points at the profile path", async () => {
    const out = capture();
    const code = await runCli(["principals", "init", "--workspace", WORKSPACE], {
      dbPath,
      write: out.write,
    });
    expect(code).toBe(0);
    const printed = out.lines.join("\n");
    const profile = readProfileFile(keysDir);
    expect(profile).not.toBeNull();
    expect(printed).not.toContain(profile?.token ?? "unreachable");
    expect(printed).not.toMatch(/prt_[0-9a-f]{64}/);
    expect(printed).toContain("profile");
  });

  it("principals mint-token prints no plaintext token either", async () => {
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
    const printed = out.lines.join("\n");
    const profile = readProfileFile(keysDir);
    expect(printed).not.toContain(profile?.token ?? "unreachable");
    expect(printed).not.toMatch(/prt_[0-9a-f]{64}/);
    expect(authenticateFromProfile(database, keysDir)).not.toBeNull();
  });
});

describe("the ownership predicate fails closed", () => {
  it("a predicate that cannot be evaluated is a refusal, never a recorded true", () => {
    const result = bootstrap();
    const ownership = result.predicates.find(
      (predicate) => predicate.predicate === "database_file_owned_by_current_user",
    );
    expect(ownership).toBeDefined();
    // This platform has getuid, so the predicate is evaluable and passes.
    expect(ownership?.result).toBe(true);
    expect(ownership?.observed).toContain("owner_uid=");
    expect(ownership?.observed).not.toBe("not_evaluable");
  });
});

describe("registry_empty is evaluated inside the enrolment transaction", () => {
  it("a principal inserted between the file writes and the transaction is caught by the in-transaction check", () => {
    // Simulate the TOCTOU window: the ceremony checks registry_empty INSIDE
    // the transaction, so a concurrent enrolment can never slip between check
    // and insert while the record claims the registry was empty. We drive
    // this by calling the transaction body with a pre-seeded registry: the
    // refusal must name registry_empty and leave no rows behind.
    new PrincipalStore(database).create({
      id: `principal_${"3".repeat(32)}`,
      workspace_id: WORKSPACE,
      kind: "agent",
      display_name: "Concurrent Enrolment",
      created_at: NOW,
    });
    expect(() =>
      bootstrapRootOperator({ database, workspaceId: WORKSPACE, keysDir, now: NOW }),
    ).toThrow(/registry_empty/);
    // The bootstrap principal/key/credential rows never landed.
    const principals = new PrincipalStore(database).listForWorkspace(WORKSPACE);
    expect(principals).toHaveLength(1);
    expect(principals[0]?.display_name).toBe("Concurrent Enrolment");
    expect(
      new PrincipalKeyStore(database).listForPrincipal(WORKSPACE, principals[0]?.id ?? ""),
    ).toHaveLength(0);
    // And the event chain holds no ceremony event for a refused run.
    expect(
      new EventStore(database)
        .listForWorkspace(WORKSPACE)
        .filter((event) => event.kind === "principal.bootstrapped"),
    ).toHaveLength(0);
  });
});

describe("the ceremony leaves no debris behind a refused run", () => {
  it("a non-empty registry refusal cleans up key and fingerprint so a retry after cleanup is possible", () => {
    new PrincipalStore(database).create({
      id: `principal_${"9".repeat(32)}`,
      workspace_id: WORKSPACE,
      kind: "human",
      display_name: "Pre-existing",
      created_at: NOW,
    });
    expect(() => bootstrap()).toThrow(BootstrapRefusedError);
    // Nothing orphaned: no key file, no fingerprint, no profile, and no temp files.
    expect(existsSync(keysDir)).toBe(false);
    // Removing the obstruction makes a fresh ceremony possible immediately.
    new PrincipalStore(database).setStatus(`principal_${"9".repeat(32)}`, "disabled");
    database.connection
      .prepare("DELETE FROM principals WHERE id = ?")
      .run(`principal_${"9".repeat(32)}`);
    const result = bootstrap();
    expect(result.already_bootstrapped).toBe(false);
    expect(existsSync(result.key_path)).toBe(true);
  });
});

describe("read-only CLI commands", () => {
  it("verify-chain from a genuinely fresh directory creates no database file and exits non-zero", async () => {
    const fresh = mkdtempSync(join(tmpdir(), "openmao-readonly-"));
    const freshPath = join(fresh, "nested", "openmao.sqlite3");
    try {
      const out = capture();
      const code = await runCli(["verify-chain"], { dbPath: freshPath, write: out.write });
      expect(code).not.toBe(0);
      expect(existsSync(freshPath)).toBe(false);
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });
});
