import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CapabilityRegistryService,
  type FetchLike,
  GitHubProvider,
  MockProvider,
  MockSideEffectProvider,
} from "../src/capabilities/index.js";
import {
  ApprovalPayloadSchema,
  type CapabilityCall,
  CapabilityCallSchema,
  CapabilityResultSchema,
  CapabilitySchema,
  NodeEffectSchema,
  OrganizationSchema,
  type Run,
  RunSchema,
  TaskEnvelopeSchema,
  WorkerIdentitySchema,
  WorkItemSchema,
  WorkspaceSchema,
} from "../src/contracts/index.js";
import { ApprovalService, GovernanceService, SelfApprovalError } from "../src/governance/index.js";
import { OrgRegistry } from "../src/org/index.js";
import {
  CapabilityCallStore,
  CapabilityStore,
  Database,
  EventStore,
  NodeEffectStore,
  OrganizationStore,
  RunStore,
  TaskEnvelopeStore,
  WorkerIdentityStore,
  WorkItemStore,
  WorkspaceStore,
} from "../src/persistence/index.js";
import { StaticCredentialBroker } from "../src/security/credential-broker.js";

const fixturePath = new URL("../../tests/fixtures/canonical_v0.json", import.meta.url);

let tmpRoot: string;
let database: Database;

async function loadFixture(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(fixturePath, "utf8")) as Record<string, unknown>;
}

async function orgRegistry(overrides: Record<string, unknown> = {}): Promise<OrgRegistry> {
  const fixture = await loadFixture();
  return new OrgRegistry({
    roles: (overrides.roles as unknown[]) ?? (fixture.roles as unknown[]),
    agents: fixture.agents as unknown[],
    communication: {
      coordinator: ["researcher"],
      researcher: ["coordinator"],
    },
  });
}

async function seedWorkspace(): Promise<string> {
  const fixture = await loadFixture();
  const workspace = WorkspaceSchema.parse(fixture.workspace);
  new WorkspaceStore(database).save(workspace);
  return workspace.id;
}

async function seedRunningRun(taskUpdates: Record<string, unknown> = {}): Promise<Run> {
  await seedWorkspace();
  const fixture = await loadFixture();
  const fixtureRun = RunSchema.parse(fixture.run);
  const queued = RunSchema.parse({
    ...fixtureRun,
    status: "queued",
    active_node: null,
    suspended_approval_id: null,
    updated_at: fixtureRun.created_at,
  });
  const store = new RunStore(database);
  store.create(queued);
  const running = store.setStatus(queued.id, "running", {
    active_node: "run_started",
    updated_at: "2026-05-27T15:20:02Z",
  });
  new WorkItemStore(database).save(WorkItemSchema.parse(fixture.work_item));
  new TaskEnvelopeStore(database).save(
    TaskEnvelopeSchema.parse({
      ...(fixture.task_envelope as Record<string, unknown>),
      run_id: running.id,
      workspace_id: running.workspace_id,
      ...taskUpdates,
    }),
  );
  return running;
}

async function seedCapability(
  permission: "enabled" | "approval_required" | "disabled" = "enabled",
) {
  const fixture = await loadFixture();
  const capability = CapabilitySchema.parse({
    ...(fixture.capability as Record<string, unknown>),
    default_permission: permission,
  });
  new CapabilityStore(database).save(capability);
  return capability;
}

async function seedSideEffectCapability(workspaceId: string) {
  const capability = CapabilitySchema.parse({
    name: "mock.side_effect.record",
    workspace_id: workspaceId,
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

async function seedWorker(workspaceId: string) {
  const worker = WorkerIdentitySchema.parse({
    id: "worker_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    workspace_id: workspaceId,
    name: "Governed Worker",
    runtime: "openmao.test.worker",
    allowed_capabilities: ["mock.side_effect.record"],
  });
  new WorkerIdentityStore(database).save(worker);
  return worker;
}

async function capabilityCall(
  run: Run,
  updates: Record<string, unknown> = {},
): Promise<CapabilityCall> {
  const fixture = await loadFixture();
  return CapabilityCallSchema.parse({
    ...(fixture.capability_call as Record<string, unknown>),
    run_id: run.id,
    workspace_id: run.workspace_id,
    ...updates,
  });
}

async function workerSideEffectCall(
  run: Run,
  workerId: string,
  updates: Record<string, unknown> = {},
): Promise<CapabilityCall> {
  return CapabilityCallSchema.parse({
    id: "capcall_99999999999999999999999999999999",
    workspace_id: run.workspace_id,
    run_id: run.id,
    capability_name: "mock.side_effect.record",
    provider: "mock.side_effect",
    input: { message: "record governed side effect" },
    requested_by: workerId,
    external_actor: {
      actor_type: "worker",
      actor_id: workerId,
      display_name: "Governed Worker",
    },
    task_id: "task_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    credential_handle: "cred_mock_side_effect",
    side_effecting: true,
    audit_payload: { intent: "prove enforced worker capability path" },
    risk_level: "high",
    idempotency_key: `${run.id}:worker_side_effect`,
    ...updates,
  });
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "openmao-ts-governance-"));
  database = new Database(join(tmpRoot, "openmao.sqlite3"));
  database.initialize();
});

afterEach(() => {
  database.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("TypeScript governance and capabilities", () => {
  it("records and replays handoff policy decisions", async () => {
    const fixture = await loadFixture();
    await seedWorkspace();
    const registry = await orgRegistry();
    const governance = new GovernanceService(database, registry);
    const workspaceId = WorkspaceSchema.parse(fixture.workspace).id;
    const coordinatorId = (fixture.agents as Array<Record<string, string>>)[0]?.id ?? "";
    const researcherId = (fixture.agents as Array<Record<string, string>>)[1]?.id ?? "";
    if (!coordinatorId || !researcherId) {
      throw new Error("fixture agents missing");
    }

    const blocked = governance.checkHandoff({
      workspace_id: workspaceId,
      from_agent_id: researcherId,
      to_agent_id: researcherId,
    });
    const allowed = governance.checkHandoff({
      workspace_id: workspaceId,
      from_agent_id: coordinatorId,
      to_agent_id: researcherId,
    });
    const drifted = new GovernanceService(
      database,
      new OrgRegistry({
        roles: fixture.roles as unknown[],
        agents: fixture.agents as unknown[],
        communication: {},
      }),
    );
    const replayed = drifted.checkHandoff({
      workspace_id: workspaceId,
      from_agent_id: coordinatorId,
      to_agent_id: researcherId,
    });

    expect(blocked.outcome).toBe("block");
    expect(allowed.outcome).toBe("allow");
    expect(replayed).toEqual(allowed);
    expect(
      new EventStore(database).listForWorkspace(workspaceId).map((event) => event.kind),
    ).toEqual(["policy.decision", "policy.decision"]);
  });

  it("requests approval, suspends a run, and resumes after approval", async () => {
    const run = await seedRunningRun();
    const approvalService = new ApprovalService(database);
    const approval = approvalService.request({
      workspace_id: run.workspace_id,
      run_id: run.id,
      action: "memory.promote",
      requested_by: "agent_55555555555555555555555555555555",
      payload: ApprovalPayloadSchema.parse({
        target_type: "promotion_candidate",
        target_id: "promo_cccccccccccccccccccccccccccccccc",
        reason: "Promote memory",
        data: {
          promotion_candidate_id: "promo_cccccccccccccccccccccccccccccccc",
        },
      }),
    });
    const suspended = new RunStore(database).get(run.id);

    expect(approval.status).toBe("pending");
    expect(suspended?.status).toBe("suspended_approval");
    expect(suspended?.suspended_approval_id).toBe(approval.id);

    const approved = approvalService.approve(approval.id, { workspace_id: run.workspace_id });
    const resumed = new RunStore(database).get(run.id);

    expect(approved.status).toBe("approved");
    expect(resumed?.status).toBe("running");
    expect(resumed?.suspended_approval_id).toBeNull();
  });

  it("replays already approved approvals without actor-dependent event conflicts", async () => {
    const run = await seedRunningRun();
    const approvalService = new ApprovalService(database);
    const approval = approvalService.request({
      workspace_id: run.workspace_id,
      run_id: run.id,
      action: "memory.promote",
      requested_by: "agent_55555555555555555555555555555555",
      payload: ApprovalPayloadSchema.parse({
        target_type: "promotion_candidate",
        target_id: "promo_cccccccccccccccccccccccccccccccc",
        reason: "Promote memory",
      }),
    });

    const approved = approvalService.approve(approval.id, {
      workspace_id: run.workspace_id,
      actor: "cli_operator",
    });
    const replayed = approvalService.approve(approval.id, {
      workspace_id: run.workspace_id,
      actor: "console_operator",
    });
    const approvedEvents = new EventStore(database)
      .listForRun(run.workspace_id, run.id)
      .filter((event) => event.kind === "approval.approved");

    expect(replayed).toEqual(approved);
    expect(approvedEvents).toHaveLength(1);
    expect(approvedEvents[0]?.actor).toBe("cli_operator");
  });

  it("dispatches non-run approval applications explicitly", async () => {
    const workspaceId = await seedWorkspace();
    const applied: string[] = [];
    const approvalService = new ApprovalService(database, {
      applyWithoutRun: (approval) => applied.push(approval.id),
    });
    const approval = approvalService.request({
      workspace_id: workspaceId,
      action: "memory.promote",
      requested_by: "agent_55555555555555555555555555555555",
      payload: ApprovalPayloadSchema.parse({
        target_type: "promotion_candidate",
        target_id: "promo_cccccccccccccccccccccccccccccccc",
        reason: "Promote memory without a run-bound resume.",
      }),
      on_approve: "apply_without_run",
      on_reject: "no_op",
    });

    const approved = approvalService.approve(approval.id, {
      workspace_id: workspaceId,
      actor: "test_operator",
    });
    const eventKinds = new EventStore(database).listForWorkspace(workspaceId).map((event) => ({
      actor: event.actor,
      kind: event.kind,
    }));

    expect(approved.status).toBe("approved");
    expect(applied).toEqual([approval.id]);
    expect(eventKinds).toContainEqual({ actor: "test_operator", kind: "approval.approved" });
    expect(eventKinds).toContainEqual({ actor: "test_operator", kind: "approval.applied" });
  });

  it("rejects no-op non-run approvals without applying side effects", async () => {
    const workspaceId = await seedWorkspace();
    const applied: string[] = [];
    const approvalService = new ApprovalService(database, {
      applyWithoutRun: (approval) => applied.push(approval.id),
    });
    const approval = approvalService.request({
      workspace_id: workspaceId,
      action: "memory.promote",
      requested_by: "agent_55555555555555555555555555555555",
      payload: ApprovalPayloadSchema.parse({
        target_type: "promotion_candidate",
        target_id: "promo_cccccccccccccccccccccccccccccccc",
        reason: "Reject without applying a non-run side effect.",
      }),
      on_approve: "apply_without_run",
      on_reject: "no_op",
    });

    const rejected = approvalService.reject(approval.id, {
      workspace_id: workspaceId,
      actor: "test_operator",
    });
    const eventKinds = new EventStore(database).listForWorkspace(workspaceId).map((event) => ({
      actor: event.actor,
      kind: event.kind,
    }));

    expect(rejected.status).toBe("rejected");
    expect(applied).toEqual([]);
    expect(eventKinds).toEqual([
      { actor: "approval_service", kind: "approval.requested" },
      { actor: "test_operator", kind: "approval.rejected" },
    ]);
  });

  it("refuses non-run approvals without an application handler", async () => {
    const workspaceId = await seedWorkspace();
    const approval = new ApprovalService(database).request({
      workspace_id: workspaceId,
      action: "memory.promote",
      requested_by: "agent_55555555555555555555555555555555",
      payload: ApprovalPayloadSchema.parse({
        target_type: "promotion_candidate",
        target_id: "promo_cccccccccccccccccccccccccccccccc",
        reason: "Promote memory without a run-bound resume.",
      }),
      on_approve: "apply_without_run",
      on_reject: "no_op",
    });

    expect(() =>
      new ApprovalService(database).approve(approval.id, {
        workspace_id: workspaceId,
        actor: "test_operator",
      }),
    ).toThrow("application handler");
  });

  it("refuses an approver identical to the requester and lets a distinct approver proceed", async () => {
    const workspaceId = await seedWorkspace();
    const applied: string[] = [];
    const approvalService = new ApprovalService(database, {
      applyWithoutRun: (approval) => applied.push(approval.id),
    });
    const approval = approvalService.request({
      workspace_id: workspaceId,
      action: "memory.promote",
      requested_by: "operator_alice",
      payload: ApprovalPayloadSchema.parse({
        target_type: "promotion_candidate",
        target_id: "promo_cccccccccccccccccccccccccccccccc",
        reason: "Self-approval must be refused (separation of duties).",
      }),
      on_approve: "apply_without_run",
      on_reject: "no_op",
    });

    // The requester cannot approve their own request; the apply handler never fires.
    expect(() =>
      approvalService.approve(approval.id, { workspace_id: workspaceId, actor: "operator_alice" }),
    ).toThrow(SelfApprovalError);
    expect(applied).toEqual([]);

    // A distinct approver resolves and applies the still-pending approval.
    const approved = approvalService.approve(approval.id, {
      workspace_id: workspaceId,
      actor: "operator_bob",
    });

    expect(approved.status).toBe("approved");
    expect(applied).toEqual([approval.id]);
  });

  it("rejects a supplied-but-blank approver identity", async () => {
    const workspaceId = await seedWorkspace();
    const applied: string[] = [];
    const approvalService = new ApprovalService(database, {
      applyWithoutRun: (approval) => applied.push(approval.id),
    });
    const approval = approvalService.request({
      workspace_id: workspaceId,
      action: "memory.promote",
      requested_by: "operator_alice",
      payload: ApprovalPayloadSchema.parse({
        target_type: "promotion_candidate",
        target_id: "promo_cccccccccccccccccccccccccccccccc",
        reason: "A blank approver must not pass as unattributed.",
      }),
      on_approve: "apply_without_run",
      on_reject: "no_op",
    });

    // A whitespace-only actor must not slip past the guard by trimming to empty.
    expect(() =>
      approvalService.approve(approval.id, { workspace_id: workspaceId, actor: "   " }),
    ).toThrow(SelfApprovalError);
    expect(applied).toEqual([]);

    // A distinct, attributable approver resolves and applies it.
    approvalService.approve(approval.id, { workspace_id: workspaceId, actor: "operator_bob" });
    expect(applied).toEqual([approval.id]);
  });

  it("executes an enabled granted capability once", async () => {
    const run = await seedRunningRun();
    await seedCapability("enabled");
    const registry = await orgRegistry();
    const provider = new MockProvider({ "onboarding brief": ["Seeded finding."] });
    const service = new CapabilityRegistryService(
      database,
      new GovernanceService(database, registry),
      [provider],
    );
    const call = await capabilityCall(run);

    const invocation = await service.invoke(call);
    const repeated = await service.invoke(call);
    const events = new EventStore(database)
      .listForRun(run.workspace_id, run.id)
      .map((event) => event.kind);

    expect(invocation.decision.outcome).toBe("allow");
    expect(invocation.result?.status).toBe("ok");
    expect(invocation.result?.output).toEqual({ findings: ["Seeded finding."] });
    expect(repeated.result).toEqual(invocation.result);
    expect(provider.executedCallIds).toEqual([call.id]);
    expect(events).toEqual([
      "capability_call.persisted",
      "capability.requested",
      "policy.decision",
      "capability.completed",
    ]);
  });

  it("joins a concurrent duplicate invocation instead of poisoning the in-flight async execution", async () => {
    const run = await seedRunningRun();
    await seedCapability("enabled");
    const registry = await orgRegistry();
    let releaseProvider: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    let executions = 0;
    const slowProvider = {
      name: "mock",
      execute: async (providerCall: CapabilityCall) => {
        executions += 1;
        await gate;
        return CapabilityResultSchema.parse({
          id: "capresult_20202020202020202020202020202020",
          workspace_id: providerCall.workspace_id,
          run_id: providerCall.run_id,
          call_id: providerCall.id,
          status: "ok",
          output: { findings: ["async finding"] },
        });
      },
    };
    const service = new CapabilityRegistryService(
      database,
      new GovernanceService(database, registry),
      [slowProvider],
    );
    const call = await capabilityCall(run);

    const first = service.invoke(call);
    const second = service.invoke(call);
    releaseProvider();
    const [firstInvocation, secondInvocation] = await Promise.all([first, second]);
    const results = new EventStore(database)
      .listForRun(run.workspace_id, run.id)
      .filter(
        (event) => event.kind === "capability.completed" || event.kind === "capability.failed",
      );

    expect(executions).toBe(1);
    expect(firstInvocation.result?.status).toBe("ok");
    expect(secondInvocation.result?.status).toBe("ok");
    expect(secondInvocation.result?.id).toBe(firstInvocation.result?.id);
    expect(results).toHaveLength(1);
    expect(results[0]?.kind).toBe("capability.completed");
  });

  it("joins concurrent duplicates across two handles to the same database file", async () => {
    const secondHandle = new Database(join(tmpRoot, "openmao.sqlite3"));
    secondHandle.initialize();
    try {
      const run = await seedRunningRun();
      await seedCapability("enabled");
      const registry = await orgRegistry();
      let releaseProvider: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        releaseProvider = resolve;
      });
      let primaryExecutions = 0;
      let secondaryExecutions = 0;
      const makeProvider = (onExecute: () => void) => ({
        name: "mock",
        execute: async (providerCall: CapabilityCall) => {
          onExecute();
          await gate;
          return CapabilityResultSchema.parse({
            id: "capresult_21212121212121212121212121212121",
            workspace_id: providerCall.workspace_id,
            run_id: providerCall.run_id,
            call_id: providerCall.id,
            status: "ok",
            output: { findings: ["cross-handle finding"] },
          });
        },
      });
      const primary = new CapabilityRegistryService(
        database,
        new GovernanceService(database, registry),
        [
          makeProvider(() => {
            primaryExecutions += 1;
          }),
        ],
      );
      const secondary = new CapabilityRegistryService(
        secondHandle,
        new GovernanceService(secondHandle, registry),
        [
          makeProvider(() => {
            secondaryExecutions += 1;
          }),
        ],
      );
      const call = await capabilityCall(run);

      const first = primary.invoke(call);
      const second = secondary.invoke(call);
      releaseProvider();
      const [firstInvocation, secondInvocation] = await Promise.all([first, second]);

      expect(primaryExecutions + secondaryExecutions).toBe(1);
      expect(firstInvocation.result?.status).toBe("ok");
      expect(secondInvocation.result?.status).toBe("ok");
      expect(secondInvocation.result?.id).toBe(firstInvocation.result?.id);
    } finally {
      secondHandle.close();
    }
  });

  it("rejects unknown or secret-shaped capability payload material before persistence", async () => {
    const run = await seedRunningRun();
    await seedCapability("enabled");
    const registry = await orgRegistry();
    const provider = new MockProvider();
    const service = new CapabilityRegistryService(
      database,
      new GovernanceService(database, registry),
      [provider],
    );
    const extraFieldCall = await capabilityCall(run, {
      id: "capcall_12121212121212121212121212121212",
      input: { query: "onboarding brief", secret: "sk-testsecret123456" },
      idempotency_key: `${run.id}:secret_input`,
    });
    const auditSecretCall = await capabilityCall(run, {
      id: "capcall_13131313131313131313131313131313",
      audit_payload: { token: "Bearer testsecret123456" },
      idempotency_key: `${run.id}:secret_audit`,
    });

    await expect(service.invoke(extraFieldCall)).rejects.toThrow(/unknown field|sensitive key/);
    await expect(service.invoke(auditSecretCall)).rejects.toThrow("secret-shaped material");
    expect(provider.executedCallIds).toEqual([]);
    expect(new CapabilityCallStore(database).listForWorkspace(run.workspace_id)).toEqual([]);
  });

  it("does not persist secret-shaped provider output", async () => {
    const run = await seedRunningRun();
    await seedCapability("enabled");
    const registry = await orgRegistry();
    const secretProvider = {
      name: "mock",
      executedCallIds: [] as string[],
      execute(call: CapabilityCall) {
        this.executedCallIds.push(call.id);
        return CapabilityResultSchema.parse({
          id: "capresult_14141414141414141414141414141414",
          workspace_id: call.workspace_id,
          run_id: call.run_id,
          call_id: call.id,
          status: "ok",
          output: { findings: ["sk-testsecret123456"] },
        });
      },
    };
    const service = new CapabilityRegistryService(
      database,
      new GovernanceService(database, registry),
      [secretProvider],
    );
    const call = await capabilityCall(run, {
      id: "capcall_14141414141414141414141414141414",
      idempotency_key: `${run.id}:provider_output_redaction`,
    });

    const invocation = await service.invoke(call);
    const auditJson = JSON.stringify(new EventStore(database).listForWorkspace(run.workspace_id));

    expect(invocation.result?.status).toBe("failed");
    expect(invocation.result?.error).not.toContain("sk-testsecret123456");
    expect(secretProvider.executedCallIds).toEqual([call.id]);
    expect(auditJson).not.toContain("sk-testsecret123456");
  });

  it("does not persist secret-shaped failed provider output", async () => {
    const run = await seedRunningRun();
    await seedCapability("enabled");
    const registry = await orgRegistry();
    const secretProvider = {
      name: "mock",
      executedCallIds: [] as string[],
      execute(call: CapabilityCall) {
        this.executedCallIds.push(call.id);
        return CapabilityResultSchema.parse({
          id: "capresult_15151515151515151515151515151515",
          workspace_id: call.workspace_id,
          run_id: call.run_id,
          call_id: call.id,
          status: "failed",
          output: { api_key: "sk-testsecret123456" },
          error: "provider failed without leaking the credential",
        });
      },
    };
    const service = new CapabilityRegistryService(
      database,
      new GovernanceService(database, registry),
      [secretProvider],
    );
    const call = await capabilityCall(run, {
      id: "capcall_15151515151515151515151515151515",
      idempotency_key: `${run.id}:failed_provider_output_redaction`,
    });

    const invocation = await service.invoke(call);
    const auditJson = JSON.stringify(new EventStore(database).listForWorkspace(run.workspace_id));

    expect(invocation.result?.status).toBe("failed");
    expect(invocation.result?.error).not.toContain("sk-testsecret123456");
    expect(secretProvider.executedCallIds).toEqual([call.id]);
    expect(auditJson).not.toContain("sk-testsecret123456");
  });

  it("does not re-execute a provider when a node-effect guard exists without a result", async () => {
    const run = await seedRunningRun();
    await seedCapability("enabled");
    const registry = await orgRegistry();
    const provider = new MockProvider();
    const service = new CapabilityRegistryService(
      database,
      new GovernanceService(database, registry),
      [provider],
    );
    const call = await capabilityCall(run, {
      id: "capcall_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      idempotency_key: `${run.id}:guarded_execution`,
    });
    const effect = new NodeEffectStore(database).record(
      NodeEffectSchema.parse({
        id: "effect_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        workspace_id: call.workspace_id,
        run_id: call.run_id,
        node: `capability:${call.capability_name}`,
        idempotency_key: `${call.id}:provider`,
        effect_type: "capability.execute",
        effect_ref: call.id,
        created_at: "2026-05-27T15:20:03Z",
      }),
    );

    const invocation = await service.invoke(call);
    const repeated = await service.invoke(call);
    const eventKinds = new EventStore(database)
      .listForRun(run.workspace_id, run.id)
      .map((event) => event.kind);

    expect(invocation.result?.status).toBe("failed");
    expect(invocation.result?.node_effect_id).toBe(effect.id);
    expect(invocation.result?.error).toContain("refusing to re-execute");
    expect(repeated.result).toEqual(invocation.result);
    expect(provider.executedCallIds).toEqual([]);
    expect(eventKinds).toContain("capability.failed");
  });

  it("requires approval before executing approval-gated capabilities", async () => {
    const run = await seedRunningRun();
    await seedCapability("approval_required");
    const registry = await orgRegistry();
    const provider = new MockProvider();
    const service = new CapabilityRegistryService(
      database,
      new GovernanceService(database, registry),
      [provider],
    );
    const call = await capabilityCall(run, {
      id: "capcall_cccccccccccccccccccccccccccccccc",
      idempotency_key: `${run.id}:approval_required`,
    });

    const suspendedInvocation = await service.invoke(call);
    const suspended = new RunStore(database).get(run.id);

    expect(suspendedInvocation.decision.outcome).toBe("require_approval");
    expect(suspendedInvocation.approval_id).toBe("approval_cccccccccccccccccccccccccccccccc");
    expect(suspendedInvocation.result).toBeUndefined();
    expect(provider.executedCallIds).toEqual([]);
    expect(suspended?.status).toBe("suspended_approval");

    new ApprovalService(database).approve(suspendedInvocation.approval_id ?? "", {
      workspace_id: run.workspace_id,
    });
    const resumedInvocation = await service.resumeApprovedCall(
      suspendedInvocation.approval_id ?? "",
      {
        workspace_id: run.workspace_id,
      },
    );

    expect(resumedInvocation.result?.status).toBe("ok");
    expect(provider.executedCallIds).toEqual([call.id]);
  });

  it("requires approval before executing high-risk enabled capabilities", async () => {
    const run = await seedRunningRun();
    await seedCapability("enabled");
    const registry = await orgRegistry();
    const provider = new MockProvider();
    const service = new CapabilityRegistryService(
      database,
      new GovernanceService(database, registry),
      [provider],
    );
    const call = await capabilityCall(run, {
      id: "capcall_88888888888888888888888888888888",
      idempotency_key: `${run.id}:high_risk`,
      risk_level: "high",
    });

    const suspendedInvocation = await service.invoke(call);

    expect(suspendedInvocation.decision.outcome).toBe("require_approval");
    expect(suspendedInvocation.decision.reason).toContain("High-risk");
    expect(suspendedInvocation.result).toBeUndefined();
    expect(provider.executedCallIds).toEqual([]);

    new ApprovalService(database).approve(suspendedInvocation.approval_id ?? "", {
      workspace_id: run.workspace_id,
    });
    const resumedInvocation = await service.resumeApprovedCall(
      suspendedInvocation.approval_id ?? "",
      {
        workspace_id: run.workspace_id,
      },
    );

    expect(resumedInvocation.result?.status).toBe("ok");
    expect(provider.executedCallIds).toEqual([call.id]);
  });

  it("records an explicit blocked result after a capability approval is rejected", async () => {
    const run = await seedRunningRun();
    await seedCapability("approval_required");
    const registry = await orgRegistry();
    const provider = new MockProvider();
    const service = new CapabilityRegistryService(
      database,
      new GovernanceService(database, registry),
      [provider],
    );
    const call = await capabilityCall(run, {
      id: "capcall_33333333333333333333333333333333",
      idempotency_key: `${run.id}:approval_rejected`,
    });

    const suspendedInvocation = await service.invoke(call);
    new ApprovalService(database).reject(suspendedInvocation.approval_id ?? "", {
      workspace_id: run.workspace_id,
      actor: "test_operator",
    });
    const rejectedInvocation = await service.invoke(call);

    expect(rejectedInvocation.decision.outcome).toBe("require_approval");
    expect(rejectedInvocation.result?.status).toBe("blocked");
    expect(rejectedInvocation.result?.error).toContain("approval was rejected");
    expect(provider.executedCallIds).toEqual([]);
  });

  it("blocks ungranted capabilities without provider execution", async () => {
    const run = await seedRunningRun();
    await seedCapability("enabled");
    const fixture = await loadFixture();
    const roles = (fixture.roles as Array<Record<string, unknown>>).map((role) =>
      role.name === "researcher" ? { ...role, capability_grants: [] } : role,
    );
    const provider = new MockProvider();
    const service = new CapabilityRegistryService(
      database,
      new GovernanceService(database, await orgRegistry({ roles })),
      [provider],
    );
    const call = await capabilityCall(run, {
      id: "capcall_dddddddddddddddddddddddddddddddd",
      idempotency_key: `${run.id}:blocked`,
    });

    const invocation = await service.invoke(call);

    expect(invocation.decision.outcome).toBe("block");
    expect(invocation.result?.status).toBe("blocked");
    expect(provider.executedCallIds).toEqual([]);
  });

  it("blocks capability calls outside the persisted task envelope assignee", async () => {
    const run = await seedRunningRun();
    await seedCapability("enabled");
    const provider = new MockProvider();
    const service = new CapabilityRegistryService(
      database,
      new GovernanceService(database, await orgRegistry()),
      [provider],
    );
    const call = await capabilityCall(run, {
      id: "capcall_11111111111111111111111111111111",
      idempotency_key: `${run.id}:spoofed_task_assignee`,
      requested_by: "agent_55555555555555555555555555555555",
    });

    const invocation = await service.invoke(call);

    expect(invocation.decision.outcome).toBe("block");
    expect(invocation.decision.reason).toContain("task envelope assignee");
    expect(invocation.result?.status).toBe("blocked");
    expect(provider.executedCallIds).toEqual([]);
  });

  it("blocks capability calls not allowed by the persisted task envelope", async () => {
    const run = await seedRunningRun({ allowed_capabilities: [] });
    await seedCapability("enabled");
    const provider = new MockProvider();
    const service = new CapabilityRegistryService(
      database,
      new GovernanceService(database, await orgRegistry()),
      [provider],
    );
    const call = await capabilityCall(run, {
      id: "capcall_22222222222222222222222222222222",
      idempotency_key: `${run.id}:task_capability_not_allowed`,
    });

    const invocation = await service.invoke(call);

    expect(invocation.decision.outcome).toBe("block");
    expect(invocation.decision.reason).toContain("task envelope");
    expect(invocation.result?.status).toBe("blocked");
    expect(provider.executedCallIds).toEqual([]);
  });

  it("blocks disabled capabilities without provider execution", async () => {
    const run = await seedRunningRun();
    await seedCapability("disabled");
    const provider = new MockProvider();
    const service = new CapabilityRegistryService(
      database,
      new GovernanceService(database, await orgRegistry()),
      [provider],
    );
    const call = await capabilityCall(run, {
      id: "capcall_ffffffffffffffffffffffffffffffff",
      idempotency_key: `${run.id}:disabled`,
    });

    const invocation = await service.invoke(call);

    expect(invocation.decision.outcome).toBe("block");
    expect(invocation.result?.status).toBe("blocked");
    expect(invocation.result?.error).toContain("Capability is disabled");
    expect(provider.executedCallIds).toEqual([]);
  });

  it("gates external-worker side effects through credential handles and approval", async () => {
    const run = await seedRunningRun({
      to_agent: "worker_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      allowed_capabilities: ["mock.side_effect.record"],
    });
    const worker = await seedWorker(run.workspace_id);
    await seedSideEffectCapability(run.workspace_id);
    const rawSecret = "super_secret_test_token_123";
    const firstProvider = new MockSideEffectProvider({ cred_mock_side_effect: rawSecret });
    const service = new CapabilityRegistryService(
      database,
      new GovernanceService(database, await orgRegistry()),
      [firstProvider],
    );
    const call = await workerSideEffectCall(run, worker.id);

    const suspended = await service.invoke(call);
    const suspendedRun = new RunStore(database).get(run.id);

    expect(suspended.decision.outcome).toBe("require_approval");
    expect(suspended.approval_id).toBe("approval_99999999999999999999999999999999");
    expect(suspended.result).toBeUndefined();
    expect(firstProvider.executedCallIds).toEqual([]);
    expect(suspendedRun?.status).toBe("suspended_approval");

    new ApprovalService(database).approve(suspended.approval_id ?? "", {
      workspace_id: run.workspace_id,
      actor: "test_operator",
    });
    const resumedProvider = new MockSideEffectProvider({ cred_mock_side_effect: rawSecret });
    const resumed = await new CapabilityRegistryService(
      database,
      new GovernanceService(database, await orgRegistry()),
      [resumedProvider],
    ).resumeApprovedCall(suspended.approval_id ?? "", { workspace_id: run.workspace_id });
    const replayProvider = new MockSideEffectProvider({ cred_mock_side_effect: rawSecret });
    const replayed = await new CapabilityRegistryService(
      database,
      new GovernanceService(database, await orgRegistry()),
      [replayProvider],
    ).resumeApprovedCall(suspended.approval_id ?? "", { workspace_id: run.workspace_id });
    const auditJson = JSON.stringify(new EventStore(database).listForWorkspace(run.workspace_id));

    expect(resumed.result?.status).toBe("ok");
    expect(resumed.result?.output).toEqual({
      provider: "mock.side_effect",
      effect: "recorded",
      handle: "cred_mock_side_effect",
    });
    expect(replayed.result).toEqual(resumed.result);
    expect(resumedProvider.executedCallIds).toEqual([call.id]);
    expect(replayProvider.executedCallIds).toEqual([]);
    expect(auditJson).toContain("cred_mock_side_effect");
    expect(auditJson).not.toContain(rawSecret);
  });

  it("blocks external-worker side effects without a provider credential handle", async () => {
    const run = await seedRunningRun({
      to_agent: "worker_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      allowed_capabilities: ["mock.side_effect.record"],
    });
    const worker = await seedWorker(run.workspace_id);
    await seedSideEffectCapability(run.workspace_id);
    const provider = new MockSideEffectProvider({ cred_mock_side_effect: "secret" });
    const service = new CapabilityRegistryService(
      database,
      new GovernanceService(database, await orgRegistry()),
      [provider],
    );
    const call = await workerSideEffectCall(run, worker.id, {
      id: "capcall_77777777777777777777777777777777",
      credential_handle: null,
      idempotency_key: `${run.id}:worker_side_effect_missing_handle`,
    });

    const invocation = await service.invoke(call);

    expect(invocation.decision.outcome).toBe("block");
    expect(invocation.decision.reason).toContain("credential handle");
    expect(invocation.result?.status).toBe("blocked");
    expect(provider.executedCallIds).toEqual([]);
  });

  it("blocks a capability call whose credential handle is not the capability's bound handle", async () => {
    const run = await seedRunningRun({
      to_agent: "worker_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      allowed_capabilities: ["mock.side_effect.record"],
    });
    const worker = await seedWorker(run.workspace_id);
    await seedSideEffectCapability(run.workspace_id); // bound to cred_mock_side_effect
    // Both secrets are configured; without capability-bound handles a worker
    // could steer resolution to cred_other by naming it in the call.
    const provider = new MockSideEffectProvider({
      cred_mock_side_effect: "mock-resolved",
      cred_other: "other-resolved",
    });
    const service = new CapabilityRegistryService(
      database,
      new GovernanceService(database, await orgRegistry()),
      [provider],
    );
    const call = await workerSideEffectCall(run, worker.id, {
      id: "capcall_44444444444444444444444444444444",
      credential_handle: "cred_other",
      idempotency_key: `${run.id}:worker_side_effect_wrong_handle`,
    });

    const invocation = await service.invoke(call);

    expect(invocation.decision.outcome).toBe("block");
    expect(invocation.decision.reason).toContain("bound handle");
    expect(invocation.result?.status).toBe("blocked");
    expect(provider.executedCallIds).toEqual([]);
  });

  it("blocks a credential-required capability that declares no bound handle", async () => {
    const run = await seedRunningRun({
      to_agent: "worker_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      allowed_capabilities: ["mock.side_effect.record"],
    });
    const worker = await seedWorker(run.workspace_id);
    new CapabilityStore(database).save(
      CapabilitySchema.parse({
        name: "mock.side_effect.record",
        workspace_id: run.workspace_id,
        description: "Side effect that omits its credential handle binding.",
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
        // credential_handle intentionally omitted (defaults to null)
        default_permission: "approval_required",
      }),
    );
    const provider = new MockSideEffectProvider({ cred_mock_side_effect: "mock-resolved" });
    const service = new CapabilityRegistryService(
      database,
      new GovernanceService(database, await orgRegistry()),
      [provider],
    );
    const call = await workerSideEffectCall(run, worker.id, {
      id: "capcall_55555555555555555555555555555555",
      idempotency_key: `${run.id}:worker_side_effect_unbound`,
    });

    const invocation = await service.invoke(call);

    expect(invocation.decision.outcome).toBe("block");
    expect(invocation.decision.reason).toContain("declared credential handle binding");
    expect(invocation.result?.status).toBe("blocked");
    expect(provider.executedCallIds).toEqual([]);
  });

  it("blocks a side-effecting call that names a handle the capability never declared", async () => {
    const run = await seedRunningRun({
      to_agent: "worker_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      allowed_capabilities: ["mock.side_effect.record"],
    });
    const worker = await seedWorker(run.workspace_id);
    // side_effecting but neither requires nor declares a bound handle: the
    // binding must still hold, or a worker could steer to cred_other.
    new CapabilityStore(database).save(
      CapabilitySchema.parse({
        name: "mock.side_effect.record",
        workspace_id: run.workspace_id,
        description: "Side effect with no credential binding declared.",
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
        credential_handle_required: false,
        default_permission: "enabled",
      }),
    );
    const provider = new MockSideEffectProvider({ cred_other: "other-resolved" });
    const service = new CapabilityRegistryService(
      database,
      new GovernanceService(database, await orgRegistry()),
      [provider],
    );
    const call = await workerSideEffectCall(run, worker.id, {
      id: "capcall_66666666666666666666666666666666",
      credential_handle: "cred_other",
      idempotency_key: `${run.id}:worker_side_effect_unbound_named`,
    });

    const invocation = await service.invoke(call);

    expect(invocation.decision.outcome).toBe("block");
    expect(invocation.decision.reason).toContain("bound handle");
    expect(invocation.result?.status).toBe("blocked");
    expect(provider.executedCallIds).toEqual([]);
  });

  it("blocks an intrinsically side-effecting provider when the capability is not marked side-effecting", async () => {
    const run = await seedRunningRun();
    await seedCapability("enabled"); // mock.research_lookup, side_effecting: false, provider "mock"
    const registry = await orgRegistry();
    let executed = false;
    const sideEffectingMock = {
      name: "mock",
      sideEffecting: true,
      execute: async (c: CapabilityCall) => {
        executed = true;
        return CapabilityResultSchema.parse({
          id: "capresult_30303030303030303030303030303030",
          workspace_id: c.workspace_id,
          run_id: c.run_id,
          call_id: c.id,
          status: "ok",
          output: { findings: ["x"] },
        });
      },
    };
    const service = new CapabilityRegistryService(
      database,
      new GovernanceService(database, registry),
      [sideEffectingMock],
    );
    const call = await capabilityCall(run); // side_effecting defaults to false

    const invocation = await service.invoke(call);

    expect(invocation.decision.outcome).toBe("block");
    expect(invocation.decision.reason).toContain("side-effecting");
    expect(invocation.result?.status).toBe("blocked");
    expect(executed).toBe(false);
  });

  it("enforces approval and at-most-once for the real GitHub provider through the registry", async () => {
    const run = await seedRunningRun({
      to_agent: "worker_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      allowed_capabilities: ["github.create_issue_comment"],
    });
    const worker = new WorkerIdentityStore(database).save(
      WorkerIdentitySchema.parse({
        id: "worker_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        workspace_id: run.workspace_id,
        name: "Governed Worker",
        runtime: "openmao.test.worker",
        allowed_capabilities: ["github.create_issue_comment"],
      }),
    );
    new CapabilityStore(database).save(
      CapabilitySchema.parse({
        name: "github.create_issue_comment",
        workspace_id: run.workspace_id,
        description: "Create a GitHub issue comment through OpenMAO.",
        tool_name: "github",
        canonical_input_schema: {
          type: "object",
          required: ["owner", "repo", "issue_number", "body"],
          properties: {
            owner: { type: "string" },
            repo: { type: "string" },
            issue_number: { type: "integer" },
            body: { type: "string" },
          },
        },
        canonical_output_schema: {
          type: "object",
          required: ["comment_id", "html_url"],
          properties: { comment_id: { type: "integer" }, html_url: { type: "string" } },
        },
        providers: ["github"],
        side_effecting: true,
        credential_handle_required: true,
        credential_handle: "cred_github",
        default_permission: "approval_required",
      }),
    );
    const fakeToken = "gh-fake-value-xyz789";
    const okResponse = {
      ok: true,
      status: 201,
      json: async () => ({ id: 9001, html_url: "https://github.com/o/r/issues/7#c-9001" }),
    };
    let firstExecutions = 0;
    const firstTransport: FetchLike = async () => {
      firstExecutions += 1;
      return okResponse;
    };
    const githubProvider = () =>
      new GitHubProvider(new StaticCredentialBroker({ cred_github: fakeToken }), {
        transport: firstTransport,
      });
    const githubCall = CapabilityCallSchema.parse({
      id: "capcall_dddddddddddddddddddddddddddddddd",
      workspace_id: run.workspace_id,
      run_id: run.id,
      capability_name: "github.create_issue_comment",
      provider: "github",
      input: { owner: "o", repo: "r", issue_number: 7, body: "governed comment" },
      requested_by: worker.id,
      external_actor: {
        actor_type: "worker",
        actor_id: worker.id,
        display_name: "Governed Worker",
      },
      task_id: "task_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      credential_handle: "cred_github",
      side_effecting: true,
      audit_payload: { intent: "post a governed issue comment" },
      risk_level: "high",
      idempotency_key: `${run.id}:github_comment`,
    });

    // 1. High-risk side effect suspends for approval before any transport call.
    const suspended = await new CapabilityRegistryService(
      database,
      new GovernanceService(database, await orgRegistry()),
      [githubProvider()],
    ).invoke(githubCall);
    expect(suspended.decision.outcome).toBe("require_approval");
    expect(suspended.result).toBeUndefined();
    expect(firstExecutions).toBe(0);
    expect(new RunStore(database).get(run.id)?.status).toBe("suspended_approval");

    // 2. After approval, resume executes the provider exactly once.
    new ApprovalService(database).approve(suspended.approval_id ?? "", {
      workspace_id: run.workspace_id,
      actor: "operator",
    });
    const resumed = await new CapabilityRegistryService(
      database,
      new GovernanceService(database, await orgRegistry()),
      [githubProvider()],
    ).resumeApprovedCall(suspended.approval_id ?? "", { workspace_id: run.workspace_id });
    expect(resumed.result?.status).toBe("ok");
    expect(resumed.result?.output).toEqual({
      comment_id: 9001,
      html_url: "https://github.com/o/r/issues/7#c-9001",
    });
    expect(firstExecutions).toBe(1);

    // 3. Replay after a real process restart: reopen the database from disk so
    //    no in-memory state carries over, and confirm resume returns the
    //    persisted result without re-executing the provider.
    const restarted = new Database(join(tmpRoot, "openmao.sqlite3"));
    restarted.initialize();
    let replayExecutions = 0;
    const replayTransport: FetchLike = async () => {
      replayExecutions += 1;
      return okResponse;
    };
    try {
      const replayed = await new CapabilityRegistryService(
        restarted,
        new GovernanceService(restarted, await orgRegistry()),
        [
          new GitHubProvider(new StaticCredentialBroker({ cred_github: fakeToken }), {
            transport: replayTransport,
          }),
        ],
      ).resumeApprovedCall(suspended.approval_id ?? "", { workspace_id: run.workspace_id });
      expect(replayed.result).toEqual(resumed.result);
      expect(replayExecutions).toBe(0);
    } finally {
      restarted.close();
    }

    // 4. The resolved token never reaches the audit trail.
    const auditJson = JSON.stringify(new EventStore(database).listForWorkspace(run.workspace_id));
    expect(auditJson).not.toContain(fakeToken);
  });

  function enabledSideEffectCapability(workspaceId: string) {
    return CapabilitySchema.parse({
      name: "mock.side_effect.record",
      workspace_id: workspaceId,
      description: "Enabled side effect for autonomy-dial testing.",
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
      default_permission: "enabled",
    });
  }

  function seedOrgWithAutonomy(workspaceId: string, level: "advisory" | "supervised" | "bounded") {
    new OrganizationStore(database).save(
      OrganizationSchema.parse({
        id: "org_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        workspace_id: workspaceId,
        name: "Dial Org",
        mission: "Exercise the autonomy dial on the gateway path.",
        autonomy_level: level,
      }),
    );
  }

  it("applies the autonomy dial on the external-worker gateway: bounded allows a side-effecting low-risk call", async () => {
    const run = await seedRunningRun({
      to_agent: "worker_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      allowed_capabilities: ["mock.side_effect.record"],
    });
    const worker = await seedWorker(run.workspace_id);
    new CapabilityStore(database).save(enabledSideEffectCapability(run.workspace_id));
    seedOrgWithAutonomy(run.workspace_id, "bounded");
    const provider = new MockSideEffectProvider({ cred_mock_side_effect: "secret" });
    const service = new CapabilityRegistryService(
      database,
      new GovernanceService(database, await orgRegistry()),
      [provider],
    );
    const call = await workerSideEffectCall(run, worker.id, { risk_level: "low" });

    const invocation = await service.invoke(call);

    expect(invocation.decision.outcome).toBe("allow");
    expect(invocation.result?.status).toBe("ok");
    expect(provider.executedCallIds).toEqual([call.id]);
  });

  it("applies the autonomy dial on the external-worker gateway: supervised gates the same call", async () => {
    const run = await seedRunningRun({
      to_agent: "worker_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      allowed_capabilities: ["mock.side_effect.record"],
    });
    const worker = await seedWorker(run.workspace_id);
    new CapabilityStore(database).save(enabledSideEffectCapability(run.workspace_id));
    seedOrgWithAutonomy(run.workspace_id, "supervised");
    const provider = new MockSideEffectProvider({ cred_mock_side_effect: "secret" });
    const service = new CapabilityRegistryService(
      database,
      new GovernanceService(database, await orgRegistry()),
      [provider],
    );
    const call = await workerSideEffectCall(run, worker.id, { risk_level: "low" });

    const invocation = await service.invoke(call);

    expect(invocation.decision.outcome).toBe("require_approval");
    expect(provider.executedCallIds).toEqual([]);
  });
});
