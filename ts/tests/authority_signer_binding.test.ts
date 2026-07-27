import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
import {
  AuthorityMutationError,
  attestPrincipalKey,
  PRINCIPAL_KEY_ATTESTED_EVENT,
  PRINCIPAL_KEY_REVOKED_EVENT,
  revokePrincipalKey,
} from "../src/security/principal-authority.js";
import { StaticSigningBroker } from "../src/security/signing-broker.js";

/**
 * P0 (SIG-003): an embedding caller must not be able to have the system
 * record an attestation or revocation attributed to an enrolled operator key
 * it does not hold. These tests drive attestPrincipalKey / revokePrincipalKey
 * directly — the boundary the CLI wraps — and attack the recorded-signer
 * binding at every stage the earlier rounds left open: a caller-supplied
 * kind, a disabled principal, a revoked key, and a broker signing with
 * material other than the claimed enrolled key.
 */

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
let database: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "openmao-authority-"));
  database = new Database(join(dir, "openmao.sqlite3"));
  database.initialize();
  new WorkspaceStore(database).save(
    WorkspaceSchema.parse({ id: WORKSPACE, name: "Authority Test", created_at: NOW }),
  );
});

afterEach(() => {
  database.close();
  rmSync(dir, { recursive: true, force: true });
});

function enrolPrincipal(input: { kind: "human" | "agent"; devBootstrap?: boolean }): {
  principalId: string;
  keyId: string;
  pkcs8Base64Url: string;
  publicKeyBase64Url: string;
} {
  const material = freshKeyMaterial();
  // Canonical ids (prefix + 32 hex): the happy-path events cite them in refs,
  // which EventPayloadSchema validates against the canonical id pattern.
  const principalId = `principal_${randomBytes(16).toString("hex")}`;
  const keyId = `prinkey_${randomBytes(16).toString("hex")}`;
  new PrincipalStore(database).create({
    id: principalId,
    workspace_id: WORKSPACE,
    kind: input.kind,
    display_name: `Test Principal ${principalId}`,
    dev_bootstrap: input.devBootstrap ?? false,
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
  return { principalId, keyId, ...material };
}

function brokerFor(pkcs8Base64Url: string, handle = "signkey_operator"): StaticSigningBroker {
  return new StaticSigningBroker({ [handle]: pkcs8Base64Url });
}

function attestationRows(): number {
  return new PrincipalKeyAttestationStore(database).listForSubjectKey(WORKSPACE, SUBJECT.keyId)
    .length;
}
function revocationRows(): number {
  return new PrincipalKeyRevocationStore(database).listForWorkspace(WORKSPACE).length;
}
function mutationEvents(): number {
  return new EventStore(database)
    .listForWorkspace(WORKSPACE)
    .filter(
      (event) =>
        event.kind === PRINCIPAL_KEY_ATTESTED_EVENT || event.kind === PRINCIPAL_KEY_REVOKED_EVENT,
    ).length;
}

let OPERATOR: ReturnType<typeof enrolPrincipal>;
let SUBJECT: ReturnType<typeof enrolPrincipal>;

beforeEach(() => {
  OPERATOR = enrolPrincipal({ kind: "human" });
  SUBJECT = enrolPrincipal({ kind: "agent" });
});

describe("authority mutations re-check standing INSIDE the writing transaction", () => {
  // TOCTOU: the verification read completed, then another connection withdrew
  // the authority — disabled the principal, revoked the operator key — before
  // this connection's BEGIN. The in-transaction re-check must fail the write
  // and roll it back: an authority record can never be ordered after the
  // administrative withdrawal of that authority. The wrapper interposes the
  // withdrawal exactly where a second process's commit would land: after the
  // last pre-transaction read, before the writing transaction starts.
  function racingDatabase(withdraw: (other: Database) => void): Database {
    const racing = Object.create(database) as Database;
    racing.transaction = <T>(body: () => T): T => {
      const other = new Database(join(dir, "openmao.sqlite3"));
      try {
        withdraw(other);
      } finally {
        other.close();
      }
      // The REAL instance method — the interposed withdrawal lands first,
      // exactly where a second process's commit would.
      return database.transaction(body);
    };
    return racing;
  }

  it("an attestation writes nothing when the principal is disabled before BEGIN", async () => {
    const racing = racingDatabase((other) =>
      new PrincipalStore(other).setStatus(OPERATOR.principalId, "disabled"),
    );
    await expect(
      attestPrincipalKey({
        database: racing,
        workspaceId: WORKSPACE,
        attester: { principal_id: OPERATOR.principalId, key_id: OPERATOR.keyId },
        subjectKeyId: SUBJECT.keyId,
        broker: brokerFor(OPERATOR.pkcs8Base64Url),
        handle: "signkey_operator",
        now: NOW,
      }),
    ).rejects.toThrow(/attestation refused/);
    expect(attestationRows()).toBe(0);
    expect(mutationEvents()).toBe(0);
  });

  it("an attestation writes nothing when the operator key is revoked before BEGIN", async () => {
    const racing = racingDatabase((other) => new PrincipalKeyStore(other).revoke(OPERATOR.keyId));
    await expect(
      attestPrincipalKey({
        database: racing,
        workspaceId: WORKSPACE,
        attester: { principal_id: OPERATOR.principalId, key_id: OPERATOR.keyId },
        subjectKeyId: SUBJECT.keyId,
        broker: brokerFor(OPERATOR.pkcs8Base64Url),
        handle: "signkey_operator",
        now: NOW,
      }),
    ).rejects.toThrow(/attestation refused/);
    expect(attestationRows()).toBe(0);
    expect(mutationEvents()).toBe(0);
  });

  it("a revocation writes nothing when the principal is disabled before BEGIN", async () => {
    const racing = racingDatabase((other) =>
      new PrincipalStore(other).setStatus(OPERATOR.principalId, "disabled"),
    );
    await expect(
      revokePrincipalKey({
        database: racing,
        workspaceId: WORKSPACE,
        revoker: { principal_id: OPERATOR.principalId, key_id: OPERATOR.keyId },
        keyId: SUBJECT.keyId,
        reasonCode: "operator_initiated",
        broker: brokerFor(OPERATOR.pkcs8Base64Url),
        handle: "signkey_operator",
        now: NOW,
      }),
    ).rejects.toThrow(/revocation refused/);
    expect(revocationRows()).toBe(0);
    expect(new PrincipalKeyStore(database).get(SUBJECT.keyId)?.status).toBe("active");
    expect(mutationEvents()).toBe(0);
  });

  it("a revocation writes nothing when the operator key is revoked before BEGIN", async () => {
    const racing = racingDatabase((other) => new PrincipalKeyStore(other).revoke(OPERATOR.keyId));
    await expect(
      revokePrincipalKey({
        database: racing,
        workspaceId: WORKSPACE,
        revoker: { principal_id: OPERATOR.principalId, key_id: OPERATOR.keyId },
        keyId: SUBJECT.keyId,
        reasonCode: "operator_initiated",
        broker: brokerFor(OPERATOR.pkcs8Base64Url),
        handle: "signkey_operator",
        now: NOW,
      }),
    ).rejects.toThrow(/revocation refused/);
    expect(revocationRows()).toBe(0);
    expect(new PrincipalKeyStore(database).get(SUBJECT.keyId)?.status).toBe("active");
    expect(mutationEvents()).toBe(0);
  });

  it("without the race the same mutations still commit", async () => {
    const attestation = await attestPrincipalKey({
      database,
      workspaceId: WORKSPACE,
      attester: { principal_id: OPERATOR.principalId, key_id: OPERATOR.keyId },
      subjectKeyId: SUBJECT.keyId,
      broker: brokerFor(OPERATOR.pkcs8Base64Url),
      handle: "signkey_operator",
      now: NOW,
    });
    expect(attestation.subject_key_id).toBe(SUBJECT.keyId);
    expect(attestationRows()).toBe(1);
    const revocation = await revokePrincipalKey({
      database,
      workspaceId: WORKSPACE,
      revoker: { principal_id: OPERATOR.principalId, key_id: OPERATOR.keyId },
      keyId: SUBJECT.keyId,
      reasonCode: "operator_initiated",
      broker: brokerFor(OPERATOR.pkcs8Base64Url),
      handle: "signkey_operator",
      now: NOW,
    });
    expect(revocation.key_id).toBe(SUBJECT.keyId);
    expect(revocationRows()).toBe(1);
    expect(mutationEvents()).toBe(2);
  });
});

describe("attestPrincipalKey refuses a signer it cannot substantiate", () => {
  it("a caller claiming an operator key it does not hold is refused and writes nothing", async () => {
    // The attacker holds a DIFFERENT valid Ed25519 keypair and signs with it,
    // but names the enrolled operator principal/key as the attester. The
    // produced signature verifies under the attacker's key, never under the
    // enrolled operator key — so the attestation must not be recorded.
    const attackerMaterial = freshKeyMaterial();
    await expect(
      attestPrincipalKey({
        database,
        workspaceId: WORKSPACE,
        attester: { principal_id: OPERATOR.principalId, key_id: OPERATOR.keyId },
        subjectKeyId: SUBJECT.keyId,
        broker: brokerFor(attackerMaterial.pkcs8Base64Url),
        handle: "signkey_operator",
        now: NOW,
      }),
    ).rejects.toThrow(AuthorityMutationError);
    expect(attestationRows()).toBe(0);
    expect(mutationEvents()).toBe(0);
  });

  it("a caller-supplied kind is never read: a stored AGENT principal cannot attest even claiming to be human", async () => {
    const agent = enrolPrincipal({ kind: "agent" });
    await expect(
      attestPrincipalKey({
        database,
        workspaceId: WORKSPACE,
        attester: { principal_id: agent.principalId, key_id: agent.keyId },
        subjectKeyId: SUBJECT.keyId,
        broker: brokerFor(agent.pkcs8Base64Url),
        handle: "signkey_operator",
        now: NOW,
      }),
    ).rejects.toThrow(/attestation refused/);
    expect(attestationRows()).toBe(0);
    expect(mutationEvents()).toBe(0);
  });

  it("a disabled principal cannot attest — stored standing, not caller input", async () => {
    new PrincipalStore(database).setStatus(OPERATOR.principalId, "disabled");
    await expect(
      attestPrincipalKey({
        database,
        workspaceId: WORKSPACE,
        attester: { principal_id: OPERATOR.principalId, key_id: OPERATOR.keyId },
        subjectKeyId: SUBJECT.keyId,
        broker: brokerFor(OPERATOR.pkcs8Base64Url),
        handle: "signkey_operator",
        now: NOW,
      }),
    ).rejects.toThrow(/attestation refused/);
    expect(attestationRows()).toBe(0);
    expect(mutationEvents()).toBe(0);
  });

  it("a revoked operator key cannot attest", async () => {
    new PrincipalKeyStore(database).revoke(OPERATOR.keyId);
    await expect(
      attestPrincipalKey({
        database,
        workspaceId: WORKSPACE,
        attester: { principal_id: OPERATOR.principalId, key_id: OPERATOR.keyId },
        subjectKeyId: SUBJECT.keyId,
        broker: brokerFor(OPERATOR.pkcs8Base64Url),
        handle: "signkey_operator",
        now: NOW,
      }),
    ).rejects.toThrow(/attestation refused/);
    expect(attestationRows()).toBe(0);
    expect(mutationEvents()).toBe(0);
  });
});

describe("revokePrincipalKey refuses a signer it cannot substantiate", () => {
  it("a caller claiming an operator key it does not hold is refused and writes nothing", async () => {
    const attackerMaterial = freshKeyMaterial();
    await expect(
      revokePrincipalKey({
        database,
        workspaceId: WORKSPACE,
        revoker: { principal_id: OPERATOR.principalId, key_id: OPERATOR.keyId },
        keyId: SUBJECT.keyId,
        reasonCode: "operator_initiated",
        broker: brokerFor(attackerMaterial.pkcs8Base64Url),
        handle: "signkey_operator",
        now: NOW,
      }),
    ).rejects.toThrow(AuthorityMutationError);
    expect(revocationRows()).toBe(0);
    expect(new PrincipalKeyStore(database).get(SUBJECT.keyId)?.status).toBe("active");
    expect(mutationEvents()).toBe(0);
  });

  it("a disabled principal cannot revoke", async () => {
    new PrincipalStore(database).setStatus(OPERATOR.principalId, "disabled");
    await expect(
      revokePrincipalKey({
        database,
        workspaceId: WORKSPACE,
        revoker: { principal_id: OPERATOR.principalId, key_id: OPERATOR.keyId },
        keyId: SUBJECT.keyId,
        reasonCode: "operator_initiated",
        broker: brokerFor(OPERATOR.pkcs8Base64Url),
        handle: "signkey_operator",
        now: NOW,
      }),
    ).rejects.toThrow(/revocation refused/);
    expect(revocationRows()).toBe(0);
    expect(new PrincipalKeyStore(database).get(SUBJECT.keyId)?.status).toBe("active");
    expect(mutationEvents()).toBe(0);
  });

  it("a revoked operator key cannot revoke another key", async () => {
    new PrincipalKeyStore(database).revoke(OPERATOR.keyId);
    await expect(
      revokePrincipalKey({
        database,
        workspaceId: WORKSPACE,
        revoker: { principal_id: OPERATOR.principalId, key_id: OPERATOR.keyId },
        keyId: SUBJECT.keyId,
        reasonCode: "operator_initiated",
        broker: brokerFor(OPERATOR.pkcs8Base64Url),
        handle: "signkey_operator",
        now: NOW,
      }),
    ).rejects.toThrow(/revocation refused/);
    expect(revocationRows()).toBe(0);
    expect(new PrincipalKeyStore(database).get(SUBJECT.keyId)?.status).toBe("active");
    expect(mutationEvents()).toBe(0);
  });

  it("a stored non-human principal cannot revoke even with a valid key", async () => {
    const agent = enrolPrincipal({ kind: "agent" });
    await expect(
      revokePrincipalKey({
        database,
        workspaceId: WORKSPACE,
        revoker: { principal_id: agent.principalId, key_id: agent.keyId },
        keyId: SUBJECT.keyId,
        reasonCode: "operator_initiated",
        broker: brokerFor(agent.pkcs8Base64Url),
        handle: "signkey_operator",
        now: NOW,
      }),
    ).rejects.toThrow(/revocation refused/);
    expect(revocationRows()).toBe(0);
    expect(mutationEvents()).toBe(0);
  });
});
