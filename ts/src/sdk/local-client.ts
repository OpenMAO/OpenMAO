import type {
  BoundedWorkEnvelope,
  ExternalActorRef,
  ExternalSource,
  IngestionRecord,
  WorkerIdentity,
  WorkerOutcome,
  WorkItem,
} from "../contracts/index.js";
import { IngestionService } from "../ingestion/index.js";
import type { Database } from "../persistence/database.js";
import {
  BoundedWorkEnvelopeStore,
  EventStore,
  IngestionRecordStore,
  WorkerIdentityStore,
  WorkerOutcomeStore,
  WorkItemStore,
} from "../persistence/index.js";
import { WorkService } from "../work/index.js";

type ClientContext = {
  workspace_id: string;
  actor: string;
  actor_type?: ExternalActorRef["actor_type"];
};

type RegisterWorkerInput = {
  id?: string | null;
  name: string;
  runtime: string;
  version?: string | null;
  role_id?: string | null;
  allowed_capabilities?: string[];
  idempotency_key?: string | null;
};

type CreateWorkInput = {
  id?: string | null;
  title: string;
  objective: string;
  owner: string;
  reviewer?: string | null;
  priority?: WorkItem["priority"];
  risk_level?: WorkItem["risk_level"];
  success_criteria?: string[];
  idempotency_key?: string | null;
};

type IssueEnvelopeInput = {
  id?: string | null;
  work_item_id: string;
  worker_id: string;
  run_id?: string | null;
  task_envelope_id?: string | null;
  issued_by?: ExternalActorRef | null;
  objective?: string | null;
  context_refs?: string[];
  allowed_capabilities?: string[];
  approval_gates?: string[];
  input?: Record<string, unknown>;
  expires_at?: string | null;
  idempotency_key?: string | null;
};

type SubmitOutcomeInput = {
  id?: string | null;
  envelope_id: string;
  worker_id: string;
  status: WorkerOutcome["status"];
  summary: string;
  output?: Record<string, unknown>;
  artifacts?: WorkerOutcome["artifacts"];
  memory_writes?: string[];
  promotion_candidates?: string[];
  idempotency_key: string;
};

type RecordIngestionInput = {
  id?: string | null;
  source?: ExternalSource | null;
  actor?: ExternalActorRef | null;
  kind: IngestionRecord["kind"];
  target_run_id?: string | null;
  target_work_item_id?: string | null;
  payload?: Record<string, unknown>;
  occurred_at?: string | null;
  idempotency_key: string;
};

export class OpenMaoLocalClient {
  private readonly ingestions: IngestionService;
  private readonly work: WorkService;

  constructor(
    private readonly database: Database,
    private readonly context: ClientContext,
  ) {
    this.ingestions = new IngestionService(database);
    this.work = new WorkService(database);
  }

  registerWorker(input: RegisterWorkerInput): WorkerIdentity {
    return this.work.registerWorker({
      ...input,
      workspace_id: this.context.workspace_id,
      actor: this.context.actor,
    });
  }

  workers(): WorkerIdentity[] {
    return new WorkerIdentityStore(this.database).listForWorkspace(this.context.workspace_id);
  }

  createWork(input: CreateWorkInput): WorkItem {
    return this.work.createWork({
      ...input,
      workspace_id: this.context.workspace_id,
      actor: this.context.actor,
    });
  }

  assignWork(input: {
    work_item_id: string;
    owner: string;
    reviewer?: string | null;
    idempotency_key?: string | null;
  }): WorkItem {
    return this.work.assignWork({
      ...input,
      workspace_id: this.context.workspace_id,
      actor: this.context.actor,
    });
  }

  workItems(): WorkItem[] {
    return new WorkItemStore(this.database).listForWorkspace(this.context.workspace_id);
  }

  issueEnvelope(input: IssueEnvelopeInput): BoundedWorkEnvelope {
    return this.work.createBoundedEnvelope({
      ...input,
      workspace_id: this.context.workspace_id,
      issued_by: input.issued_by ?? {
        actor_type: "operator",
        actor_id: this.context.actor,
        display_name: null,
      },
    });
  }

  envelopes(workItemId: string): BoundedWorkEnvelope[] {
    return new BoundedWorkEnvelopeStore(this.database).listForWorkItem(
      this.context.workspace_id,
      workItemId,
    );
  }

  submitOutcome(input: SubmitOutcomeInput): WorkerOutcome {
    return this.work.submitWorkerOutcome({
      ...input,
      workspace_id: this.context.workspace_id,
      actor: this.context.actor,
    });
  }

  outcomes(workItemId: string): WorkerOutcome[] {
    return new WorkerOutcomeStore(this.database).listForWorkItem(
      this.context.workspace_id,
      workItemId,
    );
  }

  reviewWork(input: {
    work_item_id: string;
    decision: "accepted" | "changes_requested" | "rejected";
    notes?: string | null;
    idempotency_key?: string | null;
  }): WorkItem {
    return this.work.reviewWork({
      ...input,
      workspace_id: this.context.workspace_id,
      actor: this.context.actor,
    });
  }

  recordIngestion(input: RecordIngestionInput): IngestionRecord {
    return this.ingestions.record({
      ...input,
      workspace_id: this.context.workspace_id,
      source: input.source ?? {
        provider: "openmao-sdk",
        external_id: this.context.actor,
        external_url: null,
      },
      actor: input.actor ?? {
        // Provenance only: the recording authority is `recorded_by`, and an
        // SDK process is never an OpenMAO operator, so the default ref can
        // never claim operator authority.
        actor_type: this.context.actor_type ?? "system",
        actor_id: this.context.actor,
        display_name: null,
      },
      recorded_by: this.context.actor,
    });
  }

  ingestionRecords(): IngestionRecord[] {
    return new IngestionRecordStore(this.database).listForWorkspace(this.context.workspace_id);
  }

  events() {
    return new EventStore(this.database).listForWorkspace(this.context.workspace_id);
  }
}
