import { createHash } from "node:crypto";

import {
  type ApprovalPayload,
  ApprovalPayloadSchema,
  type ApprovalRequest,
  ApprovalRequestSchema,
  EventPayloadSchema,
  newId,
  type Run,
  TraceSchema,
  utcNow,
} from "../contracts/index.js";
import {
  ApprovalConflictError,
  ApprovalStore,
  CheckpointStore,
  type Database,
  EventStore,
  OrgChangeProposalStore,
  PromotionCandidateStore,
  RunStore,
  TraceStore,
} from "../persistence/index.js";
import { jsonEqual } from "../persistence/serialization.js";

type ApprovalApproveAction = "resume_run" | "apply_without_run";
type ApprovalRejectAction = "fail_run" | "skip_action" | "no_op";
type ApprovalApplicationHandler = (approval: ApprovalRequest) => void;

export class ApprovalApplicationError extends Error {}

/**
 * Raised when the approving actor is the same identity that requested the approval. Consequential
 * approvals (promotion, org change) require separation of duties: the approver must differ from the
 * requester. This mirrors the proposer-cannot-ratify guard on autonomy widening.
 */
export class SelfApprovalError extends ApprovalApplicationError {}

export class ApprovalService {
  readonly approvals: ApprovalStore;
  private readonly events: EventStore;
  private readonly runs: RunStore;

  constructor(
    private readonly database: Database,
    private readonly options: { applyWithoutRun?: ApprovalApplicationHandler } = {},
  ) {
    this.approvals = new ApprovalStore(database);
    this.events = new EventStore(database);
    this.runs = new RunStore(database);
  }

  request(input: {
    workspace_id: string;
    action: string;
    requested_by: string;
    payload: ApprovalPayload;
    run_id?: string | null;
    approval_id?: string | null;
    on_approve?: ApprovalApproveAction;
    on_reject?: ApprovalRejectAction;
  }): ApprovalRequest {
    const payload = ApprovalPayloadSchema.parse(input.payload);
    const onApprove = input.on_approve ?? "resume_run";
    const onReject = input.on_reject ?? "fail_run";
    if (!input.run_id && onApprove === "resume_run") {
      throw new ApprovalApplicationError("non-run approvals must use apply_without_run");
    }
    if (input.run_id && onApprove === "apply_without_run") {
      throw new ApprovalApplicationError("run approvals must use resume_run");
    }

    return this.database.transaction(() => {
      const existing = this.findExistingRequest(
        input.approval_id ?? null,
        input.workspace_id,
        payload,
      );
      if (existing) {
        this.validateRequestReplay(existing, {
          ...input,
          payload,
          run_id: input.run_id ?? null,
          on_approve: onApprove,
          on_reject: onReject,
        });
        return existing;
      }
      if (input.run_id) {
        this.validateRunCanRequestApproval(input.run_id, input.workspace_id);
      }

      const approval = this.approvals.create(
        ApprovalRequestSchema.parse({
          id: input.approval_id ?? newId("approval"),
          workspace_id: input.workspace_id,
          run_id: input.run_id ?? null,
          action: input.action,
          requested_by: input.requested_by,
          payload,
          on_approve: onApprove,
          on_reject: onReject,
          created_at: utcNow(),
        }),
      );
      const requestedEvent = this.events.append({
        workspace_id: approval.workspace_id,
        run_id: approval.run_id,
        kind: "approval.requested",
        actor: "approval_service",
        payload: EventPayloadSchema.parse({
          data: { approval_request: approval },
          refs: [approval.id],
        }),
        idempotency_key: `${approval.id}:requested`,
      });
      if (approval.run_id) {
        const suspended = this.runs.setStatus(approval.run_id, "suspended_approval", {
          active_node: "approval_requested",
          suspended_approval_id: approval.id,
        });
        this.traceAndCheckpoint(suspended, "approval_requested", [requestedEvent.id]);
      }
      return approval;
    });
  }

  approve(
    approvalId: string,
    input: { workspace_id: string; actor?: string | null },
  ): ApprovalRequest {
    return this.database.transaction(() => {
      const current = this.getForWorkspace(approvalId, input.workspace_id);
      const alreadyApproved = current.status === "approved";
      if (alreadyApproved) {
        return current;
      }
      this.assertNotSelfApproval(current, input.actor ?? null);
      if (current.on_approve === "apply_without_run" && !this.options.applyWithoutRun) {
        throw new ApprovalApplicationError(
          `approval requires an application handler: ${approvalId}`,
        );
      }
      const approval = this.approvals.resolve(approvalId, "approved");
      const approvedEvent = this.events.append({
        workspace_id: approval.workspace_id,
        run_id: approval.run_id,
        kind: "approval.approved",
        actor: input.actor ?? "approval_service",
        payload: EventPayloadSchema.parse({
          data: { approval_request: approval },
          refs: [approval.id],
        }),
        idempotency_key: `${approval.id}:approved`,
      });

      if (approval.run_id && approval.on_approve === "resume_run") {
        const run = this.runs.get(approval.run_id);
        if (!run) {
          throw new Error(`run not found: ${approval.run_id}`);
        }
        if (!alreadyApproved || run.status === "suspended_approval") {
          const resumed = this.runs.setStatus(approval.run_id, "running", {
            active_node: "approval_resolved",
          });
          this.traceAndCheckpoint(resumed, "approval_resolved", [approvedEvent.id]);
        } else if (run.status === "running" && run.active_node === "approval_resolved") {
          this.traceAndCheckpoint(run, "approval_resolved", [approvedEvent.id]);
        }
      } else if (approval.on_approve === "apply_without_run") {
        if (!alreadyApproved) {
          this.options.applyWithoutRun?.(approval);
        }
        this.events.append({
          workspace_id: approval.workspace_id,
          run_id: approval.run_id,
          kind: "approval.applied",
          actor: input.actor ?? "approval_service",
          payload: EventPayloadSchema.parse({
            data: { approval_request: approval },
            refs: [approval.id],
          }),
          idempotency_key: `${approval.id}:applied`,
        });
      }
      return approval;
    });
  }

  reject(
    approvalId: string,
    input: { workspace_id: string; actor?: string | null },
  ): ApprovalRequest {
    return this.database.transaction(() => {
      const current = this.getForWorkspace(approvalId, input.workspace_id);
      const alreadyRejected = current.status === "rejected";
      const approval = this.approvals.resolve(approvalId, "rejected");
      if (alreadyRejected) {
        return approval;
      }
      this.rejectTarget(approval);

      const rejectedEvent = this.events.append({
        workspace_id: approval.workspace_id,
        run_id: approval.run_id,
        kind: "approval.rejected",
        actor: input.actor ?? "approval_service",
        payload: EventPayloadSchema.parse({
          data: { approval_request: approval },
          refs: [approval.id],
        }),
        idempotency_key: `${approval.id}:rejected`,
      });
      if (approval.run_id && approval.on_reject === "fail_run") {
        const failed = this.runs.setStatus(approval.run_id, "failed", {
          active_node: "approval_rejected",
        });
        const failedEvent = this.events.append({
          workspace_id: approval.workspace_id,
          run_id: approval.run_id,
          kind: "run.failed",
          actor: input.actor ?? "approval_service",
          payload: EventPayloadSchema.parse({
            data: { approval_request: approval, run: failed },
            refs: [approval.id, failed.id],
          }),
          idempotency_key: `${approval.id}:run.failed`,
        });
        this.traceAndCheckpoint(failed, "approval_rejected", [rejectedEvent.id, failedEvent.id]);
      } else if (approval.run_id && approval.on_reject === "skip_action") {
        const skipped = this.runs.setStatus(approval.run_id, "running", {
          active_node: "approval_skipped",
        });
        const resumedEvent = this.events.append({
          workspace_id: approval.workspace_id,
          run_id: approval.run_id,
          kind: "run.resumed",
          actor: input.actor ?? "approval_service",
          payload: EventPayloadSchema.parse({
            data: {
              approval_request: approval,
              run: skipped,
              reason: "approval rejected with skip_action",
            },
            refs: [approval.id, skipped.id],
          }),
          idempotency_key: `${approval.id}:run.resumed`,
        });
        this.traceAndCheckpoint(skipped, "approval_skipped", [rejectedEvent.id, resumedEvent.id]);
      }
      return approval;
    });
  }

  private findExistingRequest(
    approvalId: string | null,
    workspaceId: string,
    payload: ApprovalPayload,
  ): ApprovalRequest | null {
    if (approvalId) {
      const byId = this.approvals.get(approvalId);
      if (byId) {
        return byId;
      }
    }
    return this.approvals.findForTarget({
      workspace_id: workspaceId,
      target_type: payload.target_type,
      target_id: payload.target_id,
      statuses: new Set(["pending", "approved"]),
    });
  }

  private validateRequestReplay(
    existing: ApprovalRequest,
    input: {
      workspace_id: string;
      run_id: string | null;
      action: string;
      requested_by: string;
      payload: ApprovalPayload;
      on_approve: ApprovalApproveAction;
      on_reject: ApprovalRejectAction;
    },
  ): void {
    if (
      existing.workspace_id !== input.workspace_id ||
      existing.run_id !== input.run_id ||
      existing.action !== input.action ||
      existing.requested_by !== input.requested_by ||
      !jsonEqual(existing.payload, input.payload) ||
      existing.on_approve !== input.on_approve ||
      existing.on_reject !== input.on_reject
    ) {
      throw new ApprovalConflictError(`approval request already exists: ${existing.id}`);
    }
  }

  private validateRunCanRequestApproval(runId: string, workspaceId: string): void {
    const run = this.runs.get(runId);
    if (!run) {
      throw new Error(`run not found: ${runId}`);
    }
    if (run.workspace_id !== workspaceId) {
      throw new ApprovalApplicationError(`run does not belong to workspace: ${runId}`);
    }
    if (run.status !== "running") {
      throw new ApprovalApplicationError(
        `run must be running before requesting approval: ${runId}`,
      );
    }
  }

  private assertNotSelfApproval(approval: ApprovalRequest, actor: string | null): void {
    if (actor === null) {
      // Unattributed: the operator token authorizes the call. Attribution becomes mandatory
      // and verified once identity is bound at the HTTP boundary — see issue #92.
      return;
    }
    const approver = actor.trim();
    if (approver.length === 0) {
      // A supplied-but-blank actor is malformed; it must not pass as "no actor".
      throw new SelfApprovalError(
        `approver identity must not be blank for approval ${approval.id}`,
      );
    }
    if (approver === approval.requested_by.trim()) {
      throw new SelfApprovalError(
        `approver must differ from requester for approval ${approval.id}`,
      );
    }
  }

  private getForWorkspace(approvalId: string, workspaceId: string): ApprovalRequest {
    const approval = this.approvals.get(approvalId);
    if (!approval) {
      throw new Error(`approval request not found: ${approvalId}`);
    }
    if (approval.workspace_id !== workspaceId) {
      throw new ApprovalApplicationError(`approval does not belong to workspace: ${approvalId}`);
    }
    return approval;
  }

  private rejectTarget(approval: ApprovalRequest): void {
    if (approval.payload.target_type === "org_change_proposal") {
      const store = new OrgChangeProposalStore(this.database);
      const proposal = store.get(approval.payload.target_id);
      if (!proposal) {
        throw new Error(`org change proposal not found: ${approval.payload.target_id}`);
      }
      if (proposal.workspace_id !== approval.workspace_id) {
        throw new ApprovalApplicationError(
          "approval workspace does not match org change proposal workspace",
        );
      }
      const rejected = store.setStatus(proposal.id, "rejected", {
        resolved_at: approval.resolved_at,
      });
      this.events.append({
        workspace_id: approval.workspace_id,
        run_id: approval.run_id,
        kind: "org_change.rejected",
        actor: "approval_service",
        payload: EventPayloadSchema.parse({
          data: { approval_request: approval, org_change_proposal: rejected },
          refs: [approval.id, rejected.id],
        }),
        idempotency_key: `${approval.id}:org_change.rejected`,
      });
      return;
    }
    if (
      approval.on_reject !== "fail_run" ||
      approval.payload.target_type !== "promotion_candidate"
    ) {
      return;
    }
    const store = new PromotionCandidateStore(this.database);
    const candidate = store.get(approval.payload.target_id);
    if (!candidate) {
      throw new Error(`promotion candidate not found: ${approval.payload.target_id}`);
    }
    if (candidate.workspace_id !== approval.workspace_id) {
      throw new ApprovalApplicationError(
        "approval workspace does not match promotion candidate workspace",
      );
    }
    const rejected = store.setStatus(candidate.id, "rejected", {
      resolved_at: approval.resolved_at,
    });
    this.events.append({
      workspace_id: approval.workspace_id,
      run_id: approval.run_id,
      kind: "memory.promotion_rejected",
      actor: "approval_service",
      payload: EventPayloadSchema.parse({
        data: { approval_request: approval, promotion_candidate: rejected },
        refs: [approval.id, rejected.id],
      }),
      idempotency_key: `${approval.id}:promotion.rejected`,
    });
  }

  private traceAndCheckpoint(run: Run, node: string, eventIds: string[]): void {
    const trace = new TraceStore(this.database).save(
      TraceSchema.parse({
        id: stableTraceId(run.id, node),
        workspace_id: run.workspace_id,
        run_id: run.id,
        node,
        timestamp: utcNow(),
        event_ids: eventIds,
      }),
    );
    new CheckpointStore(this.database).save({
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
}

function stableTraceId(runId: string, node: string): string {
  return `trace_${createHash("sha256").update(`${runId}:${node}`).digest("hex").slice(0, 32)}`;
}
