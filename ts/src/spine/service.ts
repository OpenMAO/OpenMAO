import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import {
  type CapabilityInvocation,
  CapabilityRegistryService,
  MockProvider,
} from "../capabilities/index.js";
import {
  AgentSchema,
  type ApprovalRequest,
  type Artifact,
  ArtifactSchema,
  CapabilityCallSchema,
  type CapabilityResult,
  CapabilitySchema,
  CostSchema,
  EventPayloadSchema,
  GoalSchema,
  MemoryEntrySchema,
  MemoryScopeSchema,
  NodeEffectSchema,
  OrganizationSchema,
  type PolicyDecision,
  PromotionCandidateSchema,
  RoleSchema,
  type Run,
  RunSchema,
  type RunStatus,
  type TaskEnvelope,
  TaskEnvelopeSchema,
  TraceSchema,
  utcNow,
  WorkItemSchema,
  WorkspaceSchema,
} from "../contracts/index.js";
import { ApprovalService, GovernanceService } from "../governance/index.js";
import { PromotionService } from "../memory/index.js";
import { OrgRegistry } from "../org/index.js";
import {
  AgentStore,
  ArtifactStore,
  CapabilityStore,
  CheckpointStore,
  type Database,
  EventStore,
  GoalStore,
  MemoryEntryStore,
  NodeEffectStore,
  OrganizationStore,
  PromotionCandidateStore,
  RoleStore,
  RunStore,
  TaskEnvelopeStore,
  TraceStore,
  WorkItemConflictError,
  WorkItemStore,
  WorkspaceStore,
} from "../persistence/index.js";
import { jsonEqual } from "../persistence/serialization.js";

export const WORKSPACE_ID = "ws_11111111111111111111111111111111";
export const ORG_ID = "org_22222222222222222222222222222222";
export const COORDINATOR_ROLE_ID = "role_33333333333333333333333333333333";
export const RESEARCHER_ROLE_ID = "role_44444444444444444444444444444444";
export const COORDINATOR_AGENT_ID = "agent_55555555555555555555555555555555";
export const RESEARCHER_AGENT_ID = "agent_66666666666666666666666666666666";
export const GOAL_ID = "goal_77777777777777777777777777777777";
export const WORK_ITEM_ID = "work_88888888888888888888888888888888";
export const RUN_ID = "run_99999999999999999999999999999999";
export const TASK_ID = "task_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
export const CAPABILITY_CALL_ID = "capcall_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
export const ARTIFACT_ID = "artifact_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
export const RESEARCHER_MEMORY_ID = "mem_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
export const COORDINATOR_MEMORY_ID = "mem_dddddddddddddddddddddddddddddddd";
export const PROMOTION_CANDIDATE_ID = "promo_cccccccccccccccccccccccccccccccc";
export const PROMOTION_APPROVAL_ID = "approval_11111111111111111111111111111111";
export const DENY_RUN_ID = "run_ffffffffffffffffffffffffffffffff";
export const DENY_TASK_ID = "task_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
export const DENY_CAPABILITY_CALL_ID = "capcall_cccccccccccccccccccccccccccccccc";
export const DENY_CAPABILITY_NAME = "mock.admin_export";

const ARTIFACT_CONTENT_REF = "artifacts/onboarding_brief.md";
const RUN_CREATED_AT = "2026-05-27T15:20:01Z";
const DENY_RUN_CREATED_AT = "2026-05-27T15:22:00Z";
const MEMORY_CREATED_AT = "2026-05-27T15:20:05Z";
const PROMOTION_CREATED_AT = "2026-05-27T15:20:06Z";
const SPINE_NODE_ORDER = [
  "run_started",
  "work_created",
  "coordinator_invoked",
  "handoff_requested",
  "handoff_to_researcher",
  "researcher_invoked",
  "approval_requested",
  "approval_resolved",
  "capability_called",
  "artifact_created",
  "coordinator_finalized",
  "individual_memory_written",
  "collective_memory_written",
  "work_completed",
  "run_completed",
] as const;
const SPINE_NODE_RANK = new Map<string, number>(
  SPINE_NODE_ORDER.map((node, index) => [node, index]),
);

export type SpineRunResult = {
  workspace_id: string;
  run_id: string;
  status: RunStatus;
  active_node: string | null;
  approval_id?: string | null;
  artifact_id?: string | null;
  promotion_candidate_id?: string | null;
  collective_memory_id?: string | null;
};

export type DenyDemoEvent = {
  kind: string;
  actor: string;
  run_id: string | null;
  note: string | null;
};

export type DenyDemoResult = {
  workspace_id: string;
  promotion_leg: {
    run_id: string;
    status: RunStatus;
    active_node: string | null;
    approval_id: string;
    approval_status: ApprovalRequest["status"];
  };
  blocked_leg: {
    run_id: string;
    status: RunStatus;
    capability_name: string;
    call_id: string;
    decision_outcome: PolicyDecision["outcome"];
    reason: string;
    result_status: CapabilityResult["status"];
  };
  events: DenyDemoEvent[];
};

export class SpineServiceError extends Error {}

export class SpineService {
  private readonly runs: RunStore;
  private readonly events: EventStore;
  private readonly traces: TraceStore;
  private readonly effects: NodeEffectStore;
  private readonly artifacts: ArtifactStore;
  private readonly memoryEntries: MemoryEntryStore;
  private readonly promotionCandidates: PromotionCandidateStore;
  private readonly tasks: TaskEnvelopeStore;
  private readonly workItems: WorkItemStore;
  private readonly checkpoints: CheckpointStore;

  constructor(
    private readonly database: Database,
    private readonly options: {
      artifact_dir?: string | null;
      collective_memory_dir?: string | null;
    } = {},
  ) {
    this.runs = new RunStore(database);
    this.events = new EventStore(database);
    this.traces = new TraceStore(database);
    this.effects = new NodeEffectStore(database);
    this.artifacts = new ArtifactStore(database);
    this.memoryEntries = new MemoryEntryStore(database);
    this.promotionCandidates = new PromotionCandidateStore(database);
    this.tasks = new TaskEnvelopeStore(database);
    this.workItems = new WorkItemStore(database);
    this.checkpoints = new CheckpointStore(database);
  }

  initDemoWorkspace(): string {
    this.persistDefaultOrg();
    return WORKSPACE_ID;
  }

  async startDemo(): Promise<SpineRunResult> {
    const registry = this.persistDefaultOrg();
    const existing = this.runs.get(RUN_ID);
    if (existing && ["suspended_approval", "completed", "failed"].includes(existing.status)) {
      return this.resultFromRun(existing);
    }

    let run = existing;
    if (!run) {
      run = this.runs.create(
        RunSchema.parse({
          id: RUN_ID,
          workspace_id: WORKSPACE_ID,
          status: "queued",
          active_node: null,
          suspended_approval_id: null,
          created_at: RUN_CREATED_AT,
          updated_at: RUN_CREATED_AT,
        }),
      );
    }
    if (run.status === "queued") {
      run = this.runs.setStatus(run.id, "running", {
        active_node: "run_started",
        updated_at: RUN_CREATED_AT,
      });
    }
    if (run.status !== "running") {
      return this.resultFromRun(run);
    }

    return await this.runUntilPromotionApproval(run, registry);
  }

  async resumeRun(runId: string, input: { actor?: string | null } = {}): Promise<SpineRunResult> {
    if (runId !== RUN_ID) {
      throw new SpineServiceError(`unknown v0 demo run: ${runId}`);
    }

    const registry = this.persistDefaultOrg();
    let run = this.runs.get(runId);
    if (!run || run.status === "queued") {
      return await this.startDemo();
    }
    if (run.status === "completed") {
      return this.resultFromRun(run);
    }
    if (run.status === "failed") {
      throw new SpineServiceError(`demo run has failed: ${run.id}`);
    }

    const approval = new ApprovalService(this.database).approvals.get(PROMOTION_APPROVAL_ID);
    if (approval && this.isDemoPromotionApproval(approval)) {
      if (approval.status === "approved") {
        return this.resumeDemo(approval.id, input);
      }
      if (approval.status === "rejected") {
        return this.resultFromRun(
          this.failRun(run, "approval_rejected", "demo promotion approval was rejected", [
            approval.id,
          ]),
        );
      }
      if (run.status === "running") {
        run = this.runs.setStatus(run.id, "suspended_approval", {
          active_node: "approval_requested",
          suspended_approval_id: approval.id,
        });
      }
      this.ensureTrace(run, "approval_requested", [`${approval.id}:requested`]);
      return this.resultFromRun(run);
    }

    if (run.status === "running") {
      return await this.resumeRunningRun(run, registry);
    }

    const suspendedApprovalId = run.suspended_approval_id;
    if (!suspendedApprovalId) {
      throw new SpineServiceError(`suspended demo run has no approval id: ${run.id}`);
    }
    const suspendedApproval = new ApprovalService(this.database).approvals.get(suspendedApprovalId);
    if (!suspendedApproval) {
      throw new SpineServiceError(`demo approval not found: ${suspendedApprovalId}`);
    }
    if (suspendedApproval.payload.target_type === "capability_call") {
      if (suspendedApproval.status === "approved") {
        return await this.resumeApprovedCapability(suspendedApproval.id, {
          actor: input.actor ?? null,
          workspace_id: run.workspace_id,
        });
      }
      if (suspendedApproval.status === "rejected") {
        return this.resultFromRun(
          this.failRun(run, "approval_rejected", "capability approval was rejected", [
            suspendedApproval.id,
          ]),
        );
      }
      this.ensureTrace(run, "approval_requested", [`${suspendedApproval.id}:requested`]);
      return this.resultFromRun(run);
    }
    if (!this.isDemoPromotionApproval(suspendedApproval)) {
      throw new SpineServiceError(
        `approval does not target the demo promotion: ${suspendedApproval.id}`,
      );
    }
    if (suspendedApproval.status === "approved") {
      return this.resumeDemo(suspendedApproval.id, input);
    }
    if (suspendedApproval.status === "rejected") {
      return this.resultFromRun(
        this.failRun(run, "approval_rejected", "demo promotion approval was rejected", [
          suspendedApproval.id,
        ]),
      );
    }
    this.ensureTrace(run, "approval_requested", [`${suspendedApproval.id}:requested`]);
    return this.resultFromRun(run);
  }

  async resumeApprovedCapability(
    approvalId: string,
    input: { actor?: string | null; workspace_id: string },
  ): Promise<SpineRunResult> {
    let approval = new ApprovalService(this.database).approvals.get(approvalId);
    if (!approval) {
      throw new SpineServiceError(`approval request not found: ${approvalId}`);
    }
    if (approval.workspace_id !== input.workspace_id) {
      throw new SpineServiceError(`approval does not belong to workspace: ${approvalId}`);
    }
    if (approval.payload.target_type !== "capability_call") {
      throw new SpineServiceError(`approval does not target a capability call: ${approvalId}`);
    }
    if (!approval.run_id) {
      throw new SpineServiceError(`capability approval is not run-bound: ${approvalId}`);
    }
    const approvalRunId = approval.run_id;
    if (approvalRunId !== RUN_ID) {
      throw new SpineServiceError(`unknown v0 demo run: ${approvalRunId}`);
    }
    const registry = this.persistDefaultOrg();
    if (approval.status === "pending") {
      approval = new ApprovalService(this.database).approve(approval.id, {
        workspace_id: approval.workspace_id,
        actor: input.actor ?? null,
      });
    }
    if (approval.status === "rejected") {
      const run = this.runs.get(approvalRunId);
      if (!run) {
        throw new SpineServiceError(`capability approval run not found: ${approvalRunId}`);
      }
      return this.resultFromRun(
        this.failRun(run, "approval_rejected", "capability approval was rejected", [approval.id]),
      );
    }
    if (approval.status !== "approved") {
      throw new SpineServiceError(`capability approval is not approved: ${approval.id}`);
    }

    let run = this.runs.get(approvalRunId);
    if (!run) {
      throw new SpineServiceError(`capability approval run not found: ${approvalRunId}`);
    }
    if (
      run.status === "completed" ||
      (run.status === "suspended_approval" && run.suspended_approval_id !== approval.id)
    ) {
      return this.resultFromRun(run);
    }

    const invocation = await new CapabilityRegistryService(
      this.database,
      new GovernanceService(this.database, registry),
      [new MockProvider()],
    ).resumeApprovedCall(approval.id, { workspace_id: approval.workspace_id });
    run = this.runs.get(approvalRunId);
    if (!run) {
      throw new SpineServiceError(`capability approval run not found: ${approvalRunId}`);
    }
    if (!invocation.result) {
      return this.resultFromRun(run);
    }
    if (invocation.result.status !== "ok") {
      return this.resultFromRun(
        this.failRun(run, "capability_failed", "approved capability did not complete", [
          invocation.call.id,
          invocation.result.id,
        ]),
      );
    }
    run = this.runs.get(run.id) ?? run;
    return await this.runUntilPromotionApproval(run, registry, "capability_called");
  }

  resumeDemo(approvalId?: string | null, input: { actor?: string | null } = {}): SpineRunResult {
    let run = this.runs.get(RUN_ID);
    if (!run) {
      throw new SpineServiceError("demo run has not been started");
    }
    if (run.status === "completed") {
      return this.resultFromRun(run);
    }
    if (run.status === "failed") {
      throw new SpineServiceError(`demo run has failed: ${run.id}`);
    }

    const resolvedApprovalId = approvalId ?? run.suspended_approval_id ?? PROMOTION_APPROVAL_ID;
    let approval = new ApprovalService(this.database).approvals.get(resolvedApprovalId);
    if (!approval) {
      throw new SpineServiceError(`demo approval not found: ${resolvedApprovalId}`);
    }
    if (
      approval.payload.target_type !== "promotion_candidate" ||
      approval.payload.target_id !== PROMOTION_CANDIDATE_ID
    ) {
      throw new SpineServiceError(`approval does not target the demo promotion: ${approval.id}`);
    }

    if (run.status === "suspended_approval") {
      approval = new ApprovalService(this.database).approve(resolvedApprovalId, {
        workspace_id: WORKSPACE_ID,
        actor: input.actor ?? null,
      });
      run = this.runs.get(RUN_ID);
      if (!run) {
        throw new SpineServiceError(`demo run disappeared after approval: ${RUN_ID}`);
      }
    } else if (approval.status !== "approved") {
      throw new SpineServiceError(`demo approval is not approved: ${approval.id}`);
    }

    this.checkpointNode(run, "approval_resolved", [`${resolvedApprovalId}:approved`]);
    const collective = new PromotionService(this.database, {
      collective_memory_dir: this.collectiveMemoryDir(),
      // The deterministic demo ratifies without corroboration on purpose; production promotion
      // (createApprovalServiceWithApplications) uses the default floor of 1.
      min_corroboration: 0,
    }).ratifyAndWriteCollective(PROMOTION_CANDIDATE_ID, {
      workspace_id: WORKSPACE_ID,
      approval_id: resolvedApprovalId,
      resolved_at: approval.resolved_at,
    });
    run = this.runs.get(RUN_ID) ?? run;
    this.checkpointNode(run, "collective_memory_written", [
      `${PROMOTION_CANDIDATE_ID}:collective_written`,
    ]);
    this.completeWorkItem(run);
    const completed = this.completeDemoRun();
    return { ...this.resultFromRun(completed), collective_memory_id: collective.id };
  }

  async denyDemo(input: { actor?: string | null } = {}): Promise<DenyDemoResult> {
    const registry = this.persistDefaultOrg();
    const approvalService = new ApprovalService(this.database);

    // Leg 1: the rejection leg of the same durable approval that demo-approve
    // resolves. An approval resolves exactly once, so each state dir shows one
    // leg; seeing the other requires a fresh state dir.
    let run = this.runs.get(RUN_ID);
    if (!run || run.status === "queued" || run.status === "running") {
      await this.startDemo();
      run = this.runs.get(RUN_ID);
    }
    if (!run) {
      throw new SpineServiceError("demo run could not be started");
    }
    if (run.status === "completed") {
      throw new SpineServiceError(
        "demo run is already completed: the promotion approval was approved. " +
          "demo-deny rejects that same durable approval, so it needs a fresh state dir " +
          "(delete .openmao/ or point OPENMAO_DB at a new file).",
      );
    }
    let approval = approvalService.approvals.get(PROMOTION_APPROVAL_ID);
    if (!approval) {
      throw new SpineServiceError(`demo approval not found: ${PROMOTION_APPROVAL_ID}`);
    }
    if (run.status === "suspended_approval") {
      approval = approvalService.reject(PROMOTION_APPROVAL_ID, {
        workspace_id: WORKSPACE_ID,
        actor: input.actor ?? null,
      });
      run = this.runs.get(RUN_ID) ?? run;
    } else if (approval.status !== "rejected") {
      throw new SpineServiceError(
        `demo run already failed without a rejected approval: ${run.id}; ` +
          "demo-deny needs a fresh state dir",
      );
    }
    if (run.status !== "failed") {
      throw new SpineServiceError(`rejected demo run did not fail: ${run.id}`);
    }

    // Leg 2: deny-by-default. The researcher invokes a capability that is
    // registered in the workspace but was never granted to its role; the
    // gateway blocks it before any provider runs, and the block is recorded.
    const invocation = await this.runBlockedCapabilityDemo(registry);
    const blockedRun = this.runs.get(DENY_RUN_ID);
    if (!blockedRun) {
      throw new SpineServiceError(`deny demo run not found: ${DENY_RUN_ID}`);
    }
    const result = invocation.result;
    if (result?.status !== "blocked") {
      throw new SpineServiceError("deny demo capability call was not blocked");
    }

    const events = [
      this.eventSummary(`${PROMOTION_APPROVAL_ID}:rejected`),
      this.eventSummary(`${PROMOTION_APPROVAL_ID}:run.failed`),
      this.eventSummary(`${DENY_CAPABILITY_CALL_ID}:policy_decision`),
      this.eventSummary(`${DENY_CAPABILITY_CALL_ID}:blocked`),
      this.eventSummary(`${DENY_RUN_ID}:capability_blocked:run_failed`),
    ].filter((event): event is DenyDemoEvent => event !== null);

    return {
      workspace_id: WORKSPACE_ID,
      promotion_leg: {
        run_id: RUN_ID,
        status: run.status,
        active_node: run.active_node,
        approval_id: approval.id,
        approval_status: approval.status,
      },
      blocked_leg: {
        run_id: DENY_RUN_ID,
        status: blockedRun.status,
        capability_name: DENY_CAPABILITY_NAME,
        call_id: invocation.call.id,
        decision_outcome: invocation.decision.outcome,
        reason: invocation.decision.reason,
        result_status: result.status,
      },
      events,
    };
  }

  private async runBlockedCapabilityDemo(registry: OrgRegistry): Promise<CapabilityInvocation> {
    const capabilityRegistry = new CapabilityRegistryService(
      this.database,
      new GovernanceService(this.database, registry),
      [new MockProvider()],
    );
    let run = this.runs.get(DENY_RUN_ID);
    if (!run) {
      run = this.runs.create(
        RunSchema.parse({
          id: DENY_RUN_ID,
          workspace_id: WORKSPACE_ID,
          status: "queued",
          active_node: null,
          suspended_approval_id: null,
          created_at: DENY_RUN_CREATED_AT,
          updated_at: DENY_RUN_CREATED_AT,
        }),
      );
    }
    if (run.status === "queued") {
      run = this.runs.setStatus(run.id, "running", {
        active_node: "run_started",
        updated_at: DENY_RUN_CREATED_AT,
      });
      this.recordNode(run, "run_started", "run.started", { run_id: run.id }, [run.id]);
      run = this.runs.get(run.id) ?? run;
    }

    // The task envelope references the deny run, so it can only be saved once
    // the run row exists. Capability registration is idempotent alongside it.
    this.database.transaction(() => {
      if (!new CapabilityStore(this.database).get(WORKSPACE_ID, DENY_CAPABILITY_NAME)) {
        capabilityRegistry.register(CapabilitySchema.parse(denyCapability()));
      }
      this.tasks.save(TaskEnvelopeSchema.parse(denyTaskEnvelope()));
    });

    // A new capability call requires a running run; replaying an existing call
    // returns its recorded result without that check, which keeps this leg
    // idempotent after the deny run has been failed.
    const invocation = await capabilityRegistry.invoke(this.denyCapabilityCall());
    run = this.runs.get(DENY_RUN_ID) ?? run;
    if (run.status === "running" && invocation.result?.status === "blocked") {
      this.failRun(
        run,
        "capability_blocked",
        invocation.decision.reason,
        [invocation.call.id, invocation.result.id],
        { policy_decision: invocation.decision },
      );
    }
    return invocation;
  }

  private denyCapabilityCall() {
    return CapabilityCallSchema.parse({
      id: DENY_CAPABILITY_CALL_ID,
      workspace_id: WORKSPACE_ID,
      run_id: DENY_RUN_ID,
      capability_name: DENY_CAPABILITY_NAME,
      provider: "mock",
      input: { format: "csv" },
      requested_by: RESEARCHER_AGENT_ID,
      task_id: DENY_TASK_ID,
      risk_level: "low",
      idempotency_key: `${DENY_RUN_ID}:admin_export`,
    });
  }

  private eventSummary(idempotencyKey: string): DenyDemoEvent | null {
    const event = this.events.getByIdempotencyKey(WORKSPACE_ID, idempotencyKey);
    if (!event) {
      return null;
    }
    const data = event.payload.data;
    const decision = data.policy_decision as { reason?: unknown } | undefined;
    const reason = typeof data.reason === "string" ? data.reason : decision?.reason;
    return {
      kind: event.kind,
      actor: event.actor,
      run_id: event.run_id,
      note: typeof reason === "string" ? reason : null,
    };
  }

  private async resumeRunningRun(run: Run, registry: OrgRegistry): Promise<SpineRunResult> {
    const checkpoint = this.checkpoints.latest(run.workspace_id, run.id);
    if (!checkpoint) {
      return await this.runUntilPromotionApproval(run, registry);
    }

    const checkpointed = this.runs.setStatus(run.id, "running", {
      active_node: checkpoint.node,
    });
    return await this.runUntilPromotionApproval(checkpointed, registry, checkpoint.node);
  }

  private async runUntilPromotionApproval(
    run: Run,
    registry: OrgRegistry,
    resumeFloorNode: string | null = null,
  ): Promise<SpineRunResult> {
    const workItem = WorkItemSchema.parse(defaultWorkItem());
    this.recordNode(
      run,
      "run_started",
      "run.started",
      { run_id: run.id },
      [run.id],
      resumeFloorNode,
    );
    run = this.runs.get(run.id) ?? run;
    this.recordNode(
      run,
      "work_created",
      "work.created",
      { work_item: workItem },
      [workItem.id],
      resumeFloorNode,
    );
    run = this.runs.get(run.id) ?? run;
    this.recordNode(
      run,
      "coordinator_invoked",
      "agent.invoked",
      { agent_id: COORDINATOR_AGENT_ID, objective: workItem.objective },
      [COORDINATOR_AGENT_ID, workItem.id],
      resumeFloorNode,
    );

    run = this.runs.get(run.id) ?? run;
    this.recordNode(
      run,
      "handoff_requested",
      "handoff.requested",
      {
        from_agent_id: COORDINATOR_AGENT_ID,
        to_agent_id: RESEARCHER_AGENT_ID,
        work_item_id: workItem.id,
      },
      [COORDINATOR_AGENT_ID, RESEARCHER_AGENT_ID, workItem.id],
      resumeFloorNode,
    );
    run = this.runs.get(run.id) ?? run;
    const governance = new GovernanceService(this.database, registry);
    const decision = governance.checkHandoff({
      workspace_id: WORKSPACE_ID,
      from_agent_id: COORDINATOR_AGENT_ID,
      to_agent_id: RESEARCHER_AGENT_ID,
      run_id: run.id,
    });
    if (decision.outcome !== "allow") {
      return this.resultFromRun(
        this.failRun(run, "handoff_blocked", decision.reason, [decision.id], {
          policy_decision: decision,
        }),
      );
    }

    const task = this.saveDemoTask();
    run = this.runs.get(run.id) ?? run;
    this.recordNode(
      run,
      "handoff_to_researcher",
      "handoff.completed",
      { task_envelope: task, policy_decision: decision },
      [task.id, decision.id],
      resumeFloorNode,
    );
    run = this.runs.get(run.id) ?? run;
    this.recordNode(
      run,
      "researcher_invoked",
      "agent.invoked",
      { agent_id: RESEARCHER_AGENT_ID, task_id: task.id },
      [RESEARCHER_AGENT_ID, task.id],
      resumeFloorNode,
    );

    const capabilityInvocation = await new CapabilityRegistryService(this.database, governance, [
      new MockProvider(),
    ]).invoke(this.demoCapabilityCall());
    if (!capabilityInvocation.result) {
      return this.resultFromRun(this.runs.get(run.id) ?? run);
    }
    if (capabilityInvocation.result.status !== "ok") {
      return this.resultFromRun(
        this.failRun(
          run,
          "capability_failed",
          capabilityInvocation.result.error ?? "capability did not complete",
          [capabilityInvocation.call.id, capabilityInvocation.result.id],
          {
            capability_call: capabilityInvocation.call,
            capability_result: capabilityInvocation.result,
          },
        ),
      );
    }

    run = this.runs.get(run.id) ?? run;
    this.checkpointCapability(run, capabilityInvocation, resumeFloorNode);
    const artifact = this.writeArtifact(task, capabilityInvocation.result);
    run = this.runs.get(run.id) ?? run;
    this.recordNode(
      run,
      "artifact_created",
      "artifact.created",
      { artifact },
      [artifact.id],
      resumeFloorNode,
    );
    run = this.runs.get(run.id) ?? run;
    this.recordNode(
      run,
      "coordinator_finalized",
      "agent.completed",
      { agent_id: COORDINATOR_AGENT_ID, artifact_id: artifact.id },
      [COORDINATOR_AGENT_ID, artifact.id],
      resumeFloorNode,
    );

    const individualMemories = this.writeIndividualMemory(task, artifact);
    run = this.runs.get(run.id) ?? run;
    this.checkpointNode(
      run,
      "individual_memory_written",
      individualMemories.map((memory) => `${memory.id}:individual_written`),
      resumeFloorNode,
    );

    const proposal = new PromotionService(this.database, {
      collective_memory_dir: this.collectiveMemoryDir(),
    }).propose(PromotionCandidateSchema.parse(defaultPromotionCandidate()), {
      requested_by: COORDINATOR_AGENT_ID,
      run_id: run.id,
      approval_id: PROMOTION_APPROVAL_ID,
    });
    run = this.runs.get(run.id) ?? run;
    this.ensureTrace(run, "approval_requested", [`${proposal.approval_id}:requested`]);
    return this.resultFromRun(this.runs.get(run.id) ?? run, {
      approval_id: proposal.approval_id,
      artifact_id: artifact.id,
      promotion_candidate_id: proposal.candidate.id,
    });
  }

  private persistDefaultOrg(): OrgRegistry {
    const organization = OrganizationSchema.parse(defaultOrganization());
    const roles = [defaultCoordinatorRole(), defaultResearcherRole()];
    const agents = [defaultCoordinatorAgent(), defaultResearcherAgent()];
    const registry = new OrgRegistry({
      roles,
      agents,
      communication: { coordinator: ["researcher"], researcher: ["coordinator"] },
    });
    this.database.transaction(() => {
      const workspace = new WorkspaceStore(this.database).save(
        WorkspaceSchema.parse(defaultWorkspace()),
      );
      new OrganizationStore(this.database).save(organization);
      const roleStore = new RoleStore(this.database);
      for (const role of roles) {
        roleStore.save(role);
      }
      const agentStore = new AgentStore(this.database);
      for (const agent of agents) {
        agentStore.save(agent);
      }
      new GoalStore(this.database).save(GoalSchema.parse(defaultGoal()));
      // Re-entrant seeding: the demo run mutates this work item (e.g. status -> "done"), so a
      // second init must adopt the existing item instead of re-saving the pristine fixture.
      // Adoption requires fixture identity: `status` is the only field the demo lifecycle
      // mutates (completeWorkItem -> setStatus(WORK_ITEM_ID, "done")), so an existing row
      // that differs from defaultWorkItem() in any other field is a foreign work item
      // occupying the demo id and must surface as a conflict, not be silently adopted.
      const workItemStore = new WorkItemStore(this.database);
      const fixtureWorkItem = WorkItemSchema.parse(defaultWorkItem());
      const existingWorkItem = workItemStore.get(WORK_ITEM_ID);
      if (!existingWorkItem) {
        workItemStore.save(fixtureWorkItem);
      } else {
        const { status: _existingStatus, ...existingImmutable } = existingWorkItem;
        const { status: _fixtureStatus, ...fixtureImmutable } = fixtureWorkItem;
        if (!jsonEqual(existingImmutable, fixtureImmutable)) {
          throw new WorkItemConflictError(
            `work item already exists and does not match the demo fixture: ${WORK_ITEM_ID}`,
          );
        }
      }
      this.events.append({
        workspace_id: workspace.id,
        kind: "workspace.created",
        actor: "spine",
        payload: EventPayloadSchema.parse({ data: { workspace }, refs: [workspace.id] }),
        idempotency_key: `${workspace.id}:created`,
      });
      this.events.append({
        workspace_id: workspace.id,
        kind: "org.created",
        actor: "spine",
        payload: EventPayloadSchema.parse({
          data: { organization, roles, agents },
          refs: [
            organization.id,
            ...roles.map((role) => role.id),
            ...agents.map((agent) => agent.id),
          ],
        }),
        idempotency_key: `${organization.id}:created`,
      });
      const capabilityStore = new CapabilityStore(this.database);
      if (!capabilityStore.get(WORKSPACE_ID, "mock.research_lookup")) {
        new CapabilityRegistryService(
          this.database,
          new GovernanceService(this.database, registry),
          [new MockProvider()],
        ).register(CapabilitySchema.parse(defaultCapability()));
      }
    });
    return registry;
  }

  private saveDemoTask(): TaskEnvelope {
    return this.tasks.save(TaskEnvelopeSchema.parse(defaultTaskEnvelope()));
  }

  private demoCapabilityCall() {
    return CapabilityCallSchema.parse({
      id: CAPABILITY_CALL_ID,
      workspace_id: WORKSPACE_ID,
      run_id: RUN_ID,
      capability_name: "mock.research_lookup",
      provider: "mock",
      input: { query: "onboarding brief" },
      requested_by: RESEARCHER_AGENT_ID,
      task_id: TASK_ID,
      risk_level: "low",
      idempotency_key: `${RUN_ID}:research_lookup`,
    });
  }

  private writeArtifact(task: TaskEnvelope, result: CapabilityResult): Artifact {
    const findings = result.output.findings;
    if (!Array.isArray(findings) || !findings.every((finding) => typeof finding === "string")) {
      throw new SpineServiceError("mock research output did not include string findings");
    }
    const content = [
      "# Onboarding Brief",
      "",
      "## Assumptions",
      "",
      "- The new member needs a short, reliable starting point.",
      "- The demo uses deterministic mock research.",
      "",
      "## Findings",
      "",
      ...findings.map((finding) => `- ${finding}`),
      "",
    ].join("\n");
    const contentHash = createHash("sha256").update(content).digest("hex");
    const effect = this.ensureArtifactFileAndEffect(content, contentHash);
    return this.artifacts.save(
      ArtifactSchema.parse({
        id: ARTIFACT_ID,
        workspace_id: WORKSPACE_ID,
        type: "markdown",
        content_ref: ARTIFACT_CONTENT_REF,
        produced_by: COORDINATOR_AGENT_ID,
        task_id: task.id,
        created_at: effect.created_at,
        content_hash: contentHash,
      }),
    );
  }

  private ensureArtifactFile(content: string, contentHash: string): void {
    mkdirSync(this.artifactDir(), { recursive: true });
    const path = this.artifactPath();
    if (existsSync(path)) {
      const existingHash = createHash("sha256").update(readFileSync(path)).digest("hex");
      if (existingHash !== contentHash) {
        throw new SpineServiceError("artifact file already exists with different content");
      }
      return;
    }
    const tempPath = `${path}.tmp`;
    writeFileSync(tempPath, content, "utf8");
    renameSync(tempPath, path);
  }

  private verifyArtifactFile(contentHash: string): void {
    const path = this.artifactPath();
    if (!existsSync(path)) {
      throw new SpineServiceError("artifact node effect exists but artifact file is missing");
    }
    const existingHash = createHash("sha256").update(readFileSync(path)).digest("hex");
    if (existingHash !== contentHash) {
      throw new SpineServiceError("artifact node effect hash does not match stored file content");
    }
  }

  private ensureArtifactFileAndEffect(content: string, contentHash: string) {
    const existing = this.effects.getByKey(RUN_ID, "artifact_created", `${RUN_ID}:artifact`);
    if (existing) {
      if (existing.content_hash !== contentHash) {
        throw new SpineServiceError("artifact node effect hash mismatch");
      }
      this.verifyArtifactFile(contentHash);
      return existing;
    }
    this.ensureArtifactFile(content, contentHash);
    return this.effects.record(
      NodeEffectSchema.parse({
        id: stableId("effect", RUN_ID, "artifact_created"),
        workspace_id: WORKSPACE_ID,
        run_id: RUN_ID,
        node: "artifact_created",
        idempotency_key: `${RUN_ID}:artifact`,
        effect_type: "artifact.write",
        effect_ref: ARTIFACT_ID,
        content_hash: contentHash,
        created_at: utcNow(),
      }),
    );
  }

  private writeIndividualMemory(task: TaskEnvelope, artifact: Artifact) {
    const service = new PromotionService(this.database, {
      collective_memory_dir: this.collectiveMemoryDir(),
    });
    const researcherMemory = service.writeIndividual(
      MemoryEntrySchema.parse({
        id: RESEARCHER_MEMORY_ID,
        workspace_id: WORKSPACE_ID,
        scope: "individual",
        owner_id: RESEARCHER_AGENT_ID,
        kind: "episodic",
        content: "Seeded research found that onboarding briefs should be concise.",
        provenance: {
          agent_id: RESEARCHER_AGENT_ID,
          run_id: RUN_ID,
          task_id: task.id,
          note: `artifact:${artifact.id}`,
        },
        confidence: 0.75,
        status: "confirmed",
        created_at: MEMORY_CREATED_AT,
      }),
    );
    const coordinatorMemory = service.writeIndividual(
      MemoryEntrySchema.parse({
        id: COORDINATOR_MEMORY_ID,
        workspace_id: WORKSPACE_ID,
        scope: "individual",
        owner_id: COORDINATOR_AGENT_ID,
        kind: "semantic",
        content: "New members benefit from a short brief with explicit assumptions.",
        provenance: {
          agent_id: COORDINATOR_AGENT_ID,
          run_id: RUN_ID,
          task_id: task.id,
          note: `artifact:${artifact.id}`,
        },
        confidence: 0.8,
        status: "confirmed",
        created_at: MEMORY_CREATED_AT,
      }),
    );
    return [researcherMemory, coordinatorMemory];
  }

  private checkpointCapability(
    run: Run,
    invocation: CapabilityInvocation,
    resumeFloorNode: string | null = null,
  ): void {
    if (!invocation.result) {
      return;
    }
    const resultEventKey =
      invocation.result.status === "blocked"
        ? `${invocation.call.id}:blocked`
        : `${invocation.call.id}:completed`;
    this.checkpointNode(
      run,
      "capability_called",
      [`${invocation.call.id}:persisted`, resultEventKey],
      resumeFloorNode,
    );
  }

  private checkpointNode(
    run: Run,
    node: string,
    eventIdsOrKeys: string[],
    resumeFloorNode: string | null = null,
  ): void {
    this.database.transaction(() => {
      if (this.isBeforeResumeFloor(resumeFloorNode, node)) {
        return;
      }
      const updated = this.runs.setStatus(run.id, run.status, { active_node: node });
      this.ensureTrace(updated, node, eventIdsOrKeys);
    });
  }

  private recordNode(
    run: Run,
    node: string,
    kind: string,
    data: Record<string, unknown>,
    refs: string[],
    resumeFloorNode: string | null = null,
  ): void {
    this.database.transaction(() => {
      const idempotencyKey = `${run.id}:${node}`;
      const existing = this.events.getByIdempotencyKey(run.workspace_id, idempotencyKey);
      if (this.isBeforeResumeFloor(resumeFloorNode, node)) {
        if (!existing) {
          throw new SpineServiceError(
            `cannot resume before checkpoint without recorded event: ${node}`,
          );
        }
        return;
      }
      if (existing) {
        const updated = this.runs.setStatus(run.id, run.status, { active_node: node });
        this.ensureTrace(updated, node, [existing.id]);
        return;
      }
      const event = this.events.append({
        workspace_id: run.workspace_id,
        run_id: run.id,
        kind,
        actor: "spine",
        payload: EventPayloadSchema.parse({ data, refs }),
        idempotency_key: idempotencyKey,
      });
      const updated = this.runs.setStatus(run.id, run.status, { active_node: node });
      this.ensureTrace(updated, node, [event.id]);
    });
  }

  private ensureTrace(run: Run, node: string, eventIdsOrKeys: string[]): void {
    const eventIds = eventIdsOrKeys.map((eventIdOrKey) => {
      if (eventIdOrKey.includes(":")) {
        return this.events.getByIdempotencyKey(run.workspace_id, eventIdOrKey)?.id ?? eventIdOrKey;
      }
      return eventIdOrKey;
    });
    const trace = this.traces.save(
      TraceSchema.parse({
        id: stableId("trace", run.id, node),
        workspace_id: run.workspace_id,
        run_id: run.id,
        node,
        cost: CostSchema.parse({ provider: "mock", model: "mock" }),
        timestamp: utcNow(),
        event_ids: eventIds,
      }),
    );
    this.checkpoints.save({
      run,
      node,
      state: {
        active_node: run.active_node,
        suspended_approval_id: run.suspended_approval_id,
        event_ids: trace.event_ids,
      },
      created_at: trace.timestamp,
    });
  }

  private isBeforeResumeFloor(resumeFloorNode: string | null, node: string): boolean {
    const currentRank = this.nodeRank(resumeFloorNode);
    const nextRank = this.nodeRank(node);
    return currentRank !== null && nextRank !== null && nextRank < currentRank;
  }

  private nodeRank(node: string | null): number | null {
    if (!node) {
      return null;
    }
    return SPINE_NODE_RANK.get(node) ?? null;
  }

  private completeDemoRun(): Run {
    return this.database.transaction(() => {
      const event = this.events.append({
        workspace_id: WORKSPACE_ID,
        run_id: RUN_ID,
        kind: "run.completed",
        actor: "spine",
        payload: EventPayloadSchema.parse({ data: { run_id: RUN_ID }, refs: [RUN_ID] }),
        idempotency_key: `${RUN_ID}:run_completed_event`,
      });
      const completed = this.runs.setStatus(RUN_ID, "completed", {
        active_node: "run_completed",
      });
      this.ensureTrace(completed, "run_completed", [event.id]);
      return completed;
    });
  }

  private completeWorkItem(run: Run): void {
    this.database.transaction(() => {
      const workItem = this.workItems.setStatus(WORK_ITEM_ID, "done");
      const updated = this.runs.setStatus(run.id, run.status, {
        active_node: "work_completed",
      });
      const event = this.events.append({
        workspace_id: run.workspace_id,
        run_id: run.id,
        kind: "work.completed",
        actor: "spine",
        payload: EventPayloadSchema.parse({ data: { work_item: workItem }, refs: [workItem.id] }),
        idempotency_key: `${WORK_ITEM_ID}:completed`,
      });
      this.ensureTrace(updated, "work_completed", [event.id]);
    });
  }

  private failRun(
    run: Run,
    node: string,
    reason: string,
    refs: string[],
    data: Record<string, unknown> = {},
  ): Run {
    return this.database.transaction(() => {
      const failed = this.runs.setStatus(run.id, "failed", { active_node: node });
      const event = this.events.append({
        workspace_id: failed.workspace_id,
        run_id: failed.id,
        kind: "run.failed",
        actor: "spine",
        payload: EventPayloadSchema.parse({
          data: { run_id: failed.id, reason, ...data },
          refs: [failed.id, ...refs],
        }),
        idempotency_key: `${failed.id}:${node}:run_failed`,
      });
      this.ensureTrace(failed, node, [event.id]);
      return failed;
    });
  }

  private isDemoPromotionApproval(approval: ApprovalRequest): boolean {
    return (
      approval.workspace_id === WORKSPACE_ID &&
      approval.payload.target_type === "promotion_candidate" &&
      approval.payload.target_id === PROMOTION_CANDIDATE_ID
    );
  }

  private resultFromRun(run: Run, extras: Partial<SpineRunResult> = {}): SpineRunResult {
    return {
      workspace_id: run.workspace_id,
      run_id: run.id,
      status: run.status,
      active_node: run.active_node,
      approval_id: run.suspended_approval_id ?? extras.approval_id ?? null,
      artifact_id: this.artifacts.get(ARTIFACT_ID)?.id ?? extras.artifact_id ?? null,
      promotion_candidate_id:
        this.promotionCandidates.get(PROMOTION_CANDIDATE_ID)?.id ??
        extras.promotion_candidate_id ??
        null,
      collective_memory_id:
        this.memoryEntries.get("mem_cccccccccccccccccccccccccccccccc")?.id ??
        extras.collective_memory_id ??
        null,
    };
  }

  private artifactDir(): string {
    return this.options.artifact_dir ?? this.sideEffectDir("artifacts");
  }

  private artifactPath(): string {
    return join(this.artifactDir(), "onboarding_brief.md");
  }

  private collectiveMemoryDir(): string {
    return this.options.collective_memory_dir ?? this.sideEffectDir("collective_memory");
  }

  private sideEffectDir(name: string): string {
    if (this.database.path === ":memory:") {
      return join(".", ".openmao-memory", name);
    }
    const parent = dirname(this.database.path);
    if (basename(parent) === ".openmao" && basename(this.database.path) === "openmao.sqlite3") {
      return join(parent, name);
    }
    return join(parent, `${basename(this.database.path)}.openmao`, name);
  }
}

function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${createHash("sha256").update(parts.join(":")).digest("hex").slice(0, 32)}`;
}

function defaultWorkspace() {
  return {
    id: WORKSPACE_ID,
    name: "Acme Learning Lab Workspace",
    created_at: "2026-05-27T15:20:00Z",
    default_org_id: ORG_ID,
  };
}

function defaultOrganization() {
  return {
    id: ORG_ID,
    workspace_id: WORKSPACE_ID,
    name: "Acme Learning Lab",
    type: "custom",
    mission: "Coordinate a deterministic onboarding brief through governed AI work.",
    vision: "A small AI-native organization with inspectable authority and memory.",
    values: ["accountability", "clarity", "rebuildability"],
    goals: [GOAL_ID],
    policies: ["Collective memory promotion requires approval."],
    autonomy_level: "supervised",
    config_version: "0.1",
  };
}

function defaultGoal() {
  return {
    id: GOAL_ID,
    workspace_id: WORKSPACE_ID,
    objective: "Create a short onboarding brief for a new member.",
    owner_role: COORDINATOR_ROLE_ID,
    success_metrics: ["brief is concise", "assumptions are explicit"],
    constraints: ["no external credentials"],
    status: "active",
  };
}

function defaultWorkItem() {
  return {
    id: WORK_ITEM_ID,
    workspace_id: WORKSPACE_ID,
    title: "Create onboarding brief",
    objective: "Create a short onboarding brief for a new member.",
    owner: COORDINATOR_AGENT_ID,
    reviewer: "human",
    status: "queued",
    priority: "medium",
    success_criteria: ["brief is short", "assumptions are explicit"],
    risk_level: "low",
    approval_gates: ["memory.promote"],
    source: { provider: "openmao" },
    memory_scope: MemoryScopeSchema.parse({ read: ["collective"], write: ["individual"] }),
    evaluation: [],
  };
}

function defaultTaskEnvelope() {
  return {
    id: TASK_ID,
    workspace_id: WORKSPACE_ID,
    run_id: RUN_ID,
    work_item_id: WORK_ITEM_ID,
    from_agent: COORDINATOR_AGENT_ID,
    to_agent: RESEARCHER_AGENT_ID,
    objective: "Gather seeded information for onboarding.",
    context_refs: [],
    allowed_capabilities: ["mock.research_lookup"],
    approval_gates: [],
  };
}

function defaultCapability() {
  return {
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
    default_permission: "enabled",
  };
}

function denyCapability() {
  return {
    name: DENY_CAPABILITY_NAME,
    workspace_id: WORKSPACE_ID,
    description:
      "Export the member directory. Registered for the deny demo and granted to no demo role, so deny-by-default blocks every call.",
    canonical_input_schema: {
      type: "object",
      properties: { format: { type: "string" } },
      required: ["format"],
    },
    canonical_output_schema: {
      type: "object",
      properties: { rows: { type: "array", items: { type: "string" } } },
      required: ["rows"],
    },
    providers: ["mock"],
    default_permission: "enabled",
  };
}

function denyTaskEnvelope() {
  return {
    id: DENY_TASK_ID,
    workspace_id: WORKSPACE_ID,
    run_id: DENY_RUN_ID,
    work_item_id: WORK_ITEM_ID,
    from_agent: COORDINATOR_AGENT_ID,
    to_agent: RESEARCHER_AGENT_ID,
    objective: "Attempt an out-of-scope export to demonstrate deny-by-default.",
    context_refs: [],
    allowed_capabilities: [DENY_CAPABILITY_NAME],
    approval_gates: [],
  };
}

function defaultPromotionCandidate() {
  return {
    id: PROMOTION_CANDIDATE_ID,
    workspace_id: WORKSPACE_ID,
    source_memory_entry: COORDINATOR_MEMORY_ID,
    proposed_by: COORDINATOR_AGENT_ID,
    proposed_content: "A short onboarding brief should include explicit assumptions.",
    rationale: "Useful reusable guidance for future onboarding tasks.",
    corroboration_count: 1,
    status: "pending",
    created_at: PROMOTION_CREATED_AT,
  };
}

function defaultCoordinatorRole() {
  return RoleSchema.parse({
    id: COORDINATOR_ROLE_ID,
    workspace_id: WORKSPACE_ID,
    name: "coordinator",
    purpose: "Plan work, delegate bounded subtasks, compose final artifacts.",
    responsibilities: ["delegate one research subtask", "compose final brief"],
    capability_grants: ["memory.read", "memory.write", "promotion.propose"],
  });
}

function defaultResearcherRole() {
  return RoleSchema.parse({
    id: RESEARCHER_ROLE_ID,
    workspace_id: WORKSPACE_ID,
    name: "researcher",
    purpose: "Gather seeded information and return structured findings.",
    responsibilities: ["call mock research lookup"],
    capability_grants: ["mock.research_lookup", "memory.write"],
  });
}

function defaultCoordinatorAgent() {
  return AgentSchema.parse({
    id: COORDINATOR_AGENT_ID,
    workspace_id: WORKSPACE_ID,
    role_id: COORDINATOR_ROLE_ID,
    identity: "Coordinator Agent",
    memory_scope: { read: ["collective"], write: ["individual"] },
    model_binding: "mock",
    status: "idle",
  });
}

function defaultResearcherAgent() {
  return AgentSchema.parse({
    id: RESEARCHER_AGENT_ID,
    workspace_id: WORKSPACE_ID,
    role_id: RESEARCHER_ROLE_ID,
    identity: "Research Agent",
    model_binding: "mock",
    status: "idle",
  });
}
