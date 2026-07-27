import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CapabilityRegistryService,
  MockProvider,
  MockSideEffectProvider,
} from "../src/capabilities/index.js";
import {
  type Capability,
  type CapabilityCall,
  CapabilityCallSchema,
  CapabilitySchema,
  formatUtc,
  type Run,
  RunSchema,
  TaskEnvelopeSchema,
  WorkerIdentitySchema,
  WorkItemSchema,
  WorkspaceSchema,
} from "../src/contracts/index.js";
import { ApprovalService, GovernanceService, NarrowingService } from "../src/governance/index.js";
import { OrgRegistry } from "../src/org/index.js";
import {
  CapabilityStore,
  Database,
  EventStore,
  GrantSuspensionStore,
  RunStore,
  TaskEnvelopeStore,
  WorkerIdentityStore,
  WorkItemStore,
  WorkspaceStore,
} from "../src/persistence/index.js";
import { createSigningOperator } from "./helpers/principals.js";

const fixturePath = new URL("../../tests/fixtures/canonical_v0.json", import.meta.url);

const WORKSPACE = "ws_11111111111111111111111111111111";
const RESEARCHER = "agent_66666666666666666666666666666666";
const SECOND_RESEARCHER = "agent_77777777777777777777777777777777";
const WORKER = "worker_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const RESEARCH_CAPABILITY = "mock.research_lookup";
const UNGRANTED_CAPABILITY = "mock.ungranted_lookup";
const SIDE_EFFECT_CAPABILITY = "mock.side_effect.record";

let tmpRoot: string;
let database: Database;
let counter: number;

async function loadFixture(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(fixturePath, "utf8")) as Record<string, unknown>;
}

function hexId(prefix: string): string {
  counter += 1;
  return `${prefix}_${counter.toString(16).padStart(32, "0")}`;
}

async function orgRegistry(extraAgents: unknown[] = []): Promise<OrgRegistry> {
  const fixture = await loadFixture();
  return new OrgRegistry({
    roles: fixture.roles as unknown[],
    agents: [...(fixture.agents as unknown[]), ...extraAgents],
  });
}

async function seedBase(): Promise<void> {
  const fixture = await loadFixture();
  new WorkspaceStore(database).save(WorkspaceSchema.parse(fixture.workspace));
  new WorkItemStore(database).save(WorkItemSchema.parse(fixture.work_item));
}

async function startRun(taskInput: {
  to_agent: string;
  allowed_capabilities: string[];
}): Promise<{ run: Run; taskId: string }> {
  const fixture = await loadFixture();
  const fixtureRun = RunSchema.parse(fixture.run);
  const runId = hexId("run");
  const store = new RunStore(database);
  store.create(
    RunSchema.parse({
      ...fixtureRun,
      id: runId,
      status: "queued",
      active_node: null,
      suspended_approval_id: null,
      updated_at: fixtureRun.created_at,
    }),
  );
  const running = store.setStatus(runId, "running", { active_node: "run_started" });
  const taskId = hexId("task");
  new TaskEnvelopeStore(database).save(
    TaskEnvelopeSchema.parse({
      ...(fixture.task_envelope as Record<string, unknown>),
      id: taskId,
      run_id: runId,
      to_agent: taskInput.to_agent,
      allowed_capabilities: taskInput.allowed_capabilities,
    }),
  );
  return { run: running, taskId };
}

async function registerResearchCapability(
  permission: "enabled" | "approval_required",
): Promise<Capability> {
  const fixture = await loadFixture();
  const capability = CapabilitySchema.parse({
    ...(fixture.capability as Record<string, unknown>),
    default_permission: permission,
  });
  new CapabilityStore(database).save(capability);
  return capability;
}

function registerUngrantedCapability(): Capability {
  const capability = CapabilitySchema.parse({
    name: UNGRANTED_CAPABILITY,
    workspace_id: WORKSPACE,
    description: "Capability no role grants; calls produce policy.decision blocks.",
    tool_name: "mock.research",
    canonical_input_schema: {
      type: "object",
      required: ["query"],
      properties: { query: { type: "string" } },
    },
    canonical_output_schema: {
      type: "object",
      required: ["findings"],
      properties: { findings: { type: "array", items: { type: "string" } } },
    },
    providers: ["mock"],
    default_permission: "enabled",
  });
  new CapabilityStore(database).save(capability);
  return capability;
}

function registerSideEffectCapability(): Capability {
  const capability = CapabilitySchema.parse({
    name: SIDE_EFFECT_CAPABILITY,
    workspace_id: WORKSPACE,
    description: "Record a deterministic side effect through an OpenMAO-managed provider.",
    tool_name: "mock.side_effect",
    canonical_input_schema: {
      type: "object",
      required: ["message"],
      properties: { message: { type: "string" } },
    },
    canonical_output_schema: {
      type: "object",
      required: ["provider", "effect", "handle"],
      properties: {
        provider: { type: "string" },
        effect: { type: "string" },
        handle: { type: "string" },
      },
    },
    providers: ["mock.side_effect"],
    side_effecting: true,
    credential_handle_required: true,
    credential_handle: "cred_mock_side_effect",
    default_permission: "approval_required",
  });
  new CapabilityStore(database).save(capability);
  return capability;
}

function seedWorker(): void {
  new WorkerIdentityStore(database).save(
    WorkerIdentitySchema.parse({
      id: WORKER,
      workspace_id: WORKSPACE,
      name: "Governed Worker",
      runtime: "openmao.test.worker",
      allowed_capabilities: [SIDE_EFFECT_CAPABILITY],
    }),
  );
}

function agentCall(
  run: Run,
  taskId: string,
  updates: Record<string, unknown> = {},
): CapabilityCall {
  return CapabilityCallSchema.parse({
    id: hexId("capcall"),
    workspace_id: run.workspace_id,
    run_id: run.id,
    capability_name: RESEARCH_CAPABILITY,
    provider: "mock",
    input: { query: "onboarding brief" },
    requested_by: RESEARCHER,
    task_id: taskId,
    risk_level: "low",
    idempotency_key: hexId("key"),
    ...updates,
  });
}

function workerCall(run: Run, taskId: string): CapabilityCall {
  return CapabilityCallSchema.parse({
    id: hexId("capcall"),
    workspace_id: run.workspace_id,
    run_id: run.id,
    capability_name: SIDE_EFFECT_CAPABILITY,
    provider: "mock.side_effect",
    input: { message: "record governed side effect" },
    requested_by: WORKER,
    external_actor: { actor_type: "worker", actor_id: WORKER, display_name: "Governed Worker" },
    task_id: taskId,
    credential_handle: "cred_mock_side_effect",
    side_effecting: true,
    audit_payload: { intent: "narrowing worker gate" },
    risk_level: "high",
    idempotency_key: hexId("key"),
  });
}

async function makeRegistry(): Promise<CapabilityRegistryService> {
  return new CapabilityRegistryService(
    database,
    new GovernanceService(database, await orgRegistry()),
    [new MockProvider(), new MockSideEffectProvider({ cred_mock_side_effect: "test_secret" })],
  );
}

// Drives the REAL approval pipeline up to a pending approval: run + task envelope +
// registry invoke (require_approval). Returns the approval id awaiting a human.
async function requestAgentApproval(registry: CapabilityRegistryService): Promise<string> {
  const { run, taskId } = await startRun({
    to_agent: RESEARCHER,
    allowed_capabilities: [RESEARCH_CAPABILITY],
  });
  const invocation = await registry.invoke(agentCall(run, taskId));
  expect(invocation.decision.outcome).toBe("require_approval");
  return invocation.approval_id ?? "";
}

// Human rejection of a pending approval. Returns the approval.rejected event id.
function rejectApproval(approvalId: string): string {
  new ApprovalService(database).reject(approvalId, {
    workspace_id: WORKSPACE,
    signer: createSigningOperator(database, WORKSPACE, "Test Operator").signer,
  });
  const rejected = new EventStore(database).getByIdempotencyKey(
    WORKSPACE,
    `${approvalId}:rejected`,
  );
  if (!rejected) {
    throw new Error("approval.rejected event not found");
  }
  return rejected.id;
}

async function driveRejectedAgentCall(registry: CapabilityRegistryService): Promise<string> {
  return rejectApproval(await requestAgentApproval(registry));
}

// Drives the REAL policy-violation pipeline once: a registry invoke the governance layer
// blocks (role lacks the grant), recorded as a policy.decision event. Returns its event id.
async function driveBlockedAgentCall(
  registry: CapabilityRegistryService,
  run: Run,
  taskId: string,
): Promise<string> {
  const call = agentCall(run, taskId, { capability_name: UNGRANTED_CAPABILITY });
  const invocation = await registry.invoke(call);
  expect(invocation.decision.outcome).toBe("block");
  expect(invocation.decision.reason).toContain("lacks capability grant");
  const event = new EventStore(database).getByIdempotencyKey(
    run.workspace_id,
    `${call.id}:policy_decision`,
  );
  if (!event) {
    throw new Error("policy.decision event not found");
  }
  return event.id;
}

function ratify(
  overrides: Partial<{
    rejection_threshold: number;
    violation_threshold: number;
    window_seconds: number;
    cooldown_seconds: number;
    ratified_by: string;
  }> = {},
) {
  return new NarrowingService(database).ratifyPolicy({
    workspace_id: WORKSPACE,
    ratified_by: "operator:test",
    rejection_threshold: 2,
    violation_threshold: 100,
    window_seconds: 3600,
    cooldown_seconds: 0,
    ...overrides,
  });
}

function eventKinds(): string[] {
  return new EventStore(database).listForWorkspace(WORKSPACE).map((event) => event.kind);
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "openmao-ts-narrowing-"));
  database = new Database(join(tmpRoot, "openmao.sqlite3"));
  database.initialize();
  counter = 0;
});

afterEach(() => {
  database.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("asymmetric autonomy narrowing", () => {
  it("does nothing on scan when no policy was ratified", async () => {
    await seedBase();
    await registerResearchCapability("approval_required");
    const registry = await makeRegistry();
    await driveRejectedAgentCall(registry);

    const result = new NarrowingService(database).scan({ workspace_id: WORKSPACE });

    expect(result.policy).toBeNull();
    expect(result.suspensions).toEqual([]);
    expect(new GrantSuspensionStore(database).listForWorkspace(WORKSPACE)).toEqual([]);
    expect(eventKinds()).not.toContain("autonomy.grant_suspended");
  });

  it("requires a non-blank operator to ratify and events the ratification", async () => {
    await seedBase();
    const narrowing = new NarrowingService(database);

    expect(() => ratify({ ratified_by: "   " })).toThrowError(/non-blank operator/);

    const policy = ratify({ cooldown_seconds: 60 });
    expect(policy.rejection_threshold).toBe(2);
    expect(narrowing.scan({ workspace_id: WORKSPACE }).policy).toEqual(policy);
    expect(eventKinds()).toContain("autonomy.narrowing_policy_ratified");
  });

  it("suspends on repeated rejections at exactly the ratified threshold, carrying the evidence", async () => {
    await seedBase();
    await registerResearchCapability("approval_required");
    const registry = await makeRegistry();
    const narrowing = new NarrowingService(database);
    ratify({ rejection_threshold: 2 });

    const firstEvidence = await driveRejectedAgentCall(registry);
    expect(narrowing.scan({ workspace_id: WORKSPACE }).suspensions).toEqual([]);

    const secondEvidence = await driveRejectedAgentCall(registry);
    const result = narrowing.scan({ workspace_id: WORKSPACE });

    expect(result.suspensions).toHaveLength(1);
    const suspension = result.suspensions[0];
    expect(suspension?.status).toBe("active");
    expect(suspension?.trigger).toBe("repeated_rejections");
    expect(suspension?.actor_id).toBe(RESEARCHER);
    expect(suspension?.capability_name).toBe(RESEARCH_CAPABILITY);
    expect(suspension?.evidence_refs).toEqual([firstEvidence, secondEvidence]);

    const suspendedEvent = new EventStore(database).getByIdempotencyKey(
      WORKSPACE,
      `${suspension?.id}:suspended`,
    );
    expect(suspendedEvent?.kind).toBe("autonomy.grant_suspended");
    expect(suspendedEvent?.payload.refs).toEqual([firstEvidence, secondEvidence]);
    expect(suspendedEvent?.hash).not.toBeNull();
  });

  it("ignores rejections that fall outside the ratified window", async () => {
    await seedBase();
    await registerResearchCapability("approval_required");
    const registry = await makeRegistry();
    const narrowing = new NarrowingService(database);
    ratify({ rejection_threshold: 2, window_seconds: 3600 });

    await driveRejectedAgentCall(registry);
    await driveRejectedAgentCall(registry);
    const later = formatUtc(Date.now() + 2 * 3600 * 1000);

    expect(narrowing.scan({ workspace_id: WORKSPACE, now: later }).suspensions).toEqual([]);
    expect(new GrantSuspensionStore(database).listForWorkspace(WORKSPACE)).toEqual([]);
  });

  it("suspends on policy violations at exactly the ratified threshold, carrying the evidence", async () => {
    await seedBase();
    registerUngrantedCapability();
    const registry = await makeRegistry();
    const narrowing = new NarrowingService(database);
    ratify({ rejection_threshold: 100, violation_threshold: 2 });

    const { run, taskId } = await startRun({
      to_agent: RESEARCHER,
      allowed_capabilities: [UNGRANTED_CAPABILITY],
    });
    const firstEvidence = await driveBlockedAgentCall(registry, run, taskId);
    expect(narrowing.scan({ workspace_id: WORKSPACE }).suspensions).toEqual([]);

    const secondEvidence = await driveBlockedAgentCall(registry, run, taskId);
    const result = narrowing.scan({ workspace_id: WORKSPACE });

    expect(result.suspensions).toHaveLength(1);
    const suspension = result.suspensions[0];
    expect(suspension?.trigger).toBe("policy_violations");
    expect(suspension?.actor_id).toBe(RESEARCHER);
    expect(suspension?.capability_name).toBe(UNGRANTED_CAPABILITY);
    expect(suspension?.evidence_refs).toEqual([firstEvidence, secondEvidence]);
  });

  it("blocks a suspended grant at decide time in the same cycle, without touching other actors or capabilities", async () => {
    await seedBase();
    const capability = await registerResearchCapability("approval_required");
    // Constructed BEFORE any suspension exists: a bind-time or cached read would miss it.
    const registry = await makeRegistry();
    const narrowing = new NarrowingService(database);
    ratify({ rejection_threshold: 2 });
    await driveRejectedAgentCall(registry);
    await driveRejectedAgentCall(registry);
    const suspension = narrowing.scan({ workspace_id: WORKSPACE }).suspensions[0];
    if (!suspension) {
      throw new Error("expected an active suspension");
    }

    const { run, taskId } = await startRun({
      to_agent: RESEARCHER,
      allowed_capabilities: [RESEARCH_CAPABILITY],
    });
    const blocked = await registry.invoke(agentCall(run, taskId));

    expect(blocked.decision.outcome).toBe("block");
    expect(blocked.decision.reason).toBe(
      `Capability grant is suspended: ${RESEARCH_CAPABILITY} (suspension ${suspension.id})`,
    );
    expect(blocked.result?.status).toBe("blocked");
    expect(blocked.approval_id).toBeUndefined();

    // The same gate, hit directly at GovernanceService.decideCapability.
    const fixture = await loadFixture();
    const researcherRoleId = (fixture.roles as Array<{ id: string; name: string }>).find(
      (role) => role.name === "researcher",
    )?.id;
    const governance = new GovernanceService(
      database,
      await orgRegistry([
        {
          id: SECOND_RESEARCHER,
          workspace_id: WORKSPACE,
          role_id: researcherRoleId,
          identity: "Second Research Agent",
          model_binding: "mock",
          status: "idle",
        },
      ]),
    );
    expect(governance.decideCapability(agentCall(run, taskId), capability).outcome).toBe("block");

    // Actor scoping: the same grant for a DIFFERENT actor is untouched.
    const otherActor = governance.decideCapability(
      agentCall(run, taskId, { requested_by: SECOND_RESEARCHER }),
      capability,
    );
    expect(otherActor.outcome).toBe("require_approval");

    // Capability scoping: a different grant for the SAME actor is untouched.
    const memoryWrite = CapabilitySchema.parse({
      name: "memory.write",
      workspace_id: WORKSPACE,
      description: "Write a memory entry.",
      canonical_input_schema: { type: "object", required: [], properties: {} },
      canonical_output_schema: { type: "object", required: [], properties: {} },
      default_permission: "enabled",
    });
    const otherCapability = governance.decideCapability(
      agentCall(run, taskId, { capability_name: "memory.write" }),
      memoryWrite,
    );
    expect(otherCapability.outcome).not.toBe("block");
  });

  it("blocks a suspended worker grant at decide time on the worker path", async () => {
    await seedBase();
    registerSideEffectCapability();
    seedWorker();
    const registry = await makeRegistry();
    const narrowing = new NarrowingService(database);
    ratify({ rejection_threshold: 1 });

    const first = await startRun({
      to_agent: WORKER,
      allowed_capabilities: [SIDE_EFFECT_CAPABILITY],
    });
    const invocation = await registry.invoke(workerCall(first.run, first.taskId));
    expect(invocation.decision.outcome).toBe("require_approval");
    new ApprovalService(database).reject(invocation.approval_id ?? "", {
      workspace_id: WORKSPACE,
      signer: createSigningOperator(database, WORKSPACE, "Test Operator").signer,
    });
    const suspension = narrowing.scan({ workspace_id: WORKSPACE }).suspensions[0];
    expect(suspension?.actor_id).toBe(WORKER);
    expect(suspension?.capability_name).toBe(SIDE_EFFECT_CAPABILITY);

    const second = await startRun({
      to_agent: WORKER,
      allowed_capabilities: [SIDE_EFFECT_CAPABILITY],
    });
    const blocked = await registry.invoke(workerCall(second.run, second.taskId));

    expect(blocked.decision.outcome).toBe("block");
    expect(blocked.decision.reason).toBe(
      `Capability grant is suspended: ${SIDE_EFFECT_CAPABILITY} (suspension ${suspension?.id})`,
    );
    expect(blocked.result?.status).toBe("blocked");
  });

  it("refuses to lift before the cooldown elapses", async () => {
    await seedBase();
    await registerResearchCapability("approval_required");
    const registry = await makeRegistry();
    const narrowing = new NarrowingService(database);
    ratify({ rejection_threshold: 1, cooldown_seconds: 3600 });
    await driveRejectedAgentCall(registry);
    const suspension = narrowing.scan({ workspace_id: WORKSPACE }).suspensions[0];
    if (!suspension) {
      throw new Error("expected an active suspension");
    }

    expect(() =>
      narrowing.lift(suspension.id, { actor: "operator:test", note: "too early" }),
    ).toThrowError(/cooldown has not elapsed/);
    expect(new GrantSuspensionStore(database).get(suspension.id)?.status).toBe("active");
    expect(eventKinds()).not.toContain("autonomy.grant_lifted");
  });

  it("lifts after the cooldown with operator evidence, idempotently, and re-opens the gate", async () => {
    await seedBase();
    await registerResearchCapability("approval_required");
    const registry = await makeRegistry();
    const narrowing = new NarrowingService(database);
    ratify({ rejection_threshold: 1, cooldown_seconds: 60 });
    await driveRejectedAgentCall(registry);
    const suspension = narrowing.scan({ workspace_id: WORKSPACE }).suspensions[0];
    if (!suspension) {
      throw new Error("expected an active suspension");
    }
    const afterCooldown = formatUtc(Date.parse(suspension.cooldown_until) + 1000);

    expect(() =>
      narrowing.lift(suspension.id, { actor: "  ", note: "blank actor", now: afterCooldown }),
    ).toThrowError(/non-blank operator/);

    const lifted = narrowing.lift(suspension.id, {
      actor: "operator:test",
      note: "root cause fixed; re-enabling",
      now: afterCooldown,
    });
    expect(lifted.status).toBe("lifted");
    expect(lifted.lifted_by).toBe("operator:test");
    expect(lifted.lift_note).toBe("root cause fixed; re-enabling");
    expect(lifted.lifted_at).toBe(afterCooldown);

    const replayed = narrowing.lift(suspension.id, {
      actor: "operator:other",
      note: "replay",
      now: afterCooldown,
    });
    expect(replayed).toEqual(lifted);
    expect(eventKinds().filter((kind) => kind === "autonomy.grant_lifted")).toHaveLength(1);

    // The lift is human ratification of this exact evidence: rescanning the same window
    // does not re-suspend (hysteresis), and the gate is open again for new calls.
    expect(narrowing.scan({ workspace_id: WORKSPACE }).suspensions).toEqual([]);
    const { run, taskId } = await startRun({
      to_agent: RESEARCHER,
      allowed_capabilities: [RESEARCH_CAPABILITY],
    });
    const reopened = await registry.invoke(agentCall(run, taskId));
    expect(reopened.decision.outcome).toBe("require_approval");
  });

  it("does not duplicate an active suspension on scan replay or on new evidence", async () => {
    await seedBase();
    await registerResearchCapability("approval_required");
    const registry = await makeRegistry();
    const narrowing = new NarrowingService(database);
    ratify({ rejection_threshold: 2 });
    await driveRejectedAgentCall(registry);
    await driveRejectedAgentCall(registry);
    // A third call goes pending BEFORE the suspension exists (the gate would block it after).
    const pendingApproval = await requestAgentApproval(registry);

    expect(narrowing.scan({ workspace_id: WORKSPACE }).suspensions).toHaveLength(1);
    expect(narrowing.scan({ workspace_id: WORKSPACE }).suspensions).toEqual([]);

    // Rejecting the pre-suspension pending approval adds NEW evidence while the suspension
    // is active; the windowed evidence set changes but no duplicate may be created.
    rejectApproval(pendingApproval);
    expect(narrowing.scan({ workspace_id: WORKSPACE }).suspensions).toEqual([]);

    const all = new GrantSuspensionStore(database).listForWorkspace(WORKSPACE);
    expect(all).toHaveLength(1);
    expect(all[0]?.status).toBe("active");
    expect(eventKinds().filter((kind) => kind === "autonomy.grant_suspended")).toHaveLength(1);
  });

  it("blocks an approved call at resume when its grant was suspended after the approval went pending", async () => {
    await seedBase();
    await registerResearchCapability("approval_required");
    const provider = new MockProvider();
    const registry = new CapabilityRegistryService(
      database,
      new GovernanceService(database, await orgRegistry()),
      [provider, new MockSideEffectProvider({ cred_mock_side_effect: "test_secret" })],
    );
    const narrowing = new NarrowingService(database);
    ratify({ rejection_threshold: 2 });

    await driveRejectedAgentCall(registry);
    await driveRejectedAgentCall(registry);
    // A third call goes pending BEFORE any suspension exists; its approval is the resume target.
    const pendingApproval = await requestAgentApproval(registry);
    const suspension = narrowing.scan({ workspace_id: WORKSPACE }).suspensions[0];
    if (!suspension) {
      throw new Error("expected an active suspension");
    }

    // A human explicitly APPROVES the call after the suspension — narrowing is reversible only by
    // a ratified lift, so resume must still block and must never execute the provider.
    new ApprovalService(database).approve(pendingApproval, {
      workspace_id: WORKSPACE,
      signer: createSigningOperator(database, WORKSPACE, "Test Operator").signer,
    });
    const resumed = await registry.resumeApprovedCall(pendingApproval, { workspace_id: WORKSPACE });

    expect(resumed.result?.status).toBe("blocked");
    expect(resumed.result?.error).toBe(
      `Capability grant is suspended: ${RESEARCH_CAPABILITY} (suspension ${suspension.id})`,
    );
    expect(provider.executedCallIds).toEqual([]);
    expect(eventKinds()).not.toContain("capability.completed");
  });

  it("blocks an approved worker call at resume when its grant was suspended after approval", async () => {
    await seedBase();
    registerSideEffectCapability();
    seedWorker();
    const provider = new MockSideEffectProvider({ cred_mock_side_effect: "test_secret" });
    const registry = new CapabilityRegistryService(
      database,
      new GovernanceService(database, await orgRegistry()),
      [new MockProvider(), provider],
    );
    const narrowing = new NarrowingService(database);
    ratify({ rejection_threshold: 1 });

    // Rejection evidence first: this worker run is failed by the rejection (releasing its run
    // lock), so a later run can go pending. No scan yet, so no suspension exists.
    const reject = await startRun({
      to_agent: WORKER,
      allowed_capabilities: [SIDE_EFFECT_CAPABILITY],
    });
    const rejectInvocation = await registry.invoke(workerCall(reject.run, reject.taskId));
    new ApprovalService(database).reject(rejectInvocation.approval_id ?? "", {
      workspace_id: WORKSPACE,
      signer: createSigningOperator(database, WORKSPACE, "Test Operator").signer,
    });

    // A fresh worker call goes pending BEFORE the suspension is scanned into existence.
    const { run, taskId } = await startRun({
      to_agent: WORKER,
      allowed_capabilities: [SIDE_EFFECT_CAPABILITY],
    });
    const pending = await registry.invoke(workerCall(run, taskId));
    expect(pending.decision.outcome).toBe("require_approval");
    const pendingApprovalId = pending.approval_id ?? "";

    const suspension = narrowing.scan({ workspace_id: WORKSPACE }).suspensions[0];
    if (!suspension) {
      throw new Error("expected an active worker suspension");
    }

    new ApprovalService(database).approve(pendingApprovalId, {
      workspace_id: WORKSPACE,
      signer: createSigningOperator(database, WORKSPACE, "Test Operator").signer,
    });
    const resumed = await registry.resumeApprovedCall(pendingApprovalId, {
      workspace_id: WORKSPACE,
    });

    expect(resumed.result?.status).toBe("blocked");
    expect(resumed.result?.error).toBe(
      `Capability grant is suspended: ${SIDE_EFFECT_CAPABILITY} (suspension ${suspension.id})`,
    );
    expect(provider.executedCallIds).toEqual([]);
  });

  it("does not re-suspend on a single new failure after a lift, only on a fresh full threshold", async () => {
    await seedBase();
    await registerResearchCapability("approval_required");
    const registry = await makeRegistry();
    const narrowing = new NarrowingService(database);
    ratify({ rejection_threshold: 2, cooldown_seconds: 60 });

    await driveRejectedAgentCall(registry);
    await driveRejectedAgentCall(registry);
    const suspension = narrowing.scan({ workspace_id: WORKSPACE }).suspensions[0];
    if (!suspension) {
      throw new Error("expected an active suspension");
    }
    const afterCooldown = formatUtc(Date.parse(suspension.cooldown_until) + 1000);
    narrowing.lift(suspension.id, {
      actor: "operator:test",
      note: "root cause fixed",
      now: afterCooldown,
    });

    // One new failure lands while the lifted suspension's two evidence events are still in the
    // window. Effective non-adjudicated evidence is 1 (< threshold 2): must NOT re-suspend.
    await driveRejectedAgentCall(registry);
    expect(narrowing.scan({ workspace_id: WORKSPACE, now: afterCooldown }).suspensions).toEqual([]);
    expect(
      new GrantSuspensionStore(database)
        .listForWorkspace(WORKSPACE)
        .filter((s) => s.status === "active"),
    ).toEqual([]);

    // A second fresh failure makes a full threshold of NON-adjudicated evidence: re-suspends.
    await driveRejectedAgentCall(registry);
    const reSuspended = narrowing.scan({ workspace_id: WORKSPACE, now: afterCooldown }).suspensions;
    expect(reSuspended).toHaveLength(1);
    expect(reSuspended[0]?.id).not.toBe(suspension.id);
    expect(reSuspended[0]?.evidence_refs).not.toContain(suspension.evidence_refs[0]);
    expect(reSuspended[0]?.evidence_refs).not.toContain(suspension.evidence_refs[1]);
  });

  it("does not let the gate's own suspended-grant block feed a second suspension", async () => {
    await seedBase();
    await registerResearchCapability("approval_required");
    const registry = await makeRegistry();
    const narrowing = new NarrowingService(database);
    // Suspend the GRANTED capability via rejections; arm the violations trigger at a single block
    // so any miscounted gate block would try to create a second (policy_violations) suspension.
    ratify({ rejection_threshold: 2, violation_threshold: 1 });

    await driveRejectedAgentCall(registry);
    await driveRejectedAgentCall(registry);
    const suspension = narrowing.scan({ workspace_id: WORKSPACE }).suspensions[0];
    if (!suspension) {
      throw new Error("expected an active suspension");
    }

    // A subsequent call to the now-suspended grant passes the grant check, then hits the
    // suspension gate and is blocked with the suspension reason (a policy.decision event). That
    // block must NOT be counted as a fresh policy_violation — the scan excludes decisions whose
    // reason carries the suspended-grant prefix, so the gate can never feed its own trigger.
    const { run, taskId } = await startRun({
      to_agent: RESEARCHER,
      allowed_capabilities: [RESEARCH_CAPABILITY],
    });
    const blocked = await registry.invoke(agentCall(run, taskId));
    expect(blocked.decision.outcome).toBe("block");
    expect(blocked.decision.reason).toBe(
      `Capability grant is suspended: ${RESEARCH_CAPABILITY} (suspension ${suspension.id})`,
    );

    // Rescan: the gate block produced no second suspension; exactly the original remains.
    expect(narrowing.scan({ workspace_id: WORKSPACE }).suspensions).toEqual([]);
    expect(new GrantSuspensionStore(database).listForWorkspace(WORKSPACE).map((s) => s.id)).toEqual(
      [suspension.id],
    );
    expect(eventKinds().filter((kind) => kind === "autonomy.grant_suspended")).toHaveLength(1);
  });
});
