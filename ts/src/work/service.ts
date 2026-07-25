import { createHash } from "node:crypto";

import {
  type BoundedWorkEnvelope,
  BoundedWorkEnvelopeSchema,
  EventPayloadSchema,
  type ExternalActorRef,
  newId,
  type ResourceGrants,
  type Run,
  RunSchema,
  type TaskEnvelope,
  TaskEnvelopeSchema,
  utcNow,
  type WorkerIdentity,
  WorkerIdentitySchema,
  type WorkerOutcome,
  WorkerOutcomeSchema,
  type WorkItem,
  WorkItemSchema,
} from "../contracts/index.js";
import type { Database } from "../persistence/database.js";
import {
  BoundedWorkEnvelopeStore,
  EventStore,
  RunStore,
  TaskEnvelopeStore,
  WorkerIdentityStore,
  WorkerOutcomeStore,
  WorkItemStore,
} from "../persistence/index.js";
import {
  assertNoSensitiveMaterial,
  assertNoSensitiveString,
} from "../security/sensitive-material.js";

type CreateWorkInput = {
  id?: string | null;
  workspace_id: string;
  title: string;
  objective: string;
  owner: string;
  reviewer?: string | null;
  priority?: WorkItem["priority"];
  risk_level?: WorkItem["risk_level"];
  success_criteria?: string[];
  actor: string;
  idempotency_key?: string | null;
};

type RegisterWorkerInput = {
  id?: string | null;
  workspace_id: string;
  name: string;
  runtime: string;
  version?: string | null;
  role_id?: string | null;
  allowed_capabilities?: string[];
  actor: string;
  idempotency_key?: string | null;
};

type AssignWorkInput = {
  workspace_id: string;
  work_item_id: string;
  owner: string;
  reviewer?: string | null;
  actor: string;
  idempotency_key?: string | null;
};

type SetWorkStatusInput = {
  workspace_id: string;
  work_item_id: string;
  status: Extract<WorkItem["status"], "in_progress" | "blocked" | "review" | "done" | "failed">;
  actor: string;
  reason?: string | null;
  idempotency_key?: string | null;
};

type SubmitWorkerOutcomeInput = {
  id?: string | null;
  workspace_id: string;
  envelope_id: string;
  worker_id: string;
  status: WorkerOutcome["status"];
  summary: string;
  output?: Record<string, unknown>;
  artifacts?: WorkerOutcome["artifacts"];
  memory_writes?: string[];
  promotion_candidates?: string[];
  actor?: string | null;
  idempotency_key: string;
};

type ReviewWorkInput = {
  workspace_id: string;
  work_item_id: string;
  decision: "accepted" | "changes_requested" | "rejected";
  actor: string;
  notes?: string | null;
  idempotency_key?: string | null;
};

type CreateBoundedEnvelopeInput = {
  id?: string | null;
  workspace_id: string;
  work_item_id: string;
  run_id?: string | null;
  task_envelope_id?: string | null;
  worker_id: string;
  issued_by: ExternalActorRef;
  objective?: string | null;
  context_refs?: string[];
  allowed_capabilities?: string[];
  approval_gates?: string[];
  resource_grants?: ResourceGrants | null;
  input?: Record<string, unknown>;
  expires_at?: string | null;
  idempotency_key?: string | null;
};

type EnsureExternalRunInput = {
  id?: string | null;
  workspace_id: string;
  active_node: string;
  actor: string;
  created_at?: string | null;
  idempotency_key?: string | null;
};

type CompleteExternalRunInput = {
  run_id: string;
  active_node: string;
  actor: string;
  refs?: string[];
  data?: Record<string, unknown>;
  idempotency_key?: string | null;
};

function actorString(actor: ExternalActorRef): string {
  return `${actor.actor_type}:${actor.actor_id}`;
}

// Wrap a bare actor string into a typed actor ref for M0 causal instrumentation, inferring the kind
// from a known prefix. The actor_id (the full string) is what drives the causal graph's sequential
// edges; the inferred type is best-effort metadata, so prefix matching (not substring) is used to
// avoid mislabeling e.g. "operator:agent-admin" as an agent. Prefer passing a typed ExternalActorRef
// directly when one is available (see envelope.created).
function asActorRef(actor: string): ExternalActorRef {
  const hasPrefix = (kind: string): boolean =>
    actor.startsWith(`${kind}:`) || actor.startsWith(`${kind}_`);
  const actorType = hasPrefix("worker")
    ? "worker"
    : hasPrefix("agent")
      ? "agent"
      : hasPrefix("operator")
        ? "operator"
        : "system";
  return { actor_type: actorType, actor_id: actor, display_name: null };
}

export class WorkService {
  private readonly workItems: WorkItemStore;
  private readonly workers: WorkerIdentityStore;
  private readonly outcomes: WorkerOutcomeStore;
  private readonly boundedEnvelopes: BoundedWorkEnvelopeStore;
  private readonly events: EventStore;
  private readonly runs: RunStore;
  private readonly tasks: TaskEnvelopeStore;

  constructor(private readonly database: Database) {
    this.workItems = new WorkItemStore(database);
    this.workers = new WorkerIdentityStore(database);
    this.outcomes = new WorkerOutcomeStore(database);
    this.boundedEnvelopes = new BoundedWorkEnvelopeStore(database);
    this.events = new EventStore(database);
    this.runs = new RunStore(database);
    this.tasks = new TaskEnvelopeStore(database);
  }

  createWork(input: CreateWorkInput): WorkItem {
    const workItem = WorkItemSchema.parse({
      id: input.id ?? newId("work"),
      workspace_id: input.workspace_id,
      title: input.title,
      objective: input.objective,
      owner: input.owner,
      reviewer: input.reviewer ?? null,
      priority: input.priority ?? "medium",
      risk_level: input.risk_level ?? "low",
      success_criteria: input.success_criteria ?? [],
    });

    return this.database.transaction(() => {
      const saved = this.workItems.save(workItem);
      this.events.append({
        workspace_id: saved.workspace_id,
        kind: "work.created",
        actor: input.actor,
        payload: EventPayloadSchema.parse({
          data: { work_item: saved },
          refs: [saved.id],
          actor_ref: asActorRef(input.actor),
          produced_refs: [saved.id],
        }),
        idempotency_key: input.idempotency_key ?? `work:${saved.id}:created`,
      });
      return saved;
    });
  }

  registerWorker(input: RegisterWorkerInput): WorkerIdentity {
    const worker = WorkerIdentitySchema.parse({
      id: input.id ?? newId("worker"),
      workspace_id: input.workspace_id,
      name: input.name,
      runtime: input.runtime,
      version: input.version ?? null,
      role_id: input.role_id ?? null,
      allowed_capabilities: input.allowed_capabilities ?? [],
    });

    return this.database.transaction(() => {
      const saved = this.workers.save(worker);
      this.events.append({
        workspace_id: saved.workspace_id,
        kind: "worker.registered",
        actor: input.actor,
        payload: EventPayloadSchema.parse({
          data: { worker_identity: saved },
          refs: [saved.id],
        }),
        idempotency_key: input.idempotency_key ?? `worker:${saved.id}:registered`,
      });
      return saved;
    });
  }

  assignWork(input: AssignWorkInput): WorkItem {
    return this.database.transaction(() => {
      const current = this.requireWorkItem(input.work_item_id);
      this.requireWorkspaceMatch(current, input.workspace_id);
      const updated = this.workItems.update(
        WorkItemSchema.parse({
          ...current,
          owner: input.owner,
          reviewer: input.reviewer ?? current.reviewer,
          status: current.status === "queued" ? "in_progress" : current.status,
        }),
      );
      this.events.append({
        workspace_id: updated.workspace_id,
        kind: "work.assigned",
        actor: input.actor,
        payload: EventPayloadSchema.parse({
          data: {
            work_item_id: updated.id,
            owner: updated.owner,
            reviewer: updated.reviewer,
            status: updated.status,
          },
          refs: [updated.id],
          actor_ref: asActorRef(input.actor),
          consumed_refs: [updated.id],
        }),
        idempotency_key: input.idempotency_key ?? `work:${updated.id}:assigned:${updated.owner}`,
      });
      return updated;
    });
  }

  setStatus(input: SetWorkStatusInput): WorkItem {
    return this.database.transaction(() => {
      const current = this.requireWorkItem(input.work_item_id);
      this.requireWorkspaceMatch(current, input.workspace_id);
      const updated = this.workItems.setStatus(input.work_item_id, input.status);
      this.events.append({
        workspace_id: updated.workspace_id,
        kind: `work.${input.status}`,
        actor: input.actor,
        payload: EventPayloadSchema.parse({
          data: {
            work_item_id: updated.id,
            status: updated.status,
            reason: input.reason ?? null,
          },
          refs: [updated.id],
          actor_ref: asActorRef(input.actor),
          consumed_refs: [updated.id],
        }),
        idempotency_key: input.idempotency_key ?? `work:${updated.id}:status:${updated.status}`,
      });
      return updated;
    });
  }

  submitWorkerOutcome(input: SubmitWorkerOutcomeInput): WorkerOutcome {
    return this.database.transaction(() => {
      const envelope = this.boundedEnvelopes.get(input.envelope_id);
      if (!envelope || envelope.workspace_id !== input.workspace_id) {
        throw new Error(`bounded work envelope not found in workspace: ${input.envelope_id}`);
      }
      if (envelope.worker_id !== input.worker_id) {
        throw new Error("worker outcome does not match bounded envelope worker");
      }
      const workItem = this.requireWorkItem(envelope.work_item_id);
      if (workItem.workspace_id !== input.workspace_id) {
        throw new Error(`work item not found in workspace: ${envelope.work_item_id}`);
      }
      assertNoSensitiveString(input.summary, "worker_outcome.summary");
      assertNoSensitiveMaterial(input.output ?? {}, "worker_outcome.output");
      assertNoSensitiveMaterial(input.artifacts ?? [], "worker_outcome.artifacts");

      const outcome = WorkerOutcomeSchema.parse({
        id: input.id ?? newId("outcome"),
        workspace_id: input.workspace_id,
        work_item_id: workItem.id,
        envelope_id: envelope.id,
        worker_id: input.worker_id,
        status: input.status,
        summary: input.summary,
        artifacts: input.artifacts ?? [],
        memory_writes: input.memory_writes ?? [],
        promotion_candidates: input.promotion_candidates ?? [],
        output: input.output ?? {},
        idempotency_key: input.idempotency_key,
        submitted_at: utcNow(),
      });
      const saved = this.outcomes.record(outcome);
      const nextStatus = saved.status === "completed" ? "review" : saved.status;
      if (
        workItem.status !== nextStatus &&
        workItem.status !== "done" &&
        workItem.status !== "failed"
      ) {
        this.workItems.update(WorkItemSchema.parse({ ...workItem, status: nextStatus }));
      }
      this.events.append({
        workspace_id: saved.workspace_id,
        run_id: envelope.run_id,
        kind: "work.outcome_submitted",
        actor: input.actor ?? `worker:${saved.worker_id}`,
        payload: EventPayloadSchema.parse({
          data: {
            worker_outcome: saved,
            work_item_status: nextStatus,
          },
          refs: [saved.id, saved.work_item_id, saved.envelope_id, saved.worker_id],
          actor_ref: asActorRef(input.actor ?? `worker:${saved.worker_id}`),
          consumed_refs: [saved.work_item_id, saved.envelope_id],
        }),
        idempotency_key: `${saved.id}:event`,
      });
      return saved;
    });
  }

  reviewWork(input: ReviewWorkInput): WorkItem {
    return this.database.transaction(() => {
      const current = this.requireWorkItem(input.work_item_id);
      this.requireWorkspaceMatch(current, input.workspace_id);
      const nextStatus =
        input.decision === "accepted"
          ? "done"
          : input.decision === "rejected"
            ? "failed"
            : "in_progress";
      const updated = this.workItems.update(
        WorkItemSchema.parse({ ...current, status: nextStatus }),
      );
      this.events.append({
        workspace_id: updated.workspace_id,
        kind: "work.reviewed",
        actor: input.actor,
        payload: EventPayloadSchema.parse({
          data: {
            work_item_id: updated.id,
            decision: input.decision,
            status: updated.status,
            notes: input.notes ?? null,
          },
          refs: [updated.id],
          // A rejected review drives the work item to `failed` — instrument it so a reviewer-caused
          // failure is diagnosable and traces back to the work item's creation.
          actor_ref: asActorRef(input.actor),
          consumed_refs: [updated.id],
        }),
        idempotency_key: input.idempotency_key ?? `work:${updated.id}:review:${input.decision}`,
      });
      return updated;
    });
  }

  getRun(runId: string): Run | null {
    return this.runs.get(runId);
  }

  createBoundedEnvelope(input: CreateBoundedEnvelopeInput): BoundedWorkEnvelope {
    return this.database.transaction(() => {
      const workItem = this.requireWorkItem(input.work_item_id);
      const worker = this.workers.get(input.worker_id);
      if (!worker || worker.workspace_id !== input.workspace_id) {
        throw new Error(`worker identity not found in workspace: ${input.worker_id}`);
      }
      if (workItem.workspace_id !== input.workspace_id) {
        throw new Error(`work item not found in workspace: ${input.work_item_id}`);
      }
      const allowedCapabilities = input.allowed_capabilities ?? worker.allowed_capabilities;
      const ungranted = allowedCapabilities.filter(
        (capability) => !worker.allowed_capabilities.includes(capability),
      );
      if (ungranted.length > 0) {
        throw new Error(
          `bounded envelope capabilities exceed worker grants: ${ungranted.join(", ")}`,
        );
      }
      if (input.run_id) {
        const run = this.runs.get(input.run_id);
        if (!run || run.workspace_id !== input.workspace_id) {
          throw new Error(`run not found in workspace: ${input.run_id}`);
        }
      }
      assertNoSensitiveMaterial(input.input ?? {}, "bounded_work_envelope.input");
      const resourceGrants = input.resource_grants ?? {};
      // Resource-grant values are operator-supplied free strings that ride the envelope into the
      // append-only event log; screen them like every other free string so a secret-shaped grant
      // value (or capability/field key) can never be persisted. Walks keys and every leaf value.
      assertNoSensitiveMaterial(resourceGrants, "bounded_work_envelope.resource_grants");
      const envelopeId = input.id ?? newId("envelope");
      const taskEnvelopeId = input.run_id
        ? (input.task_envelope_id ?? this.taskEnvelopeIdForEnvelope(envelopeId))
        : null;
      const taskEnvelope = input.run_id
        ? this.ensureTaskEnvelope({
            id: taskEnvelopeId ?? undefined,
            workspace_id: input.workspace_id,
            run_id: input.run_id,
            work_item_id: workItem.id,
            worker_id: worker.id,
            objective: input.objective ?? workItem.objective,
            allowed_capabilities: allowedCapabilities,
            approval_gates: input.approval_gates ?? workItem.approval_gates,
            resource_grants: resourceGrants,
            actor: actorString(input.issued_by),
          })
        : null;

      const envelope = BoundedWorkEnvelopeSchema.parse({
        id: envelopeId,
        workspace_id: input.workspace_id,
        work_item_id: workItem.id,
        run_id: input.run_id ?? null,
        task_envelope_id: taskEnvelope?.id ?? null,
        worker_id: worker.id,
        issued_by: input.issued_by,
        objective: input.objective ?? workItem.objective,
        context_refs: input.context_refs ?? [],
        allowed_capabilities: allowedCapabilities,
        approval_gates: input.approval_gates ?? workItem.approval_gates,
        resource_grants: resourceGrants,
        input: input.input ?? {},
        created_at: utcNow(),
        expires_at: input.expires_at ?? null,
      });
      const saved = this.boundedEnvelopes.save(envelope);
      this.events.append({
        workspace_id: saved.workspace_id,
        run_id: saved.run_id,
        kind: "work.envelope.created",
        actor: actorString(saved.issued_by),
        payload: EventPayloadSchema.parse({
          data: {
            envelope_id: saved.id,
            work_item_id: saved.work_item_id,
            worker_id: saved.worker_id,
            allowed_capabilities: saved.allowed_capabilities,
          },
          refs: [saved.id, saved.work_item_id, saved.worker_id],
          // issued_by is already a typed actor ref — no inference needed. The envelope CONSUMES the
          // work item and PRODUCES the envelope id that the worker's outcome later consumes, so a
          // failed outcome traces back through the envelope (its bounded authority + input) to the
          // work item's creation.
          actor_ref: saved.issued_by,
          consumed_refs: [saved.work_item_id],
          produced_refs: [saved.id],
        }),
        idempotency_key: input.idempotency_key ?? `work:${saved.work_item_id}:envelope:${saved.id}`,
      });
      return saved;
    });
  }

  ensureExternalRun(input: EnsureExternalRunInput): Run {
    return this.database.transaction(() => {
      const existing = this.runs.get(input.id ?? "");
      if (existing) {
        if (existing.workspace_id !== input.workspace_id) {
          throw new Error(`run not found in workspace: ${existing.id}`);
        }
        if (existing.status === "queued") {
          return this.runs.setStatus(existing.id, "running", {
            active_node: input.active_node,
          });
        }
        return existing;
      }

      const createdAt = input.created_at ?? utcNow();
      const queued = this.runs.create(
        RunSchema.parse({
          id: input.id ?? newId("run"),
          workspace_id: input.workspace_id,
          status: "queued",
          active_node: null,
          suspended_approval_id: null,
          created_at: createdAt,
          updated_at: createdAt,
        }),
      );
      const running = this.runs.setStatus(queued.id, "running", {
        active_node: input.active_node,
        updated_at: createdAt,
      });
      this.events.append({
        workspace_id: running.workspace_id,
        run_id: running.id,
        kind: "run.started",
        actor: input.actor,
        payload: EventPayloadSchema.parse({ data: { run: running }, refs: [running.id] }),
        idempotency_key: input.idempotency_key ?? `${running.id}:started`,
      });
      return running;
    });
  }

  completeExternalRun(input: CompleteExternalRunInput): Run {
    return this.database.transaction(() => {
      const current = this.runs.get(input.run_id);
      if (!current) {
        throw new Error(`run not found: ${input.run_id}`);
      }
      if (current.status === "completed" || current.status === "failed") {
        return current;
      }
      const completed = this.runs.setStatus(current.id, "completed", {
        active_node: input.active_node,
      });
      this.events.append({
        workspace_id: completed.workspace_id,
        run_id: completed.id,
        kind: "run.completed",
        actor: input.actor,
        payload: EventPayloadSchema.parse({
          data: { run: completed, ...(input.data ?? {}) },
          refs: [completed.id, ...(input.refs ?? [])],
        }),
        idempotency_key: input.idempotency_key ?? `${completed.id}:completed`,
      });
      return completed;
    });
  }

  private ensureTaskEnvelope(input: {
    id?: string | null | undefined;
    workspace_id: string;
    run_id: string;
    work_item_id: string;
    worker_id: string;
    objective: string;
    allowed_capabilities: string[];
    approval_gates: string[];
    resource_grants: ResourceGrants;
    actor: string;
  }): TaskEnvelope {
    const task = this.tasks.save(
      TaskEnvelopeSchema.parse({
        id: input.id ?? newId("task"),
        workspace_id: input.workspace_id,
        run_id: input.run_id,
        work_item_id: input.work_item_id,
        from_agent: null,
        to_agent: input.worker_id,
        objective: input.objective,
        allowed_capabilities: input.allowed_capabilities,
        approval_gates: input.approval_gates,
        resource_grants: input.resource_grants,
      }),
    );
    this.events.append({
      workspace_id: task.workspace_id,
      run_id: task.run_id,
      kind: "task.envelope.created",
      actor: input.actor,
      payload: EventPayloadSchema.parse({ data: { task_envelope: task }, refs: [task.id] }),
      idempotency_key: `${task.id}:created`,
    });
    return task;
  }

  private taskEnvelopeIdForEnvelope(envelopeId: string): string {
    const suffix =
      envelopeId.split("_", 2)[1] ?? createHash("sha256").update(envelopeId).digest("hex");
    return `task_${suffix.padEnd(32, "0").slice(0, 32)}`;
  }

  private requireWorkItem(workItemId: string): WorkItem {
    const workItem = this.workItems.get(workItemId);
    if (!workItem) {
      throw new Error(`work item not found: ${workItemId}`);
    }
    return workItem;
  }

  private requireWorkspaceMatch(workItem: WorkItem, workspaceId: string): void {
    if (workItem.workspace_id !== workspaceId) {
      throw new Error(`work item not found in workspace: ${workItem.id}`);
    }
  }
}
