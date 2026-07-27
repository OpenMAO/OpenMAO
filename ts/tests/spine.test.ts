import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ApprovalPayloadSchema,
  CapabilitySchema,
  EventPayloadSchema,
  RunSchema,
  WorkspaceSchema,
} from "../src/contracts/index.js";
import { ApprovalService } from "../src/governance/index.js";
import {
  AgentStore,
  CapabilityStore,
  CheckpointStore,
  Database,
  EventStore,
  MemoryEntryStore,
  OrganizationStore,
  PromotionCandidateStore,
  RoleStore,
  RunStore,
  TraceStore,
  WorkItemStore,
  WorkspaceStore,
} from "../src/persistence/index.js";
import {
  CAPABILITY_CALL_ID,
  COORDINATOR_AGENT_ID,
  COORDINATOR_MEMORY_ID,
  COORDINATOR_ROLE_ID,
  ORG_ID,
  PROMOTION_APPROVAL_ID,
  PROMOTION_CANDIDATE_ID,
  RESEARCHER_MEMORY_ID,
  RESEARCHER_ROLE_ID,
  RUN_ID,
  SpineService,
  WORK_ITEM_ID,
  WORKSPACE_ID,
} from "../src/spine/index.js";
import { WorldModelService } from "../src/world/index.js";
import { createSigningOperator } from "./helpers/principals.js";

let tmpRoot: string;
let database: Database;
let service: SpineService;

/** A signing operator in the demo workspace, for decision calls in these tests. */
function demoSigner(displayName = "Demo Operator") {
  return createSigningOperator(database, WORKSPACE_ID, displayName).signer;
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "openmao-ts-spine-"));
  database = new Database(join(tmpRoot, "openmao.sqlite3"));
  database.initialize();
  service = new SpineService(database, {
    artifact_dir: join(tmpRoot, "artifacts"),
    collective_memory_dir: join(tmpRoot, "collective_memory"),
  });
});

afterEach(() => {
  database.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("TypeScript demo spine", () => {
  it("runs to durable approval suspension idempotently", async () => {
    const result = await service.startDemo();
    const replayed = await service.startDemo();
    const run = new RunStore(database).get(RUN_ID);
    const events = new EventStore(database).listForRun(WORKSPACE_ID, RUN_ID);
    const eventKinds = events.map((event) => event.kind);
    const memories = new MemoryEntryStore(database);
    const checkpoint = new CheckpointStore(database).latest(WORKSPACE_ID, RUN_ID);

    expect(replayed).toEqual(result);
    expect(result.status).toBe("suspended_approval");
    expect(result.active_node).toBe("approval_requested");
    expect(result.approval_id).toBe(PROMOTION_APPROVAL_ID);
    expect(run?.suspended_approval_id).toBe(PROMOTION_APPROVAL_ID);
    expect(memories.get(RESEARCHER_MEMORY_ID)).not.toBeNull();
    expect(memories.get(COORDINATOR_MEMORY_ID)).not.toBeNull();
    expect(memories.get("mem_cccccccccccccccccccccccccccccccc")).toBeNull();
    expect(existsSync(join(tmpRoot, "artifacts", "onboarding_brief.md"))).toBe(true);
    expect(eventKinds).not.toContain("memory.collective_written");
    expect(eventKinds).toEqual(
      expect.arrayContaining([
        "handoff.requested",
        "handoff.completed",
        "capability.completed",
        "agent.completed",
        "memory.individual_written",
      ]),
    );
    expect(eventKinds).not.toContain("capability.called");
    expect(eventKinds).not.toContain("handoff.created");
    expect(eventKinds).not.toContain("agent.finalized");
    expect(eventKinds).not.toContain("memory.individual_writes_completed");
    expect(checkpoint?.node).toBe("approval_requested");
    expect(checkpoint?.run_status).toBe("suspended_approval");
  });

  it("approves, resumes, writes collective memory, and completes once", async () => {
    const suspended = await service.startDemo();

    const completed = service.resumeDemo(null, { signer: demoSigner() });
    const replayed = service.resumeDemo(null, { signer: demoSigner() });
    const run = new RunStore(database).get(RUN_ID);
    const approval = new ApprovalService(database).approvals.get(PROMOTION_APPROVAL_ID);
    const candidate = new PromotionCandidateStore(database).get(PROMOTION_CANDIDATE_ID);
    const collective = new MemoryEntryStore(database).get("mem_cccccccccccccccccccccccccccccccc");
    const workItem = new WorkItemStore(database).get(WORK_ITEM_ID);
    const events = new EventStore(database).listForRun(WORKSPACE_ID, RUN_ID);
    const traces = new TraceStore(database).listForRun(RUN_ID);
    const completedEvent = events.find((event) => event.kind === "run.completed");
    const workCompletedEvent = events.find((event) => event.kind === "work.completed");
    const completedTrace = traces.find((trace) => trace.node === "run_completed");
    const workCompletedTrace = traces.find((trace) => trace.node === "work_completed");
    const workCompletedCheckpoint = new CheckpointStore(database)
      .listForRun(WORKSPACE_ID, RUN_ID)
      .find((item) => item.node === "work_completed");
    const checkpoint = new CheckpointStore(database).latest(WORKSPACE_ID, RUN_ID);

    expect(suspended.status).toBe("suspended_approval");
    expect(replayed).toEqual(completed);
    expect(completed.status).toBe("completed");
    expect(completed.collective_memory_id).toBe("mem_cccccccccccccccccccccccccccccccc");
    expect(run?.status).toBe("completed");
    expect(candidate?.status).toBe("ratified");
    expect(candidate?.resolved_at).toBe(approval?.resolved_at);
    expect(collective?.scope).toBe("collective");
    expect(workItem?.status).toBe("done");
    expect(existsSync(join(tmpRoot, "collective_memory", `${PROMOTION_CANDIDATE_ID}.md`))).toBe(
      true,
    );
    expect(events.slice(-4).map((event) => event.kind)).toEqual([
      "approval.approved",
      "memory.collective_written",
      "work.completed",
      "run.completed",
    ]);
    expect(traces.length).toBeGreaterThan(0);
    expect(completedEvent).toBeDefined();
    expect(workCompletedEvent).toBeDefined();
    expect(completedTrace?.event_ids).toContain(completedEvent?.id);
    expect(workCompletedTrace?.event_ids).toContain(workCompletedEvent?.id);
    expect(workCompletedCheckpoint?.state.active_node).toBe("work_completed");
    expect(checkpoint?.node).toBe("run_completed");
    expect(checkpoint?.run_status).toBe("completed");
  });

  it("isolates default side-effect directories per custom database path", async () => {
    const first = new Database(join(tmpRoot, "first.sqlite3"));
    const second = new Database(join(tmpRoot, "second.sqlite3"));
    first.initialize();
    second.initialize();
    try {
      const firstService = new SpineService(first);
      const secondService = new SpineService(second);

      await firstService.startDemo();
      firstService.resumeDemo(null, {
        signer: createSigningOperator(first, WORKSPACE_ID, "First Operator").signer,
      });
      await secondService.startDemo();
      secondService.resumeDemo(null, {
        signer: createSigningOperator(second, WORKSPACE_ID, "Second Operator").signer,
      });

      expect(
        existsSync(
          join(
            tmpRoot,
            "first.sqlite3.openmao",
            "collective_memory",
            `${PROMOTION_CANDIDATE_ID}.md`,
          ),
        ),
      ).toBe(true);
      expect(
        existsSync(
          join(
            tmpRoot,
            "second.sqlite3.openmao",
            "collective_memory",
            `${PROMOTION_CANDIDATE_ID}.md`,
          ),
        ),
      ).toBe(true);
      expect(existsSync(join(tmpRoot, "collective_memory", `${PROMOTION_CANDIDATE_ID}.md`))).toBe(
        false,
      );
    } finally {
      first.close();
      second.close();
    }
  });

  it("resumes a running demo checkpoint to the next approval boundary", async () => {
    service.initDemoWorkspace();
    new RunStore(database).create(
      RunSchema.parse({
        id: RUN_ID,
        workspace_id: WORKSPACE_ID,
        status: "running",
        active_node: "run_started",
        suspended_approval_id: null,
        created_at: "2026-05-27T15:20:01Z",
        updated_at: "2026-05-27T15:20:02Z",
      }),
    );

    const resumed = await service.resumeRun(RUN_ID, { signer: demoSigner() });
    const replayed = await service.resumeRun(RUN_ID, { signer: demoSigner() });
    const events = new EventStore(database).listForRun(WORKSPACE_ID, RUN_ID);
    const approvalEvents = events.filter((event) => event.kind === "approval.requested");

    expect(resumed.status).toBe("suspended_approval");
    expect(resumed.active_node).toBe("approval_requested");
    expect(replayed).toEqual(resumed);
    expect(approvalEvents).toHaveLength(1);
  });

  it("does not checkpoint backward when resuming from a running checkpoint", async () => {
    service.initDemoWorkspace();
    const runStore = new RunStore(database);
    const run = runStore.create(
      RunSchema.parse({
        id: RUN_ID,
        workspace_id: WORKSPACE_ID,
        status: "running",
        active_node: "coordinator_invoked",
        suspended_approval_id: null,
        created_at: "2026-05-27T15:20:01Z",
        updated_at: "2026-05-27T15:20:03Z",
      }),
    );
    const eventStore = new EventStore(database);
    eventStore.append({
      workspace_id: WORKSPACE_ID,
      run_id: RUN_ID,
      kind: "run.started",
      actor: "spine",
      payload: EventPayloadSchema.parse({ data: { run_id: RUN_ID }, refs: [RUN_ID] }),
      idempotency_key: `${RUN_ID}:run_started`,
    });
    eventStore.append({
      workspace_id: WORKSPACE_ID,
      run_id: RUN_ID,
      kind: "work.created",
      actor: "spine",
      payload: EventPayloadSchema.parse({
        data: { work_item_id: WORK_ITEM_ID },
        refs: [WORK_ITEM_ID],
      }),
      idempotency_key: `${RUN_ID}:work_created`,
    });
    const coordinatorEvent = eventStore.append({
      workspace_id: WORKSPACE_ID,
      run_id: RUN_ID,
      kind: "agent.invoked",
      actor: "spine",
      payload: EventPayloadSchema.parse({
        data: { agent_id: COORDINATOR_AGENT_ID, objective: "Resume from checkpoint." },
        refs: [COORDINATOR_AGENT_ID, WORK_ITEM_ID],
      }),
      idempotency_key: `${RUN_ID}:coordinator_invoked`,
    });
    new CheckpointStore(database).save({
      run,
      node: "coordinator_invoked",
      state: {
        active_node: "coordinator_invoked",
        suspended_approval_id: null,
        event_ids: [coordinatorEvent.id],
      },
      created_at: "2026-05-27T15:20:03Z",
    });

    const resumed = await service.resumeRun(RUN_ID, { signer: demoSigner() });
    const checkpoints = new CheckpointStore(database).listForRun(WORKSPACE_ID, RUN_ID);
    const nodesAfterSeed = checkpoints.slice(1).map((checkpoint) => checkpoint.node);

    expect(resumed.status).toBe("suspended_approval");
    expect(resumed.active_node).toBe("approval_requested");
    expect(nodesAfterSeed).not.toContain("run_started");
    expect(nodesAfterSeed).not.toContain("work_created");
  });

  it("persists bootstrap org authority and capability registration audit events", () => {
    service.initDemoWorkspace();
    const workspaceEvents = new EventStore(database).listForWorkspace(WORKSPACE_ID);

    expect(new OrganizationStore(database).get(ORG_ID)?.mission).toContain("governed AI work");
    expect(new RoleStore(database).listForWorkspace(WORKSPACE_ID).map((role) => role.id)).toEqual([
      COORDINATOR_ROLE_ID,
      RESEARCHER_ROLE_ID,
    ]);
    expect(new AgentStore(database).listForWorkspace(WORKSPACE_ID)).toHaveLength(2);
    expect(new CapabilityStore(database).get(WORKSPACE_ID, "mock.research_lookup")).not.toBeNull();
    expect(workspaceEvents.map((event) => event.kind)).toEqual([
      "workspace.created",
      "org.created",
      "capability.registered",
    ]);
  });

  it("can resume after an approval was applied outside the spine", async () => {
    await service.startDemo();
    new ApprovalService(database).approve(PROMOTION_APPROVAL_ID, {
      workspace_id: WORKSPACE_ID,
      signer: demoSigner(),
    });
    const running = new RunStore(database).get(RUN_ID);

    const completed = service.resumeDemo(PROMOTION_APPROVAL_ID, { signer: demoSigner() });

    expect(running?.status).toBe("running");
    expect(completed.status).toBe("completed");
  });

  it("continues approved capability resume to the next approval boundary", async () => {
    new WorkspaceStore(database).save(
      WorkspaceSchema.parse({
        id: WORKSPACE_ID,
        name: "Acme Learning Lab Workspace",
        created_at: "2026-05-27T15:20:00Z",
        default_org_id: ORG_ID,
      }),
    );
    new CapabilityStore(database).save(
      CapabilitySchema.parse({
        name: "mock.research_lookup",
        workspace_id: WORKSPACE_ID,
        description: "Return seeded information for the onboarding brief demo.",
        canonical_input_schema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
        canonical_output_schema: {
          type: "object",
          properties: { findings: { type: "array", items: { type: "string" } } },
          required: ["findings"],
        },
        providers: ["mock"],
        default_permission: "approval_required",
      }),
    );

    const suspended = await service.startDemo();
    const capabilityApprovalId = `approval_${CAPABILITY_CALL_ID.split("_", 2)[1]}`;
    const resumed = await service.resumeApprovedCapability(capabilityApprovalId, {
      signer: demoSigner(),
      workspace_id: WORKSPACE_ID,
    });
    const replayed = await service.resumeApprovedCapability(capabilityApprovalId, {
      signer: demoSigner(),
      workspace_id: WORKSPACE_ID,
    });
    const events = new EventStore(database).listForRun(WORKSPACE_ID, RUN_ID);
    const checkpoints = new CheckpointStore(database).listForRun(WORKSPACE_ID, RUN_ID);
    const approvalResolvedIndex = checkpoints.findIndex(
      (checkpoint) => checkpoint.node === "approval_resolved",
    );
    const nodesAfterApprovalResolution = checkpoints
      .slice(approvalResolvedIndex + 1)
      .map((checkpoint) => checkpoint.node);

    expect(suspended.status).toBe("suspended_approval");
    expect(suspended.approval_id).toBe(capabilityApprovalId);
    expect(resumed.status).toBe("suspended_approval");
    expect(resumed.approval_id).toBe(PROMOTION_APPROVAL_ID);
    expect(replayed).toEqual(resumed);
    expect(resumed.active_node).toBe("approval_requested");
    expect(events.map((event) => event.kind)).toEqual(
      expect.arrayContaining(["capability.completed", "memory.promotion_proposed"]),
    );
    expect(approvalResolvedIndex).toBeGreaterThanOrEqual(0);
    expect(nodesAfterApprovalResolution[0]).toBe("capability_called");
    expect(nodesAfterApprovalResolution).not.toContain("run_started");
    expect(nodesAfterApprovalResolution).not.toContain("work_created");
  });

  it("refuses capability approval resume outside the selected workspace", async () => {
    service.initDemoWorkspace();
    new RunStore(database).create(
      RunSchema.parse({
        id: RUN_ID,
        workspace_id: WORKSPACE_ID,
        status: "running",
        active_node: "run_started",
        suspended_approval_id: null,
        created_at: "2026-05-27T15:20:01Z",
        updated_at: "2026-05-27T15:20:02Z",
      }),
    );
    const approval = new ApprovalService(database).request({
      approval_id: "approval_22222222222222222222222222222222",
      workspace_id: WORKSPACE_ID,
      run_id: RUN_ID,
      action: "capability.call",
      requested_by: "agent_66666666666666666666666666666666",
      payload: ApprovalPayloadSchema.parse({
        target_type: "capability_call",
        target_id: "capcall_22222222222222222222222222222222",
        reason: "Needs operator approval.",
      }),
      on_approve: "resume_run",
      on_reject: "fail_run",
    });

    await expect(
      service.resumeApprovedCapability(approval.id, {
        signer: demoSigner(),
        workspace_id: "ws_22222222222222222222222222222222",
      }),
    ).rejects.toThrow("approval does not belong to workspace");
  });

  it("records failed terminal audit evidence when approval is rejected", async () => {
    await service.startDemo();

    new ApprovalService(database).reject(PROMOTION_APPROVAL_ID, {
      workspace_id: WORKSPACE_ID,
      signer: demoSigner(),
    });
    const run = new RunStore(database).get(RUN_ID);
    const events = new EventStore(database).listForRun(WORKSPACE_ID, RUN_ID);
    const trace = new TraceStore(database)
      .listForRun(RUN_ID)
      .find((item) => item.node === "approval_rejected");
    const checkpoint = new CheckpointStore(database).latest(WORKSPACE_ID, RUN_ID);

    expect(run?.status).toBe("failed");
    expect(events.map((event) => event.kind)).toEqual(
      expect.arrayContaining(["approval.rejected", "memory.promotion_rejected", "run.failed"]),
    );
    expect(trace?.event_ids).toContain(events.find((event) => event.kind === "run.failed")?.id);
    expect(checkpoint?.node).toBe("approval_rejected");
    expect(checkpoint?.run_status).toBe("failed");
  });

  it("feeds the world model projection", async () => {
    await service.startDemo();
    const suspended = new WorldModelService(database).rebuild(WORKSPACE_ID, RUN_ID);
    service.resumeDemo(null, { signer: demoSigner() });
    const completed = new WorldModelService(database).rebuild(WORKSPACE_ID, RUN_ID);

    expect(suspended.latest_run_status).toBe("suspended_approval");
    expect(suspended.pending_approvals).toEqual([PROMOTION_APPROVAL_ID]);
    expect(completed.latest_run_status).toBe("completed");
    expect(completed.pending_approvals).toEqual([]);
    expect(completed.active_work).toEqual([]);
  });
});
