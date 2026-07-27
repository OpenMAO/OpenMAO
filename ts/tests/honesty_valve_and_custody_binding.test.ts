import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceSchema } from "../src/contracts/index.js";
import { Database, PrincipalStore, WorkspaceStore } from "../src/persistence/index.js";
import { dumpJson } from "../src/persistence/serialization.js";
import {
  CustodyError,
  keyFilePath,
  resolveCustody,
  workspaceCustodyDir,
} from "../src/security/key-custody.js";
import { bootstrapRootOperator } from "../src/security/principal-bootstrap.js";
import {
  buildProtectedHeader,
  encodeSegment,
  mintVerificationKeyForTest,
  payloadBytesForBody,
  signObject,
  verifyObject,
} from "../src/security/signing.js";

const WORKSPACE = `ws_${"a".repeat(32)}`;
const WORKSPACE_B = `ws_${"b".repeat(32)}`;
const NOW = "2026-07-26T12:00:00Z";

function freshKeyMaterial(): { pkcs8Base64Url: string; publicKeyBase64Url: string } {
  const pair = generateKeyPairSync("ed25519");
  return {
    pkcs8Base64Url: pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"),
    publicKeyBase64Url: (pair.publicKey.export({ format: "jwk" }) as { x: string }).x,
  };
}

let dir: string;
let keysRoot: string;
let keysDir: string;
let database: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "openmao-valve-custody-"));
  keysRoot = join(dir, "keys");
  keysDir = workspaceCustodyDir(keysRoot, WORKSPACE);
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

function envelopeFor(input: {
  keyId: string;
  principalId: string;
  objectId: string;
  pkcs8Base64Url: string;
  workspaceId?: string;
}) {
  const workspaceId = input.workspaceId ?? WORKSPACE;
  const body = {
    workspace_id: workspaceId,
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

describe("the honesty valve is not bypassable (P1)", () => {
  it("a hand-built key object is REFUSED by the verifier at runtime — only module-minted keys verify", () => {
    const result = bootstrapRootOperator({ database, workspaceId: WORKSPACE, keysDir, now: NOW });
    // Sign with the REAL enrolled operator key so the envelope is valid; the
    // only thing under attack is the trust label a smuggled key would claim.
    const pkcs8 = readFileSync(keyFilePath(keysDir, "operator"), "utf8").trim();
    const envelope = envelopeFor({
      keyId: result.key_id,
      principalId: result.principal_id,
      objectId: "appr_handbuilt",
      pkcs8Base64Url: pkcs8,
    });
    // The audit's probe: a caller forges a VerificationKey claiming the real
    // enrolled key id but with dev_bootstrap omitted (=> would report standard).
    // Cast into place and fed through the white-box seam, it is REFUSED — it
    // lacks the runtime brand only this module can stamp.
    const handBuilt = {
      keyId: result.key_id,
      publicKeyBase64Url: result.public_key,
      ownerPrincipalId: result.principal_id,
      enrolled: true,
      status: "active" as const,
      validUntil: null,
      conditions: [],
      dev_bootstrap: false,
    };
    const verdict = verifyObject({
      database,
      workspaceId: WORKSPACE,
      expectedClass: "governance_decision",
      expectedObjectId: "appr_handbuilt",
      envelope,
      now: NOW,
      keys: [handBuilt],
    } as unknown as Parameters<typeof verifyObject>[0]);
    // The registry says dev-bootstrap; the smuggled "standard" key is ignored.
    expect(verdict.ok && verdict.trust).toBe("development_bootstrap");
  });

  it("mintVerificationKeyForTest REFUSES under any production signal", () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(() =>
        mintVerificationKeyForTest({
          keyId: "k",
          publicKeyBase64Url: freshKeyMaterial().publicKeyBase64Url,
          ownerPrincipalId: "p",
          enrolled: true,
          status: "active",
          validUntil: null,
          conditions: [],
          dev_bootstrap: false,
        }),
      ).toThrow(/refuses to operate in production/);
    } finally {
      if (original === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = original;
      }
    }
  });

  it("a dev-bootstrap key reports development_bootstrap and cannot be made standard by any caller input", () => {
    const result = bootstrapRootOperator({ database, workspaceId: WORKSPACE, keysDir, now: NOW });
    const pkcs8 = readFileSync(keyFilePath(keysDir, "operator"), "utf8").trim();
    const envelope = envelopeFor({
      keyId: result.key_id,
      principalId: result.principal_id,
      objectId: "appr_valve",
      pkcs8Base64Url: pkcs8,
    });
    const verdict = verifyObject({
      database,
      workspaceId: WORKSPACE,
      expectedClass: "governance_decision",
      expectedObjectId: "appr_valve",
      envelope,
      now: NOW,
      // Caller tries to force standard trust through every smuggle vector at once.
      dev_bootstrap: false,
      trust: "standard",
      keys: [
        {
          keyId: result.key_id,
          publicKeyBase64Url: result.public_key,
          ownerPrincipalId: result.principal_id,
          enrolled: true,
          status: "active",
          validUntil: null,
          conditions: [],
          dev_bootstrap: false,
        },
      ],
    } as unknown as Parameters<typeof verifyObject>[0]);
    expect(verdict.ok && verdict.trust).toBe("development_bootstrap");
  });
});

describe("cross-workspace custody bypass is closed (P1)", () => {
  it("resolveCustody derives the directory from root+workspaceId; a foreign keysDir argument is ignored", () => {
    // The attack the audit named: workspace A's directory passed with
    // workspace B. resolveCustody's contract takes keysRoot + workspaceId and
    // derives the directory itself — a pre-computed directory is not part of
    // the input. Pass A's directory under a smuggled `keysDir` key via a cast:
    // it is ignored, B resolves against <root>/<B_id>, and with B's registry
    // empty and no B key the result is dev_bootstrap, never A's identity.
    bootstrapRootOperator({
      database,
      workspaceId: WORKSPACE,
      keysDir: workspaceCustodyDir(keysRoot, WORKSPACE),
      now: NOW,
    });
    const aDir = workspaceCustodyDir(keysRoot, WORKSPACE);
    const resolution = resolveCustody({
      env: {},
      keysRoot,
      database,
      workspaceId: WORKSPACE_B,
      keysDir: aDir, // smuggled foreign directory — not part of the contract
    } as unknown as Parameters<typeof resolveCustody>[0]);
    expect(resolution.tier).toBe("dev_bootstrap");
    expect(resolution.broker).toBeNull();
    expect(resolution.publicKeyBase64Url).toBeNull();
  });

  it("a key enrolled in workspace A found in B's custody directory is REFUSED even with B's registry empty", () => {
    const a = bootstrapRootOperator({
      database,
      workspaceId: WORKSPACE,
      keysDir: workspaceCustodyDir(keysRoot, WORKSPACE),
      now: NOW,
    });
    const bDir = workspaceCustodyDir(keysRoot, WORKSPACE_B);
    mkdirSync(bDir, { recursive: true });
    chmodSync(bDir, 0o700);
    writeFileSync(keyFilePath(bDir, "operator"), readFileSync(a.key_path, "utf8"), {
      mode: 0o600,
    });
    // B's registry is EMPTY (only A was bootstrapped). The empty-registry
    // early-return must not wave a foreign enrolled key through.
    expect(new PrincipalStore(database).listForWorkspace(WORKSPACE_B)).toHaveLength(0);
    expect(() => resolveCustody({ env: {}, keysRoot, database, workspaceId: WORKSPACE_B })).toThrow(
      CustodyError,
    );
  });

  it("the mismatched-argument attack directly: a root that is actually A's workspace dir does not let B adopt A's key", () => {
    // An attacker who controls the keysRoot argument points B's resolution at
    // A's workspace directory as the ROOT. workspaceCustodyDir then derives
    // <A_dir>/<B_id> — a path that does not hold A's operator key — so B gets
    // dev_bootstrap, never A's identity. The (dir-of-A, id-of-B) pair cannot
    // be expressed.
    bootstrapRootOperator({
      database,
      workspaceId: WORKSPACE,
      keysDir: workspaceCustodyDir(keysRoot, WORKSPACE),
      now: NOW,
    });
    const aWorkspaceDir = workspaceCustodyDir(keysRoot, WORKSPACE);
    const resolution = resolveCustody({
      env: {},
      keysRoot: aWorkspaceDir, // A's workspace dir reused as a root
      database,
      workspaceId: WORKSPACE_B,
    });
    expect(resolution.tier).toBe("dev_bootstrap");
    expect(resolution.broker).toBeNull();
    expect(resolution.publicKeyBase64Url).toBeNull();
  });
});
