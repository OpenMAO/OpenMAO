import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";
import { utcNow, type Workspace, WorkspaceSchema } from "../src/contracts/index.js";
import {
  ChainHeadAttestationStore,
  Database,
  EventStore,
  GovernanceSignatureStore,
  verifyAllChains,
  WorkspaceStore,
} from "../src/persistence/index.js";
import { dumpJson } from "../src/persistence/serialization.js";
import {
  attestChainHead,
  CHAIN_HEAD_ATTESTED_EVENT,
  ChainAttestationError,
} from "../src/security/chain-attestation.js";
import { verifyObject } from "../src/security/signing.js";
import { StaticSigningBroker } from "../src/security/signing-broker.js";
import { createSigningOperator } from "./helpers/principals.js";

const fixturePath = new URL("../../tests/fixtures/canonical_v0.json", import.meta.url);
const GENESIS_HASH = "0".repeat(64);

/**
 * Splits a governance_signatures.signed_bytes value ("header.payload") and
 * decodes the signed body — the exact bytes the operator key signed.
 */
function decodeSignedBody(signedBytes: string): Record<string, unknown> {
  const [headerSegment, payloadSegment] = signedBytes.split(".");
  expect(headerSegment).toBeTruthy();
  expect(payloadSegment).toBeTruthy();
  return JSON.parse(Buffer.from(payloadSegment ?? "", "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
}

/**
 * Adversary simulation: an attacker with direct file access drops the
 * append-only trigger, mutates events, and RE-CHAINS the whole workspace log
 * (recomputing every prev_hash and content hash) so the internal walk —
 * hashes recomputed from the surviving events — passes. Only an anchor
 * outside the reconstructed log can catch this.
 */
function mutateAndRechain(
  database: Database,
  workspaceId: string,
  mutate: (event: Record<string, unknown>) => void,
): void {
  const rows = database.connection
    .prepare("SELECT id, payload_json FROM events WHERE workspace_id = ? ORDER BY seq")
    .all(workspaceId) as Array<{ id: string; payload_json: string }>;
  const update = database.connection.prepare("UPDATE events SET payload_json = ? WHERE id = ?");
  let previousHash = GENESIS_HASH;
  for (const row of rows) {
    const event = JSON.parse(row.payload_json) as Record<string, unknown>;
    mutate(event);
    event.prev_hash = previousHash;
    const { hash: _hash, ...content } = event;
    event.hash = createHash("sha256").update(dumpJson(content)).digest("hex");
    previousHash = event.hash as string;
    update.run(dumpJson(event), row.id);
  }
}

describe("chain head attestation store", () => {
  let database: Database;
  let workspaceId: string;

  beforeEach(async () => {
    database = new Database();
    database.initialize();
    const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as Record<string, unknown>;
    const workspace: Workspace = WorkspaceSchema.parse(fixture.workspace);
    new WorkspaceStore(database).save(workspace);
    workspaceId = workspace.id;
  });

  afterEach(() => {
    database.close();
  });

  it("is append-only: the triggers refuse update and delete", () => {
    const events = new EventStore(database);
    events.append({ workspace_id: workspaceId, kind: "demo.first", actor: "alice" });
    const operator = createSigningOperator(database, workspaceId, "operator");
    const { attestation } = attestChainHead({
      database,
      workspaceId,
      signer: operator.signer,
    });

    expect(() =>
      database.connection
        .prepare("UPDATE chain_head_attestations SET head_hash = ? WHERE id = ?")
        .run("0".repeat(64), attestation.id),
    ).toThrow(/append-only/);
    expect(() =>
      database.connection
        .prepare("DELETE FROM chain_head_attestations WHERE id = ?")
        .run(attestation.id),
    ).toThrow(/append-only/);
  });

  it("treats a same-position attestation with different facts as a conflict, never a retry", () => {
    const events = new EventStore(database);
    events.append({ workspace_id: workspaceId, kind: "demo.first", actor: "alice" });
    const operator = createSigningOperator(database, workspaceId, "operator");
    const { attestation } = attestChainHead({
      database,
      workspaceId,
      signer: operator.signer,
    });

    const store = new ChainHeadAttestationStore(database);
    expect(() =>
      store.record({
        ...attestation,
        id: "chainatt_conflicting",
        head_hash: "f".repeat(64),
      }),
    ).toThrow(/conflicting chain head attestation/);
  });
});

describe("attestChainHead", () => {
  let database: Database;
  let events: EventStore;
  let workspaceId: string;

  beforeEach(async () => {
    database = new Database();
    database.initialize();
    const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as Record<string, unknown>;
    const workspace: Workspace = WorkspaceSchema.parse(fixture.workspace);
    new WorkspaceStore(database).save(workspace);
    workspaceId = workspace.id;
    events = new EventStore(database);
  });

  afterEach(() => {
    database.close();
  });

  it("signs the stored head and commits row, signature, and event atomically", () => {
    const first = events.append({
      workspace_id: workspaceId,
      kind: "demo.first",
      actor: "alice",
      timestamp: "2026-07-20T10:00:00.000Z",
    });
    const second = events.append({
      workspace_id: workspaceId,
      kind: "demo.second",
      actor: "bob",
      timestamp: "2026-07-20T11:00:00.000Z",
    });
    const operator = createSigningOperator(database, workspaceId, "operator");
    const eventCountBefore = events.listForWorkspace(workspaceId).length;

    const result = attestChainHead({ database, workspaceId, signer: operator.signer });

    expect(result.created).toBe(true);
    const { attestation } = result;
    expect(attestation.head_sequence).toBe(second.seq);
    expect(attestation.head_hash).toBe(second.hash);
    expect(attestation.event_count).toBe(eventCountBefore);
    expect(attestation.previous_attestation_id).toBeNull();
    expect(attestation.signer_key_id).toBe(operator.keyId);
    expect(attestation.signer_principal_id).toBe(operator.principal.principal_id);

    // The signed body is derived from STORED state: the head the log carried,
    // not anything a caller supplied — and attested_at is the stored head
    // event's timestamp, never the wall clock at signing time.
    const signatures = new GovernanceSignatureStore(database).listByType(
      workspaceId,
      "chain_attestation",
    );
    expect(signatures).toHaveLength(1);
    const signature = signatures[0];
    expect(signature?.id).toBe(attestation.signature_id);
    const body = decodeSignedBody(signature?.signed_bytes ?? "");
    expect(body).toEqual({
      workspace_id: workspaceId,
      object_id: attestation.id,
      signer: operator.principal.principal_id,
      signer_key_id: operator.keyId,
      head_sequence: second.seq,
      head_hash: second.hash,
      event_count: eventCountBefore,
      previous_attestation_id: null,
      attested_at: second.timestamp,
    });
    expect(attestation.attested_at).toBe(second.timestamp);
    expect(attestation.attested_at).not.toBe(first.timestamp);

    // The produced envelope verifies against the stored enrolled key through
    // the production verifier.
    const [protectedHeaderSegment, payloadSegment] = (signature?.signed_bytes ?? "").split(".");
    const verdict = verifyObject({
      database,
      workspaceId,
      expectedClass: "chain_attestation",
      expectedObjectId: attestation.id,
      envelope: {
        protectedHeaderSegment: protectedHeaderSegment ?? "",
        payloadSegment: payloadSegment ?? "",
        signatureSegment: signature?.signature ?? "",
      },
      now: utcNow(),
    });
    expect(verdict.ok).toBe(true);

    // The audit event landed in the same transaction and names the attestation.
    const attestedEvents = events
      .listForWorkspace(workspaceId)
      .filter((event) => event.kind === CHAIN_HEAD_ATTESTED_EVENT);
    expect(attestedEvents).toHaveLength(1);
    const data = attestedEvents[0]?.payload.data as Record<string, unknown>;
    expect(data.attestation_id).toBe(attestation.id);
    expect(data.head_hash).toBe(second.hash);

    // The chain — now including the attestation event itself — still verifies.
    expect(events.verifyChain(workspaceId)).toEqual({ ok: true });
  });

  it("is a byte-identical no-op at an unchanged head: nothing is signed or written", () => {
    events.append({ workspace_id: workspaceId, kind: "demo.first", actor: "alice" });
    const operator = createSigningOperator(database, workspaceId, "operator");

    const first = attestChainHead({ database, workspaceId, signer: operator.signer });
    const second = attestChainHead({ database, workspaceId, signer: operator.signer });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.attestation).toEqual(first.attestation);
    expect(new ChainHeadAttestationStore(database).listForWorkspace(workspaceId)).toHaveLength(1);
    expect(
      new GovernanceSignatureStore(database).listByType(workspaceId, "chain_attestation"),
    ).toHaveLength(1);
    expect(
      events.listForWorkspace(workspaceId).filter((e) => e.kind === CHAIN_HEAD_ATTESTED_EVENT),
    ).toHaveLength(1);
  });

  it("self-chains: a later attestation names the previous one and the advanced head", () => {
    events.append({ workspace_id: workspaceId, kind: "demo.first", actor: "alice" });
    const operator = createSigningOperator(database, workspaceId, "operator");
    const first = attestChainHead({ database, workspaceId, signer: operator.signer });

    const later = events.append({ workspace_id: workspaceId, kind: "demo.second", actor: "bob" });
    const second = attestChainHead({ database, workspaceId, signer: operator.signer });

    expect(second.created).toBe(true);
    expect(second.attestation.previous_attestation_id).toBe(first.attestation.id);
    expect(second.attestation.head_sequence).toBe(later.seq);
    expect(second.attestation.head_hash).toBe(later.hash);
    const body = decodeSignedBody(
      new GovernanceSignatureStore(database).forObject(
        workspaceId,
        "chain_attestation",
        second.attestation.id,
      )[0]?.signed_bytes ?? "",
    );
    expect(body.previous_attestation_id).toBe(first.attestation.id);
  });

  it("refuses a broker that does not hold the enrolled key — and writes nothing", () => {
    events.append({ workspace_id: workspaceId, kind: "demo.first", actor: "alice" });
    const operator = createSigningOperator(database, workspaceId, "operator");
    const wrongKey = generateKeyPairSync("ed25519")
      .privateKey.export({ format: "der", type: "pkcs8" })
      .toString("base64url");
    const eventsBefore = events.listForWorkspace(workspaceId).length;

    expect(() =>
      attestChainHead({
        database,
        workspaceId,
        signer: {
          ...operator.signer,
          broker: new StaticSigningBroker({ signkey_operator: wrongKey }),
        },
      }),
    ).toThrow(ChainAttestationError);

    expect(new ChainHeadAttestationStore(database).listForWorkspace(workspaceId)).toHaveLength(0);
    expect(
      new GovernanceSignatureStore(database).listByType(workspaceId, "chain_attestation"),
    ).toHaveLength(0);
    expect(events.listForWorkspace(workspaceId)).toHaveLength(eventsBefore);
  });

  it("refuses a spread copy of the authenticated principal — provenance, not marker shape", () => {
    events.append({ workspace_id: workspaceId, kind: "demo.first", actor: "alice" });
    const operator = createSigningOperator(database, workspaceId, "operator");

    expect(() =>
      attestChainHead({
        database,
        workspaceId,
        signer: { ...operator.signer, principal: { ...operator.principal } },
      }),
    ).toThrow(/authenticated principal/);
    expect(new ChainHeadAttestationStore(database).listForWorkspace(workspaceId)).toHaveLength(0);
  });

  it("refuses a non-human signer per the stored row", () => {
    events.append({ workspace_id: workspaceId, kind: "demo.first", actor: "alice" });
    const operator = createSigningOperator(database, workspaceId, "operator");
    database.connection
      .prepare("UPDATE principals SET kind = 'agent' WHERE id = ?")
      .run(operator.principal.principal_id);

    expect(() => attestChainHead({ database, workspaceId, signer: operator.signer })).toThrow(
      /not human/,
    );
    expect(new ChainHeadAttestationStore(database).listForWorkspace(workspaceId)).toHaveLength(0);
  });

  it("refuses to attest an empty event log", () => {
    const operator = createSigningOperator(database, workspaceId, "operator");
    expect(() => attestChainHead({ database, workspaceId, signer: operator.signer })).toThrow(
      /no events to attest/,
    );
  });
});

describe("chain durability across schema evolution (the M6 guardrail)", () => {
  let tmpRoot: string;
  let dbPath: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "openmao-ts-chain-attest-"));
    dbPath = join(tmpRoot, "openmao.sqlite3");
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  async function seedWorkspace(database: Database): Promise<string> {
    const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as Record<string, unknown>;
    const workspace: Workspace = WorkspaceSchema.parse(fixture.workspace);
    new WorkspaceStore(database).save(workspace);
    return workspace.id;
  }

  it("a pre-existing database re-opened and re-parsed through the CURRENT schemas still verifies", async () => {
    // Every other chain test builds a fresh in-memory database, so nothing
    // else catches the hazard where a defaulted field added to EventSchema /
    // EventPayloadSchema / ExternalActorRefSchema materializes on re-parse and
    // changes the recomputed hash of every already-chained event. This test is
    // the guardrail that makes the zero-contract-fields rule enforceable.
    const workspaceId = await (async () => {
      const database = new Database(dbPath);
      database.initialize();
      try {
        const id = await seedWorkspace(database);
        const events = new EventStore(database);
        events.append({ workspace_id: id, kind: "demo.first", actor: "alice" });
        events.append({
          workspace_id: id,
          kind: "demo.second",
          actor: "bob",
          payload: {
            data: { note: "payload with data" },
            refs: [],
            actor_ref: null,
            produced_refs: [],
            consumed_refs: [],
            causal_parent_id: null,
          },
        });
        const operator = createSigningOperator(database, id, "operator");
        attestChainHead({ database, workspaceId: id, signer: operator.signer });
        return id;
      } finally {
        database.close();
      }
    })();

    // Re-open from disk and re-run the CURRENT DDL + verification: every
    // stored row is re-parsed through the current EventSchema and re-hashed.
    const reopened = new Database(dbPath);
    reopened.initialize();
    try {
      expect(new EventStore(reopened).verifyChain(workspaceId)).toEqual({ ok: true });
      const report = verifyAllChains(reopened);
      expect(report.ok).toBe(true);

      // The attestation survived the re-open and still verifies against the
      // stored enrolled key — the anchor is durable, not session state.
      const attestation = new ChainHeadAttestationStore(reopened).latestForWorkspace(workspaceId);
      expect(attestation).not.toBeNull();
      const signature = new GovernanceSignatureStore(reopened).forObject(
        workspaceId,
        "chain_attestation",
        attestation?.id ?? "",
      )[0];
      const [protectedHeaderSegment, payloadSegment] = (signature?.signed_bytes ?? "").split(".");
      const verdict = verifyObject({
        database: reopened,
        workspaceId,
        expectedClass: "chain_attestation",
        expectedObjectId: attestation?.id ?? "",
        envelope: {
          protectedHeaderSegment: protectedHeaderSegment ?? "",
          payloadSegment: payloadSegment ?? "",
          signatureSegment: signature?.signature ?? "",
        },
        now: utcNow(),
      });
      expect(verdict.ok).toBe(true);
    } finally {
      reopened.close();
    }
  });
});

describe("truncation detection through the attestation anchor", () => {
  let tmpRoot: string;
  let dbPath: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "openmao-ts-truncate-"));
    dbPath = join(tmpRoot, "openmao.sqlite3");
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  async function buildChainedDatabase(attest: boolean): Promise<string> {
    const database = new Database(dbPath);
    database.initialize();
    try {
      const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as Record<string, unknown>;
      const workspace: Workspace = WorkspaceSchema.parse(fixture.workspace);
      new WorkspaceStore(database).save(workspace);
      const events = new EventStore(database);
      events.append({ workspace_id: workspace.id, kind: "demo.first", actor: "alice" });
      events.append({ workspace_id: workspace.id, kind: "demo.second", actor: "bob" });
      events.append({ workspace_id: workspace.id, kind: "demo.third", actor: "carol" });
      if (attest) {
        const operator = createSigningOperator(database, workspace.id, "operator");
        attestChainHead({ database, workspaceId: workspace.id, signer: operator.signer });
      }
      return workspace.id;
    } finally {
      database.close();
    }
  }

  it("deleting the newest events is DETECTED against a surviving attestation", async () => {
    const workspaceId = await buildChainedDatabase(true);

    const database = new Database(dbPath);
    try {
      // Out-of-band truncation: an attacker with file access drops the
      // append-only trigger and deletes the two newest events — the
      // attestation event and the one before it. The surviving chain is
      // internally consistent, and pre-M6 verify-chain reported ok here.
      database.connection.exec("DROP TRIGGER events_no_delete");
      database.connection
        .prepare("DELETE FROM events WHERE workspace_id = ? AND seq > ?")
        .run(workspaceId, 2);

      const verification = new EventStore(database).verifyChain(workspaceId);
      expect(verification.ok).toBe(false);
      if (!verification.ok) {
        expect(verification.reason).toContain("truncation");
      }
      const report = verifyAllChains(database);
      expect(report.ok).toBe(false);
    } finally {
      database.close();
    }
  });

  it("HONEST SCOPE: the same deletion WITHOUT a surviving attestation still verifies ok", async () => {
    // This control pins the limit the mechanism honestly has: with no
    // attestation (none written, or the rows deleted beside the events), the
    // arm has nothing to compare against and the pre-M6 semantics apply.
    const workspaceId = await buildChainedDatabase(false);

    const database = new Database(dbPath);
    try {
      database.connection.exec("DROP TRIGGER events_no_delete");
      database.connection
        .prepare("DELETE FROM events WHERE workspace_id = ? AND seq > ?")
        .run(workspaceId, 2);

      expect(new EventStore(database).verifyChain(workspaceId)).toEqual({ ok: true });
    } finally {
      database.close();
    }
  });

  it("a rewrite that RE-CHAINS the whole log is detected by the attested head hash", async () => {
    const workspaceId = await buildChainedDatabase(true);

    const database = new Database(dbPath);
    try {
      // The strongest in-file attacker: rewrites history AND recomputes every
      // hash, so the internal walk passes. Today this verifies ok; the
      // attestation pins the head hash outside the reconstructed log.
      database.connection.exec("DROP TRIGGER events_no_update");
      mutateAndRechain(database, workspaceId, (event) => {
        if (event.seq === 1) {
          event.actor = "intruder";
        }
      });

      const verification = new EventStore(database).verifyChain(workspaceId);
      expect(verification.ok).toBe(false);
      if (!verification.ok) {
        expect(verification.reason).toContain("attested head mismatch");
      }
    } finally {
      database.close();
    }
  });

  it("HONEST SCOPE: the same re-chain WITHOUT an attestation verifies ok (the pre-M6 blindness)", async () => {
    const workspaceId = await buildChainedDatabase(false);

    const database = new Database(dbPath);
    try {
      database.connection.exec("DROP TRIGGER events_no_update");
      mutateAndRechain(database, workspaceId, (event) => {
        if (event.seq === 1) {
          event.actor = "intruder";
        }
      });

      // The recomputed chain is perfectly self-consistent: the internal walk
      // alone cannot see the rewrite. The attestation arm is what adds sight.
      expect(new EventStore(database).verifyChain(workspaceId)).toEqual({ ok: true });
    } finally {
      database.close();
    }
  });

  it("a pre-M6 database (no attestation table) verifies read-only with the arm inapplicable", async () => {
    const workspaceId = await buildChainedDatabase(false);

    const database = new Database(dbPath);
    try {
      // Simulate a legacy database the read-only verify-chain path opens: the
      // M6 table was never created (no DDL ran). The arm must treat its
      // absence as "no attestations", never as a failure.
      database.connection.exec("DROP TABLE chain_head_attestations");
      expect(new EventStore(database).verifyChain(workspaceId)).toEqual({ ok: true });
    } finally {
      database.close();
    }
  });
});

describe("cli attest + verify-chain", () => {
  let tmpRoot: string;
  let dbPath: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "openmao-ts-attest-cli-"));
    dbPath = join(tmpRoot, "openmao.sqlite3");
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("attests the demo chain with no prompt and no new argument, then verify-chain confirms", async () => {
    const lines: string[] = [];
    expect(await runCli(["demo"], { dbPath, write: (m) => lines.push(m) })).toBe(0);

    const code = await runCli(["attest"], { dbPath, write: (m) => lines.push(m) });
    expect(code).toBe(0);
    const attestation = JSON.parse(lines.at(-1) ?? "{}") as {
      created: boolean;
      head_sequence: number;
      head_hash: string;
      event_count: number;
      previous_attestation_id: string | null;
      signer_principal_id: string;
    };
    expect(attestation.created).toBe(true);
    expect(attestation.head_sequence).toBeGreaterThan(0);
    expect(attestation.head_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(attestation.previous_attestation_id).toBeNull();

    // Re-attesting an unchanged head is a no-op.
    expect(await runCli(["attest"], { dbPath, write: (m) => lines.push(m) })).toBe(0);
    const replay = JSON.parse(lines.at(-1) ?? "{}") as { created: boolean; id: string };
    expect(replay.created).toBe(false);

    expect(await runCli(["verify-chain"], { dbPath, write: (m) => lines.push(m) })).toBe(0);
    expect((JSON.parse(lines.at(-1) ?? "{}") as { ok: boolean }).ok).toBe(true);
  });

  it("verify-chain exits 1 with the truncation reason after the newest events are deleted", async () => {
    expect(await runCli(["demo"], { dbPath, write: () => {} })).toBe(0);
    expect(await runCli(["attest"], { dbPath, write: () => {} })).toBe(0);

    const database = new Database(dbPath);
    try {
      database.connection.exec("DROP TRIGGER events_no_delete");
      database.connection.prepare("DELETE FROM events WHERE seq > 2").run();
    } finally {
      database.close();
    }

    const lines: string[] = [];
    const code = await runCli(["verify-chain"], { dbPath, write: (m) => lines.push(m) });
    expect(code).toBe(1);
    const report = JSON.parse(lines.at(-1) ?? "{}") as {
      ok: boolean;
      workspaces: Array<{ verification: { ok: boolean; reason?: string } }>;
    };
    expect(report.ok).toBe(false);
    expect(report.workspaces[0]?.verification.reason).toContain("truncation");
  });
});
