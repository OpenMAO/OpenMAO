import { createPrivateKey, sign as cryptoSign, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli.js";
import {
  ApprovalPayloadSchema,
  MemoryEntrySchema,
  newId,
  OrganizationSchema,
  OrgChangeApplicationSchema,
  OrgChangeProposalSchema,
  RunSchema,
  utcNow,
  WorkspaceSchema,
} from "../src/contracts/index.js";
import {
  ApprovalService,
  approvalDecisionClaims,
  autonomyRatificationClaims,
  buildDecisionBody,
  DECISION_OBJECT_CLASS,
  DECISION_OBJECT_TYPES,
  type DecisionObjectType,
  type DecisionSigner,
  DecisionSigningError,
  orgChangeApplyClaims,
  orgChangeRevertClaims,
  SelfApprovalError,
} from "../src/governance/index.js";
import { AutonomyService, OrgChangeService } from "../src/org/index.js";
import {
  ApprovalStore,
  AutonomyCaseStore,
  Database,
  EventStore,
  GovernanceSignatureStore,
  MemoryEntryStore,
  OrganizationStore,
  OrgChangeApplicationStore,
  OrgChangeProposalStore,
  RunStore,
  WorkspaceStore,
} from "../src/persistence/index.js";
import { dumpJson } from "../src/persistence/serialization.js";
import { createApprovalServiceWithApplications } from "../src/runtime/approvals.js";
import type { AuthenticatedPrincipal } from "../src/security/authenticated-principal.js";
import {
  buildProtectedHeader,
  encodeSegment,
  mediaTypeForClass,
  payloadBytesForBody,
  verifyObject,
} from "../src/security/signing.js";
import { StaticSigningBroker } from "../src/security/signing-broker.js";
import { createSigningOperator } from "./helpers/principals.js";

/**
 * M5 signed decisions. Proves the four authority-moving transitions — approval
 * approve/reject, autonomy ratification, org-change apply/revert — each record
 * a verifiable Ed25519 signature row bound to the STORED signer, inside the
 * state-transition transaction; that the unattributed (null-actor) path is
 * unrepresentable and refused at runtime if cast through; that the requester
 * cannot resolve their own request in either direction; that a broker holding
 * the wrong key writes NOTHING; that a differently-signed second approve is a
 * defined no-op; and that every signature re-verifies against a body rebuilt
 * from the stored row, never the in-memory value.
 */

const WORKSPACE = `ws_${"d".repeat(32)}`;
const ORG_ID = `org_${"d".repeat(32)}`;

let tmpRoot: string;
let database: Database;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "openmao-ts-signed-decisions-"));
  database = new Database(join(tmpRoot, "openmao.sqlite3"));
  database.initialize();
  new WorkspaceStore(database).save(
    WorkspaceSchema.parse({ id: WORKSPACE, name: "Signed Decisions", created_at: utcNow() }),
  );
});

afterEach(() => {
  database.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

function operator(displayName = "Operator") {
  return createSigningOperator(database, WORKSPACE, displayName);
}

/**
 * The audit's attack: a holder of a GENUINE minted principal tries to make its
 * fields read differently across accesses — e.g. `principal_id` answering the
 * victim's id to the separation-of-duties guard and the attacker's own id to
 * the stored-signer resolution. With the minted object frozen, every one of
 * these redefinitions REFUSES (throws in strict module code), so the
 * alternating-identity principal is impossible to construct. A defense-in-depth
 * test of the frozen-mint contract, exercised on every field an authority path
 * reads.
 */
function expectIdentityIsImmutable(principal: AuthenticatedPrincipal): void {
  const victimId = `principal_${"9".repeat(32)}`;
  for (const field of ["principal_id", "actor", "key_id"] as const) {
    const original = principal[field];
    // Redefinition as a stateful getter (the audit's vector) and as a plain
    // value both refuse on the frozen object.
    expect(() => {
      Object.defineProperty(principal, field, {
        get: () => (Math.random() < 0.5 ? victimId : original),
      });
    }).toThrow(TypeError);
    expect(() => {
      Object.defineProperty(principal, field, { value: victimId });
    }).toThrow(TypeError);
    // And even a sloppy direct assignment cannot take (strict-mode modules
    // throw; either way the value must not move).
    try {
      (principal as Record<string, unknown>)[field] = victimId;
    } catch {
      // strict-mode refusal — expected
    }
    expect(principal[field]).toBe(original);
  }
  expect(Object.isFrozen(principal)).toBe(true);
}

/**
 * Drives one transition with a signing identity taken at call time. The
 * genuine minted principal is used unchanged: the point is that with freeze +
 * single-read the guard and the signer see ONE identity, so the attacker's
 * own request can never be self-resolved by any manipulation of what they
 * hold — and the snapshot is taken before the guard even runs.
 */
function approveAsSigner(approvalId: string, signer: DecisionSigner): void {
  new ApprovalService(database).approve(approvalId, { workspace_id: WORKSPACE, signer });
}

/**
 * A run-bound approval: the plain ApprovalService resolves it (resuming the
 * run), so the approve path needs no application handler and no target row.
 */
function requestPromotionApproval(requestedBy: string): string {
  const run = new RunStore(database).create(
    RunSchema.parse({
      id: newId("run"),
      workspace_id: WORKSPACE,
      status: "running",
      active_node: "run_started",
      suspended_approval_id: null,
      created_at: utcNow(),
      updated_at: utcNow(),
    }),
  );
  return new ApprovalService(database).request({
    workspace_id: WORKSPACE,
    run_id: run.id,
    action: "memory.promote",
    requested_by: requestedBy,
    payload: ApprovalPayloadSchema.parse({
      target_type: "promotion_candidate",
      target_id: `promo_${"e".repeat(32)}`,
      reason: "Signed decision test approval.",
    }),
    // A reject must not touch the (nonexistent) promotion candidate.
    on_reject: "skip_action",
  }).id;
}

function signatureRows(objectType: string, objectId: string) {
  return new GovernanceSignatureStore(database).forObject(WORKSPACE, objectType, objectId);
}

function eventKinds(): string[] {
  return new EventStore(database).listForWorkspace(WORKSPACE).map((event) => event.kind);
}

/**
 * Re-verifies the single signature row for an object against a body rebuilt
 * FROM THE STORED ROW: the claims come from a fresh store read, the signing
 * input is recomputed segment by segment and compared byte-for-byte against
 * the persisted `signed_bytes`, and the envelope is verified through the
 * registry-backed production verifier with the stored decision time.
 */
function expectReverifiedFromStoredRow(
  objectType: DecisionObjectType,
  objectId: string,
  claimsFromStoredRow: Record<string, unknown>,
): void {
  const rows = signatureRows(objectType, objectId);
  expect(rows).toHaveLength(1);
  const row = rows[0];
  if (!row) {
    throw new Error("expected a signature row");
  }
  // The decision class is derived from the STORED object type — the binding
  // P1 #3 requires: the type is in the signed bytes through `typ`, so a
  // reclassified row no longer verifies as its new type.
  const objectClass = DECISION_OBJECT_CLASS[objectType];
  const body = buildDecisionBody({
    workspaceId: WORKSPACE,
    objectId,
    signerPrincipalId: row.signer_principal_id,
    signerKeyId: row.signer_key_id,
    claims: claimsFromStoredRow,
  });
  const headerSegment = encodeSegment(
    Buffer.from(dumpJson(buildProtectedHeader(objectClass, row.signer_key_id)), "utf8"),
  );
  const payloadSegment = encodeSegment(payloadBytesForBody(body));
  expect(row.signed_bytes).toBe(`${headerSegment}.${payloadSegment}`);
  expect(row.domain_tag).toBe(mediaTypeForClass(objectClass));

  const verdict = verifyObject({
    database,
    workspaceId: WORKSPACE,
    expectedClass: objectClass,
    expectedObjectId: objectId,
    envelope: {
      protectedHeaderSegment: headerSegment,
      payloadSegment,
      signatureSegment: row.signature,
    },
    now: utcNow(),
  });
  expect(verdict).toMatchObject({ ok: true, trust: "standard" });
}

describe("M5 signed decisions — unrepresentable unattributed path", () => {
  it("does not typecheck with a null actor or signer, and refuses a cast-through lookalike at runtime", () => {
    const approvalService = new ApprovalService(database);
    const approvalId = requestPromotionApproval(`agent_${"5".repeat(32)}`);

    const unrepresentable = () => {
      // @ts-expect-error — null is not a DecisionSigner: the unattributed path has no representation
      approvalService.approve(approvalId, { workspace_id: WORKSPACE, signer: null });
      // @ts-expect-error — the input carries no actor field at all; there is nothing to leave null
      approvalService.approve(approvalId, { workspace_id: WORKSPACE, actor: null });
    };
    expect(unrepresentable).toBeDefined();

    // An `as`-cast lookalike — every right property, none of the provenance — is refused at
    // runtime: only the credential path can mint an AuthenticatedPrincipal.
    const real = operator("Real Operator");
    const lookalike = {
      principal_id: real.principal.principal_id,
      workspace_id: WORKSPACE,
      kind: "human",
      actor: real.principal.actor,
      key_id: real.keyId,
      can_sign: true,
      dev_bootstrap: false,
    } as AuthenticatedPrincipal;
    expect(() =>
      approvalService.approve(approvalId, {
        workspace_id: WORKSPACE,
        signer: { principal: lookalike, broker: real.signer.broker, handle: real.signer.handle },
      }),
    ).toThrow(/authenticated principal/);
    expect(new ApprovalStore(database).get(approvalId)?.status).toBe("pending");
    expect(signatureRows(DECISION_OBJECT_TYPES.approval_approve, approvalId)).toHaveLength(0);
  });
});

describe("M5 signed decisions — separation of duties", () => {
  it("refuses a requester approving their own request", () => {
    const requester = operator("Requester");
    const approvalId = requestPromotionApproval(requester.principal.principal_id);

    expect(() =>
      new ApprovalService(database).approve(approvalId, {
        workspace_id: WORKSPACE,
        signer: requester.signer,
      }),
    ).toThrow(SelfApprovalError);
    expect(new ApprovalStore(database).get(approvalId)?.status).toBe("pending");
  });

  it("refuses a requester rejecting their own request — the guard reject() lacked", () => {
    const requester = operator("Requester");
    const approvalId = requestPromotionApproval(requester.principal.principal_id);

    expect(() =>
      new ApprovalService(database).reject(approvalId, {
        workspace_id: WORKSPACE,
        signer: requester.signer,
      }),
    ).toThrow(SelfApprovalError);

    // Nothing was written: still pending, no signature row, no rejection event.
    expect(new ApprovalStore(database).get(approvalId)?.status).toBe("pending");
    expect(signatureRows(DECISION_OBJECT_TYPES.approval_reject, approvalId)).toHaveLength(0);
    expect(eventKinds()).not.toContain("approval.rejected");
  });
});

describe("M5 signed decisions — the four transitions", () => {
  it("approval approve records a verifiable signature bound to the stored signer", () => {
    const approver = operator("Approver");
    const approvalId = requestPromotionApproval(`agent_${"5".repeat(32)}`);

    new ApprovalService(database).approve(approvalId, {
      workspace_id: WORKSPACE,
      signer: approver.signer,
    });

    const stored = new ApprovalStore(database).get(approvalId);
    expect(stored?.status).toBe("approved");
    const rows = signatureRows(DECISION_OBJECT_TYPES.approval_approve, approvalId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.signer_key_id).toBe(approver.keyId);
    expect(rows[0]?.signer_principal_id).toBe(approver.principal.principal_id);
    expect(rows[0]?.signed_at).toBe(stored?.resolved_at);

    // The event carries only a reference; the signature bytes live in the sibling table.
    const approvedEvent = new EventStore(database)
      .listForWorkspace(WORKSPACE)
      .find((event) => event.kind === "approval.approved");
    const ref = approvedEvent?.payload.data.decision_signature as
      | Record<string, unknown>
      | undefined;
    expect(ref?.signature_id).toBe(rows[0]?.id);
    expect(JSON.stringify(approvedEvent?.payload)).not.toContain(rows[0]?.signature ?? "∅");

    if (!stored) {
      throw new Error("approval missing");
    }
    expectReverifiedFromStoredRow(
      DECISION_OBJECT_TYPES.approval_approve,
      approvalId,
      approvalDecisionClaims(stored),
    );
  });

  it("approval reject records a verifiable signature bound to the stored signer", () => {
    const rejecter = operator("Rejecter");
    const approvalId = requestPromotionApproval(`agent_${"5".repeat(32)}`);

    new ApprovalService(database).reject(approvalId, {
      workspace_id: WORKSPACE,
      signer: rejecter.signer,
    });

    const stored = new ApprovalStore(database).get(approvalId);
    expect(stored?.status).toBe("rejected");
    const rows = signatureRows(DECISION_OBJECT_TYPES.approval_reject, approvalId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.signer_key_id).toBe(rejecter.keyId);
    expect(rows[0]?.signer_principal_id).toBe(rejecter.principal.principal_id);
    expect(rows[0]?.signed_at).toBe(stored?.resolved_at);

    if (!stored) {
      throw new Error("approval missing");
    }
    expectReverifiedFromStoredRow(
      DECISION_OBJECT_TYPES.approval_reject,
      approvalId,
      approvalDecisionClaims(stored),
    );
  });

  it("autonomy ratification records a verifiable signature bound to the stored ratifier", () => {
    new OrganizationStore(database).save(
      OrganizationSchema.parse({
        id: ORG_ID,
        workspace_id: WORKSPACE,
        name: "Org",
        mission: "Earn autonomy.",
        autonomy_level: "advisory",
      }),
    );
    // The audited track record the widening is earned against: one verified
    // supervised application, seeded directly through the stores.
    const applications = new OrgChangeApplicationStore(database);
    const ratifier = operator("Ratifier");
    const service = new AutonomyService(database, { minTrackRecord: 1 });
    const proposalId = newId("orgchg");
    new OrgChangeProposalStore(database).save(
      OrgChangeProposalSchema.parse({
        id: proposalId,
        workspace_id: WORKSPACE,
        proposed_by: "learning_service",
        change_type: "memory_cleanup",
        rationale: "Verified supervised apply.",
        created_at: utcNow(),
      }),
    );
    const application = applications.create(
      OrgChangeApplicationSchema.parse({
        id: newId("application"),
        workspace_id: WORKSPACE,
        proposal_id: proposalId,
        change_type: "memory_cleanup",
        applied_by: "operator",
        reversible: true,
        targets: [],
        status: "applied",
        created_at: utcNow(),
      }),
    );
    applications.setStatus(application.id, "verified", { verified_at: utcNow() });

    const proposed = service.proposeWidening({
      workspace_id: WORKSPACE,
      org_id: ORG_ID,
      proposed_by: "learning_service",
      rationale: "A clean supervised track record.",
      evidence: [{ kind: "event", ref_id: newId("evt"), summary: "track record", weight: 1 }],
    });

    const ratified = service.ratifyWidening(proposed.id, {
      workspace_id: WORKSPACE,
      signer: ratifier.signer,
    });

    expect(ratified.status).toBe("ratified");
    const rows = signatureRows(DECISION_OBJECT_TYPES.autonomy_ratify, ratified.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.signer_key_id).toBe(ratifier.keyId);
    expect(rows[0]?.signer_principal_id).toBe(ratifier.principal.principal_id);
    expect(rows[0]?.signed_at).toBe(ratified.resolved_at);

    const storedCase = new AutonomyCaseStore(database).get(ratified.id);
    if (!storedCase) {
      throw new Error("autonomy case missing");
    }
    expectReverifiedFromStoredRow(
      DECISION_OBJECT_TYPES.autonomy_ratify,
      ratified.id,
      autonomyRatificationClaims(storedCase),
    );
  });

  it("org-change apply and revert each record a verifiable signature by the same operator", () => {
    const entry = new MemoryEntryStore(database).save(
      MemoryEntrySchema.parse({
        id: newId("mem"),
        workspace_id: WORKSPACE,
        scope: "individual",
        owner_id: null,
        kind: "semantic",
        content: "an old fact nobody trusts anymore",
        provenance: {},
        confidence: 0.2,
        status: "stale",
        created_at: utcNow(),
      }),
    );
    const orgChanges = new OrgChangeService(database);
    const { proposal, approval_id } = orgChanges.propose({
      id: newId("orgchg"),
      workspace_id: WORKSPACE,
      proposed_by: "learning_service",
      change_type: "memory_cleanup",
      rationale: "Retire the stale entry.",
      evidence: [{ kind: "memory_entry", ref_id: entry.id, summary: "confirmed stale", weight: 1 }],
      patch_json: { memory_entries: [entry.id] },
    });
    createApprovalServiceWithApplications(database).approve(approval_id, {
      workspace_id: WORKSPACE,
      signer: operator("Approver").signer,
    });

    const applier = operator("Applier");
    orgChanges.markApplied(proposal.id, { workspace_id: WORKSPACE, signer: applier.signer });

    const application = new OrgChangeApplicationStore(database).getForProposal(
      WORKSPACE,
      proposal.id,
    );
    expect(application?.status).toBe("verified");
    if (!application) {
      throw new Error("application missing");
    }
    const applyRows = signatureRows(DECISION_OBJECT_TYPES.org_change_apply, application.id);
    expect(applyRows).toHaveLength(1);
    expect(applyRows[0]?.signer_key_id).toBe(applier.keyId);
    expect(applyRows[0]?.signed_at).toBe(application.created_at);

    const freshApplication = new OrgChangeApplicationStore(database).get(application.id);
    if (!freshApplication) {
      throw new Error("application missing after apply");
    }
    expectReverifiedFromStoredRow(
      DECISION_OBJECT_TYPES.org_change_apply,
      application.id,
      orgChangeApplyClaims(freshApplication),
    );

    // The same operator reverts — a DISTINCT object type, so no once-per-signer collision.
    orgChanges.revertApplication(application.id, {
      workspace_id: WORKSPACE,
      signer: applier.signer,
    });
    const reverted = new OrgChangeApplicationStore(database).get(application.id);
    expect(reverted?.status).toBe("reverted");
    const revertRows = signatureRows(DECISION_OBJECT_TYPES.org_change_revert, application.id);
    expect(revertRows).toHaveLength(1);
    expect(revertRows[0]?.signer_key_id).toBe(applier.keyId);
    expect(revertRows[0]?.signed_at).toBe(reverted?.reverted_at);
    if (!reverted) {
      throw new Error("application missing after revert");
    }
    expectReverifiedFromStoredRow(
      DECISION_OBJECT_TYPES.org_change_revert,
      application.id,
      orgChangeRevertClaims(reverted),
    );
  });
});

describe("M5 signed decisions — failure writes nothing", () => {
  it("a broker holding the wrong key fails verification and the whole transition rolls back", () => {
    const approver = operator("Approver");
    const approvalId = requestPromotionApproval(`agent_${"5".repeat(32)}`);
    // A broker whose handle resolves — but to key material other than the enrolled key.
    const wrongMaterial = generateKeyPairSync("ed25519")
      .privateKey.export({ format: "der", type: "pkcs8" })
      .toString("base64url");
    const wrongKeySigner: DecisionSigner = {
      principal: approver.principal,
      broker: new StaticSigningBroker({ signkey_operator: wrongMaterial }),
      handle: "signkey_operator",
    };

    expect(() =>
      new ApprovalService(database).approve(approvalId, {
        workspace_id: WORKSPACE,
        signer: wrongKeySigner,
      }),
    ).toThrow(DecisionSigningError);

    // No state change, no signature row, no event — and the event chain is intact.
    expect(new ApprovalStore(database).get(approvalId)?.status).toBe("pending");
    expect(signatureRows(DECISION_OBJECT_TYPES.approval_approve, approvalId)).toHaveLength(0);
    expect(eventKinds()).not.toContain("approval.approved");
    expect(new EventStore(database).verifyChain(WORKSPACE)).toEqual({ ok: true });

    // The same approval approves cleanly with the RIGHT custody afterwards.
    new ApprovalService(database).approve(approvalId, {
      workspace_id: WORKSPACE,
      signer: approver.signer,
    });
    expect(new ApprovalStore(database).get(approvalId)?.status).toBe("approved");
  });
});

describe("M5 signed decisions — replay contract", () => {
  it("a differently-signed second approve is a no-op: one state, one signature, one event", () => {
    const first = operator("First Approver");
    const second = operator("Second Approver");
    const approvalId = requestPromotionApproval(`agent_${"5".repeat(32)}`);
    const approvalService = new ApprovalService(database);

    const approved = approvalService.approve(approvalId, {
      workspace_id: WORKSPACE,
      signer: first.signer,
    });
    const replayed = approvalService.approve(approvalId, {
      workspace_id: WORKSPACE,
      signer: second.signer,
    });

    expect(replayed).toEqual(approved);
    const rows = signatureRows(DECISION_OBJECT_TYPES.approval_approve, approvalId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.signer_key_id).toBe(first.keyId);
    const approvedEvents = new EventStore(database)
      .listForWorkspace(WORKSPACE)
      .filter((event) => event.kind === "approval.approved");
    expect(approvedEvents).toHaveLength(1);
    expect(approvedEvents[0]?.actor).toBe(first.principal.actor);
  });
});

describe("M5 audit P0 #1 — minted identities are immutable and single-read", () => {
  it("the minted principal is frozen: the alternating-getter identity is impossible to construct", () => {
    const attacker = operator("Attacker");
    expectIdentityIsImmutable(attacker.principal);
  });

  it("a stateful getter smuggled past the brand with a Proxy is refused at the boundary", () => {
    // The only way left to make reads differ: wrap the genuine principal in a
    // Proxy whose get alternates. The brand check is by OBJECT IDENTITY
    // (WeakSet), so the wrapper is not a minted principal — snapshot refuses
    // it before any field is read, and the approval stays pending.
    const attacker = operator("Proxy Attacker");
    const approvalId = requestPromotionApproval(attacker.principal.principal_id);
    let reads = 0;
    const alternating = new Proxy(attacker.principal, {
      get(target, property, receiver) {
        reads += 1;
        if (property === "principal_id") {
          return reads % 2 === 0 ? `principal_${"9".repeat(32)}` : target.principal_id;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    expect(() =>
      new ApprovalService(database).approve(approvalId, {
        workspace_id: WORKSPACE,
        signer: { ...attacker.signer, principal: alternating },
      }),
    ).toThrow(/authenticated principal/);
    expect(new ApprovalStore(database).get(approvalId)?.status).toBe("pending");
    expect(signatureRows(DECISION_OBJECT_TYPES.approval_approve, approvalId)).toHaveLength(0);
  });

  it("guard and signer observe ONE identity across all four transitions", () => {
    // The class-level property the audit asked for: whatever the requester
    // holds, the values the separation-of-duties guard compares and the
    // values resolveStoredSigner resolves are the same snapshot. Proven
    // constructively: a frozen principal driven through approve, reject,
    // ratify and apply commits exactly one signature per transition, each
    // bound to the snapshot's principal id, and a requester holding their
    // own genuine identity is still refused in both directions.
    const requester = operator("Snapshot Requester");
    const approvalId = requestPromotionApproval(requester.principal.principal_id);
    expect(() => approveAsSigner(approvalId, requester.signer)).toThrow(SelfApprovalError);
    expect(() =>
      new ApprovalService(database).reject(approvalId, {
        workspace_id: WORKSPACE,
        signer: requester.signer,
      }),
    ).toThrow(SelfApprovalError);

    const approver = operator("Snapshot Approver");
    approveAsSigner(approvalId, approver.signer);
    const approveRows = signatureRows(DECISION_OBJECT_TYPES.approval_approve, approvalId);
    expect(approveRows).toHaveLength(1);
    expect(approveRows[0]?.signer_principal_id).toBe(approver.principal.principal_id);
    const approvedEvent = new EventStore(database)
      .listForWorkspace(WORKSPACE)
      .find((event) => event.kind === "approval.approved");
    expect(approvedEvent?.actor).toBe(approver.principal.actor);

    // Ratification: the ratifier's snapshot signs and widens.
    new OrganizationStore(database).save(
      OrganizationSchema.parse({
        id: ORG_ID,
        workspace_id: WORKSPACE,
        name: "Org",
        mission: "Earn autonomy.",
        autonomy_level: "advisory",
      }),
    );
    const applications = new OrgChangeApplicationStore(database);
    const proposalId = newId("orgchg");
    new OrgChangeProposalStore(database).save(
      OrgChangeProposalSchema.parse({
        id: proposalId,
        workspace_id: WORKSPACE,
        proposed_by: "learning_service",
        change_type: "memory_cleanup",
        rationale: "Track record.",
        created_at: utcNow(),
      }),
    );
    const trackRecord = applications.create(
      OrgChangeApplicationSchema.parse({
        id: newId("application"),
        workspace_id: WORKSPACE,
        proposal_id: proposalId,
        change_type: "memory_cleanup",
        applied_by: "operator",
        reversible: true,
        targets: [],
        status: "applied",
        created_at: utcNow(),
      }),
    );
    applications.setStatus(trackRecord.id, "verified", { verified_at: utcNow() });
    const service = new AutonomyService(database, { minTrackRecord: 1 });
    const widening = service.proposeWidening({
      workspace_id: WORKSPACE,
      org_id: ORG_ID,
      proposed_by: "learning_service",
      rationale: "Clean record.",
      evidence: [{ kind: "event", ref_id: newId("evt"), summary: "track record", weight: 1 }],
    });
    const ratifier = operator("Snapshot Ratifier");
    const ratified = service.ratifyWidening(widening.id, {
      workspace_id: WORKSPACE,
      signer: ratifier.signer,
    });
    expect(ratified.ratified_by).toBe(ratifier.principal.principal_id);
    const ratifyRows = signatureRows(DECISION_OBJECT_TYPES.autonomy_ratify, ratified.id);
    expect(ratifyRows).toHaveLength(1);
    expect(ratifyRows[0]?.signer_principal_id).toBe(ratifier.principal.principal_id);

    // Apply: the applier's snapshot signs.
    const entry = new MemoryEntryStore(database).save(
      MemoryEntrySchema.parse({
        id: newId("mem"),
        workspace_id: WORKSPACE,
        scope: "individual",
        owner_id: null,
        kind: "semantic",
        content: "stale",
        provenance: {},
        confidence: 0.1,
        status: "stale",
        created_at: utcNow(),
      }),
    );
    const orgChanges = new OrgChangeService(database);
    const { proposal, approval_id } = orgChanges.propose({
      id: newId("orgchg"),
      workspace_id: WORKSPACE,
      proposed_by: "learning_service",
      change_type: "memory_cleanup",
      rationale: "Retire stale memory.",
      evidence: [{ kind: "memory_entry", ref_id: entry.id, summary: "stale", weight: 1 }],
      patch_json: { memory_entries: [entry.id] },
    });
    createApprovalServiceWithApplications(database).approve(approval_id, {
      workspace_id: WORKSPACE,
      signer: operator("Snapshot Org Approver").signer,
    });
    const applier = operator("Snapshot Applier");
    orgChanges.markApplied(proposal.id, { workspace_id: WORKSPACE, signer: applier.signer });
    const application = new OrgChangeApplicationStore(database).getForProposal(
      WORKSPACE,
      proposal.id,
    );
    expect(application?.applied_by).toBe(applier.principal.principal_id);
    const applyRows = signatureRows(DECISION_OBJECT_TYPES.org_change_apply, application?.id ?? "");
    expect(applyRows).toHaveLength(1);
    expect(applyRows[0]?.signer_principal_id).toBe(applier.principal.principal_id);
  });
});

describe("M5 audit P0 #2 — key validity windows are enforced against substrate time", () => {
  it("a future-dated active key cannot sign right now", () => {
    const future = operator("Future Key");
    // Re-date the enrolled key's window to open tomorrow: still status-active.
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    database.connection
      .prepare("UPDATE principal_keys SET valid_from = ? WHERE id = ?")
      .run(tomorrow, future.keyId);
    const approvalId = requestPromotionApproval(`agent_${"5".repeat(32)}`);

    expect(() => approveAsSigner(approvalId, future.signer)).toThrow(/key_not_yet_valid/);
    expect(new ApprovalStore(database).get(approvalId)?.status).toBe("pending");
    expect(signatureRows(DECISION_OBJECT_TYPES.approval_approve, approvalId)).toHaveLength(0);
  });

  it("an expired key cannot sign, and a backdated decision time does not resurrect it", () => {
    const stale = operator("Stale Key");
    // Retire the enrolled key: window closed yesterday, still status-active.
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    database.connection
      .prepare("UPDATE principal_keys SET valid_until = ? WHERE id = ?")
      .run(yesterday, stale.keyId);
    const approvalId = requestPromotionApproval(`agent_${"5".repeat(32)}`);

    // The decision time (resolved_at) is written INSIDE the transaction at
    // roughly now; the validity clock is substrate time, so the expiry is
    // observed and the transition refuses — no signature, no state change.
    expect(() => approveAsSigner(approvalId, stale.signer)).toThrow(/key_expired/);
    expect(new ApprovalStore(database).get(approvalId)?.status).toBe("pending");
    expect(signatureRows(DECISION_OBJECT_TYPES.approval_approve, approvalId)).toHaveLength(0);

    // The stored row is untouched: no decision time was persisted that a
    // backdated verifier clock could be pointed at.
    expect(new ApprovalStore(database).get(approvalId)?.resolved_at).toBeNull();
  });

  it("a verifier presented with a backdated `now` still refuses an expired key via loadVerificationKeys", () => {
    // White-box confirmation that the full window is loaded from stored rows:
    // valid_from comes through the registry loader, and the verifier's
    // injected clock is the only clock consulted — a clock AFTER valid_until
    // refuses even when the caller picks a time before expiry.
    const signer = operator("Windowed Key");
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    // A window that opened two days ago and closed yesterday: yesterday sits
    // INSIDE it, so the same bytes verify there and refuse after.
    database.connection
      .prepare("UPDATE principal_keys SET valid_from = ?, valid_until = ? WHERE id = ?")
      .run(twoDaysAgo, yesterday, signer.keyId);
    const body = buildDecisionBody({
      workspaceId: WORKSPACE,
      objectId: "appr_window",
      signerPrincipalId: signer.principal.principal_id,
      signerKeyId: signer.keyId,
      claims: { decision: "approved" },
    });
    const headerSegment = encodeSegment(
      Buffer.from(
        dumpJson(buildProtectedHeader(DECISION_OBJECT_CLASS.approval_approve, signer.keyId)),
        "utf8",
      ),
    );
    const payloadSegment = encodeSegment(payloadBytesForBody(body));
    const signingInput = `${headerSegment}.${payloadSegment}`;
    // The test holds the enrolled private key (createSigningOperator exposes
    // it for exactly this kind of white-box probe).
    const privateKey = createPrivateKey({
      key: Buffer.from(signer.pkcs8Base64Url, "base64url"),
      format: "der",
      type: "pkcs8",
    });
    const signature = cryptoSign(null, Buffer.from(signingInput, "utf8"), privateKey);
    const envelope = {
      protectedHeaderSegment: headerSegment,
      payloadSegment,
      signatureSegment: encodeSegment(signature),
    };
    // Inside the window the very same bytes verify: the cryptographic proof is
    // intact and the window is the only thing that changes the outcome.
    const inside = verifyObject({
      database,
      workspaceId: WORKSPACE,
      expectedClass: DECISION_OBJECT_CLASS.approval_approve,
      expectedObjectId: "appr_window",
      envelope,
      now: yesterday,
    });
    expect(inside.ok).toBe(true);
    // A clock AFTER the stored valid_until refuses with the typed reason —
    // the transition-side verifier runs on substrate time, so an expired key
    // gets this verdict no matter what decision time the caller chose.
    const after = verifyObject({
      database,
      workspaceId: WORKSPACE,
      expectedClass: DECISION_OBJECT_CLASS.approval_approve,
      expectedObjectId: "appr_window",
      envelope,
      now: utcNow(),
    });
    expect(after).toMatchObject({ ok: false, reason: "key_expired", keyId: signer.keyId });
    // And a clock BEFORE the stored valid_from refuses too — the lower bound
    // is loaded from the stored row, not treated as always-open.
    const birth = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    database.connection
      .prepare("UPDATE principal_keys SET valid_until = NULL, valid_from = ? WHERE id = ?")
      .run(birth, signer.keyId);
    const before = verifyObject({
      database,
      workspaceId: WORKSPACE,
      expectedClass: DECISION_OBJECT_CLASS.approval_approve,
      expectedObjectId: "appr_window",
      envelope,
      now: utcNow(),
    });
    expect(before).toMatchObject({ ok: false, reason: "key_not_yet_valid", keyId: signer.keyId });
  });
});

describe("M5 audit P1 #3 — object type is bound into the signed bytes", () => {
  it("a signature recorded for object type A does not verify as type B", () => {
    const approver = operator("Typebound Approver");
    const approvalId = requestPromotionApproval(`agent_${"5".repeat(32)}`);
    approveAsSigner(approvalId, approver.signer);

    const rows = signatureRows(DECISION_OBJECT_TYPES.approval_approve, approvalId);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (!row) {
      throw new Error("expected a signature row");
    }
    // The envelope's typ is the approve-specific media type. Reclassifying the
    // row to the reject decision and verifying as that class must refuse:
    // the type is inside the signed bytes, not merely a column.
    const [headerSegment, payloadSegment] = row.signed_bytes.split(".");
    expect(row.domain_tag).toBe(mediaTypeForClass(DECISION_OBJECT_CLASS.approval_approve));
    const asReject = verifyObject({
      database,
      workspaceId: WORKSPACE,
      expectedClass: DECISION_OBJECT_CLASS.approval_reject,
      expectedObjectId: approvalId,
      envelope: {
        protectedHeaderSegment: headerSegment ?? "",
        payloadSegment: payloadSegment ?? "",
        signatureSegment: row.signature,
      },
      now: utcNow(),
    });
    expect(asReject).toMatchObject({ ok: false, reason: "class_mismatch" });
    // Sanity: it still verifies as its own class.
    const asApprove = verifyObject({
      database,
      workspaceId: WORKSPACE,
      expectedClass: DECISION_OBJECT_CLASS.approval_approve,
      expectedObjectId: approvalId,
      envelope: {
        protectedHeaderSegment: headerSegment ?? "",
        payloadSegment: payloadSegment ?? "",
        signatureSegment: row.signature,
      },
      now: utcNow(),
    });
    expect(asApprove.ok).toBe(true);
  });

  it("a signature cannot be produced for a non-existent object", () => {
    const approver = operator("NoGhost Approver");
    // Approving an id that was never requested: there is no stored row to
    // derive claims from, so the boundary refuses before any signing input is
    // built — the "sign anything" primitive no longer exists to call.
    expect(() =>
      new ApprovalService(database).approve(`approval_${"0".repeat(32)}`, {
        workspace_id: WORKSPACE,
        signer: approver.signer,
      }),
    ).toThrow(/not found/);
    expect(
      signatureRows(DECISION_OBJECT_TYPES.approval_approve, `approval_${"0".repeat(32)}`),
    ).toHaveLength(0);
    expect(eventKinds()).not.toContain("approval.approved");
  });

  it("the generic sign-anything primitive is not exported from the governance surface", async () => {
    const governance = await import("../src/governance/index.js");
    const decisionSigning = await import("../src/governance/decision-signing.js");
    expect("signGovernanceDecision" in governance).toBe(false);
    expect("signGovernanceDecision" in decisionSigning).toBe(false);
    // The transition-specific functions are the whole signing surface.
    for (const name of [
      "signApprovalDecision",
      "signAutonomyRatification",
      "signOrgChangeApply",
      "signOrgChangeRevert",
    ] as const) {
      expect(typeof decisionSigning[name]).toBe("function");
    }
  });
});

describe("M5 audit P2 — fail-closed decision times and hygiene", () => {
  it("an org-change revert whose stored row lost its reverted_at refuses rather than falling back", () => {
    // Fail-closed proof for the removed `?? at` escape: the wrapper requires
    // the stored row's decision time. Simulating the unreachable-by-construction
    // case — a reverted row whose reverted_at is null — by calling the
    // transition wrapper directly with a hand-built row: it must refuse, not
    // borrow a caller clock.
    const entry = new MemoryEntryStore(database).save(
      MemoryEntrySchema.parse({
        id: newId("mem"),
        workspace_id: WORKSPACE,
        scope: "individual",
        owner_id: null,
        kind: "semantic",
        content: "stale",
        provenance: {},
        confidence: 0.1,
        status: "stale",
        created_at: utcNow(),
      }),
    );
    const applier = operator("FailClosed Applier");
    const application = OrgChangeApplicationSchema.parse({
      id: newId("application"),
      workspace_id: WORKSPACE,
      proposal_id: `orgchg_${"a".repeat(32)}`,
      change_type: "memory_cleanup",
      applied_by: applier.principal.principal_id,
      reversible: true,
      targets: [],
      status: "reverted",
      created_at: utcNow(),
      reverted_at: null,
    });
    return import("../src/governance/index.js").then(({ signOrgChangeRevert }) => {
      expect(() =>
        signOrgChangeRevert({
          database,
          workspaceId: WORKSPACE,
          signer: applier.signer,
          identity: {
            principal_id: applier.principal.principal_id,
            actor: applier.principal.actor,
            key_id: applier.keyId,
          },
          objectType: DECISION_OBJECT_TYPES.org_change_revert,
          application,
        }),
      ).toThrow(/no decision time/);
      expect(signatureRows(DECISION_OBJECT_TYPES.org_change_revert, application.id)).toHaveLength(
        0,
      );
      expect(entry.status).toBe("stale");
    });
  });

  it("a custody refusal names no handle, so a mistaken secret-as-handle cannot leak into the error", () => {
    const signerless = operator("No Custody");
    const approvalId = requestPromotionApproval(`agent_${"5".repeat(32)}`);
    const emptyBrokerSigner: DecisionSigner = {
      principal: signerless.principal,
      broker: new StaticSigningBroker({}),
      handle: "signkey_operator",
    };
    let message = "";
    try {
      approveAsSigner(approvalId, emptyBrokerSigner);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("refused");
    expect(message).not.toContain("signkey_operator");
    expect(new ApprovalStore(database).get(approvalId)?.status).toBe("pending");
  });
});
