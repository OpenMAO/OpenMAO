import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AutonomyCaseSchema,
  type AutonomyLevel,
  newId,
  OrganizationSchema,
  OrgChangeApplicationSchema,
  OrgChangeProposalSchema,
  utcNow,
  WorkspaceSchema,
} from "../src/contracts/index.js";
import {
  AutonomyCapError,
  AutonomyRatificationError,
  AutonomyService,
  AutonomyServiceError,
  AutonomyStepError,
  InsufficientTrackRecordError,
  OrgChangeService,
} from "../src/org/index.js";
import {
  AutonomyCaseStore,
  Database,
  EventStore,
  OrganizationStore,
  OrgChangeApplicationStore,
  OrgChangeProposalStore,
  WorkspaceStore,
} from "../src/persistence/index.js";
import { createApprovalServiceWithApplications } from "../src/runtime/approvals.js";

const fixturePath = new URL("../../tests/fixtures/canonical_v0.json", import.meta.url);
const ORG_ID = `org_${"a".repeat(32)}`;

let tmpRoot: string;
let database: Database;

async function seedWorkspace(): Promise<string> {
  const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as Record<string, unknown>;
  return new WorkspaceStore(database).save(WorkspaceSchema.parse(fixture.workspace)).id;
}

function seedOrg(workspaceId: string, level: AutonomyLevel): void {
  new OrganizationStore(database).save(
    OrganizationSchema.parse({
      id: ORG_ID,
      workspace_id: workspaceId,
      name: "Org",
      mission: "Earn autonomy through a supervised track record.",
      autonomy_level: level,
    }),
  );
}

// The genuine, hard-to-forge track record: verified OrgChangeApplication records (each FK-bound to a
// real proposal), exactly what the service counts.
function seedVerifiedApplications(workspaceId: string, count: number): void {
  const proposals = new OrgChangeProposalStore(database);
  const applications = new OrgChangeApplicationStore(database);
  const at = utcNow();
  for (let index = 0; index < count; index += 1) {
    const proposalId = newId("orgchg");
    proposals.save(
      OrgChangeProposalSchema.parse({
        id: proposalId,
        workspace_id: workspaceId,
        proposed_by: "learning_service",
        change_type: "memory_cleanup",
        rationale: "Verified supervised apply.",
        created_at: at,
      }),
    );
    const application = applications.create(
      OrgChangeApplicationSchema.parse({
        id: newId("application"),
        workspace_id: workspaceId,
        proposal_id: proposalId,
        change_type: "memory_cleanup",
        applied_by: "operator",
        reversible: true,
        targets: [],
        status: "applied",
        created_at: at,
      }),
    );
    applications.setStatus(application.id, "verified", { verified_at: at });
  }
}

const evidence = [
  { kind: "event" as const, ref_id: newId("evt"), summary: "track record", weight: 1 },
];

function orgLevel(): AutonomyLevel {
  return new OrganizationStore(database).get(ORG_ID)?.autonomy_level ?? "advisory";
}

function eventKinds(workspaceId: string): string[] {
  return new EventStore(database).listForWorkspace(workspaceId).map((event) => event.kind);
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "openmao-ts-autonomy-"));
  database = new Database(join(tmpRoot, "openmao.sqlite3"));
  database.initialize();
});

afterEach(() => {
  database.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("M4 earned autonomy", () => {
  it("widens one step only via a human-ratified, evidence-backed case", async () => {
    const workspaceId = await seedWorkspace();
    seedOrg(workspaceId, "advisory");
    seedVerifiedApplications(workspaceId, 1);
    const service = new AutonomyService(database, { minTrackRecord: 1 });

    const proposed = service.proposeWidening({
      workspace_id: workspaceId,
      org_id: ORG_ID,
      proposed_by: "learning_service",
      rationale: "A clean supervised track record.",
      evidence,
    });

    // Proposing NEVER moves the dial.
    expect(proposed.proposed_level).toBe("supervised");
    expect(orgLevel()).toBe("advisory");

    const ratified = service.ratifyWidening(proposed.id, {
      workspace_id: workspaceId,
      actor: "operator",
    });

    expect(ratified.status).toBe("ratified");
    expect(ratified.ratified_by).toBe("operator");
    expect(orgLevel()).toBe("supervised");
    expect(eventKinds(workspaceId)).toEqual(
      expect.arrayContaining(["autonomy.widening_proposed", "autonomy.widened"]),
    );
  });

  it("refuses to widen without an audited track record", async () => {
    const workspaceId = await seedWorkspace();
    seedOrg(workspaceId, "advisory");
    expect(() =>
      new AutonomyService(database, { minTrackRecord: 3 }).proposeWidening({
        workspace_id: workspaceId,
        org_id: ORG_ID,
        proposed_by: "learning_service",
        rationale: "Premature.",
        evidence,
      }),
    ).toThrow(InsufficientTrackRecordError);
    expect(orgLevel()).toBe("advisory");
  });

  it("excludes acknowledged (applier-less) org changes from the autonomy track record", async () => {
    const workspaceId = await seedWorkspace();
    seedOrg(workspaceId, "advisory");
    seedVerifiedApplications(workspaceId, 2);

    // An acknowledged outcome produced through the real service path: an approved `policy` change
    // (no registered applier) is recorded as `acknowledged` (#105) — it creates no
    // OrgChangeApplication row, so it can never inflate the audited track record.
    const orgChanges = new OrgChangeService(database);
    const { proposal, approval_id } = orgChanges.propose({
      id: newId("orgchg"),
      workspace_id: workspaceId,
      proposed_by: "learning_service",
      change_type: "policy",
      rationale: "Tighten the review policy.",
      evidence: [
        { kind: "approval", ref_id: `approval_${"0".repeat(32)}`, summary: "queue", weight: 1 },
      ],
      patch_json: { recommendation: "Review the approval policy." },
    });
    createApprovalServiceWithApplications(database).approve(approval_id, {
      workspace_id: workspaceId,
      actor: "human",
    });
    const acknowledged = orgChanges.markApplied(proposal.id, {
      workspace_id: workspaceId,
      actor: "operator",
    });
    expect(acknowledged.status).toBe("acknowledged");

    // 2 verified + 1 acknowledged is still a track record of 2: the widening is refused.
    const service = new AutonomyService(database, { minTrackRecord: 3 });
    expect(() =>
      service.proposeWidening({
        workspace_id: workspaceId,
        org_id: ORG_ID,
        proposed_by: "learning_service",
        rationale: "Counting recommendations as applies.",
        evidence,
      }),
    ).toThrow(InsufficientTrackRecordError);

    // Only a real, verified apply moves the count.
    seedVerifiedApplications(workspaceId, 1);
    const proposed = service.proposeWidening({
      workspace_id: workspaceId,
      org_id: ORG_ID,
      proposed_by: "learning_service",
      rationale: "Three genuinely verified applies.",
      evidence,
    });
    expect(proposed.proposed_level).toBe("supervised");
  });

  it("refuses to widen without an evidence packet", async () => {
    const workspaceId = await seedWorkspace();
    seedOrg(workspaceId, "advisory");
    seedVerifiedApplications(workspaceId, 5);
    expect(() =>
      new AutonomyService(database, { minTrackRecord: 1 }).proposeWidening({
        workspace_id: workspaceId,
        org_id: ORG_ID,
        proposed_by: "learning_service",
        rationale: "No evidence.",
        evidence: [],
      }),
    ).toThrow(InsufficientTrackRecordError);
  });

  it("refuses to widen beyond the configured ceiling", async () => {
    const workspaceId = await seedWorkspace();
    seedOrg(workspaceId, "advisory");
    seedVerifiedApplications(workspaceId, 5);
    expect(() =>
      new AutonomyService(database, { minTrackRecord: 1, maxLevel: "advisory" }).proposeWidening({
        workspace_id: workspaceId,
        org_id: ORG_ID,
        proposed_by: "learning_service",
        rationale: "Over the cap.",
        evidence,
      }),
    ).toThrow(AutonomyCapError);
  });

  it("refuses to widen past the top of the ladder", async () => {
    const workspaceId = await seedWorkspace();
    seedOrg(workspaceId, "bounded");
    seedVerifiedApplications(workspaceId, 5);
    expect(() =>
      new AutonomyService(database, { minTrackRecord: 1 }).proposeWidening({
        workspace_id: workspaceId,
        org_id: ORG_ID,
        proposed_by: "learning_service",
        rationale: "Already widest.",
        evidence,
      }),
    ).toThrow(AutonomyStepError);
  });

  it("refuses self-ratification (proposer ≠ ratifier, normalized)", async () => {
    const workspaceId = await seedWorkspace();
    seedOrg(workspaceId, "advisory");
    seedVerifiedApplications(workspaceId, 1);
    const service = new AutonomyService(database, { minTrackRecord: 1 });
    const proposed = service.proposeWidening({
      workspace_id: workspaceId,
      org_id: ORG_ID,
      proposed_by: "agent_scribe",
      rationale: "Self-serving.",
      evidence,
    });

    // Padded/whitespace variants of the proposer must not slip past the separation check.
    expect(() =>
      service.ratifyWidening(proposed.id, { workspace_id: workspaceId, actor: "  agent_scribe  " }),
    ).toThrow(AutonomyRatificationError);
    expect(orgLevel()).toBe("advisory");
  });

  it("rejects a blank ratifier identity", async () => {
    const workspaceId = await seedWorkspace();
    seedOrg(workspaceId, "advisory");
    seedVerifiedApplications(workspaceId, 1);
    const service = new AutonomyService(database, { minTrackRecord: 1 });
    const proposed = service.proposeWidening({
      workspace_id: workspaceId,
      org_id: ORG_ID,
      proposed_by: "learning_service",
      rationale: "Blank ratifier.",
      evidence,
    });
    expect(() =>
      service.ratifyWidening(proposed.id, { workspace_id: workspaceId, actor: "   " }),
    ).toThrow(AutonomyRatificationError);
  });

  it("re-validates at ratify: a forged skip-level case cannot land the widening", async () => {
    const workspaceId = await seedWorkspace();
    seedOrg(workspaceId, "advisory");
    seedVerifiedApplications(workspaceId, 5);
    // Forge a case straight into the store that skips advisory → bounded.
    const forged = new AutonomyCaseStore(database).save(
      AutonomyCaseSchema.parse({
        id: newId("autonomy"),
        workspace_id: workspaceId,
        org_id: ORG_ID,
        current_level: "advisory",
        proposed_level: "bounded",
        evidence,
        rationale: "Forged skip.",
        status: "proposed",
        proposed_by: "attacker",
        created_at: utcNow(),
      }),
    );

    expect(() =>
      new AutonomyService(database, { minTrackRecord: 1 }).ratifyWidening(forged.id, {
        workspace_id: workspaceId,
        actor: "operator",
      }),
    ).toThrow(AutonomyStepError);
    expect(orgLevel()).toBe("advisory");
  });

  it("re-checks the ceiling at ratify (cap tightened after the case was made)", async () => {
    const workspaceId = await seedWorkspace();
    seedOrg(workspaceId, "advisory");
    seedVerifiedApplications(workspaceId, 1);
    const proposed = new AutonomyService(database, { minTrackRecord: 1 }).proposeWidening({
      workspace_id: workspaceId,
      org_id: ORG_ID,
      proposed_by: "learning_service",
      rationale: "Cap will tighten.",
      evidence,
    });

    // A stricter policy ratifies — the ceiling is re-enforced against the live request.
    expect(() =>
      new AutonomyService(database, { minTrackRecord: 1, maxLevel: "advisory" }).ratifyWidening(
        proposed.id,
        { workspace_id: workspaceId, actor: "operator" },
      ),
    ).toThrow(AutonomyCapError);
    expect(orgLevel()).toBe("advisory");
  });

  it("re-checks the track record at ratify (threshold raised after the case was made)", async () => {
    const workspaceId = await seedWorkspace();
    seedOrg(workspaceId, "advisory");
    seedVerifiedApplications(workspaceId, 1);
    const proposed = new AutonomyService(database, { minTrackRecord: 1 }).proposeWidening({
      workspace_id: workspaceId,
      org_id: ORG_ID,
      proposed_by: "learning_service",
      rationale: "Threshold will rise.",
      evidence,
    });

    expect(() =>
      new AutonomyService(database, { minTrackRecord: 5 }).ratifyWidening(proposed.id, {
        workspace_id: workspaceId,
        actor: "operator",
      }),
    ).toThrow(InsufficientTrackRecordError);
    expect(orgLevel()).toBe("advisory");
  });

  it("rejects a duplicate pending widening for the same org/step", async () => {
    const workspaceId = await seedWorkspace();
    seedOrg(workspaceId, "advisory");
    seedVerifiedApplications(workspaceId, 1);
    const service = new AutonomyService(database, { minTrackRecord: 1 });
    service.proposeWidening({
      workspace_id: workspaceId,
      org_id: ORG_ID,
      proposed_by: "learning_service",
      rationale: "First.",
      evidence,
    });
    expect(() =>
      service.proposeWidening({
        workspace_id: workspaceId,
        org_id: ORG_ID,
        proposed_by: "learning_service",
        rationale: "Duplicate.",
        evidence,
      }),
    ).toThrow(AutonomyServiceError);
  });

  it("refuses to ratify a stale case after the dial moved", async () => {
    const workspaceId = await seedWorkspace();
    seedOrg(workspaceId, "supervised");
    seedVerifiedApplications(workspaceId, 1);
    const service = new AutonomyService(database, { minTrackRecord: 1 });
    const proposed = service.proposeWidening({
      workspace_id: workspaceId,
      org_id: ORG_ID,
      proposed_by: "learning_service",
      rationale: "Will drift.",
      evidence,
    });

    // The dial moves out from under the case — an operator narrows it (the safe, case-free path).
    service.narrow({
      workspace_id: workspaceId,
      org_id: ORG_ID,
      to_level: "advisory",
      actor: "operator",
    });

    // The case proposed supervised → bounded, but the only valid widening from the live level
    // (advisory) is → supervised, so ratification is rejected.
    expect(() =>
      service.ratifyWidening(proposed.id, { workspace_id: workspaceId, actor: "operator" }),
    ).toThrow(AutonomyServiceError);
  });

  it("widening is unreachable at the store layer without a ratified case", async () => {
    const workspaceId = await seedWorkspace();
    seedOrg(workspaceId, "advisory");
    // A direct one-step widen on the store CAS, with no ratified case, is refused.
    expect(() =>
      new OrganizationStore(database).setAutonomyLevel(ORG_ID, {
        workspace_id: workspaceId,
        expected_level: "advisory",
        next_level: "supervised",
      }),
    ).toThrow();
    expect(orgLevel()).toBe("advisory");
  });

  it("narrows (tightens) without a case — the safe direction", async () => {
    const workspaceId = await seedWorkspace();
    seedOrg(workspaceId, "bounded");

    const updated = new AutonomyService(database).narrow({
      workspace_id: workspaceId,
      org_id: ORG_ID,
      to_level: "advisory",
      actor: "operator",
      at: utcNow(),
    });

    expect(updated.autonomy_level).toBe("advisory");
    expect(eventKinds(workspaceId)).toContain("autonomy.narrowed");
  });
});
