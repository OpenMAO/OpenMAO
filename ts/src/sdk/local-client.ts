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
import {
  type AuthenticatedPrincipal,
  assertAuthenticatedPrincipal,
} from "../security/authenticated-principal.js";
import { WorkService } from "../work/index.js";

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

function issuerRef(principal: AuthenticatedPrincipal): ExternalActorRef {
  return {
    actor_type: principal.kind === "human" ? "operator" : principal.kind,
    actor_id: principal.actor,
    display_name: null,
  };
}

/**
 * The in-process SDK. There is no identity PARAMETER anywhere on this client:
 * the acting identity is the authenticated principal handed to the constructor
 * and nothing else — a caller cannot name the actor it records under, because
 * the type only exists behind the credential-resolution paths and the
 * constructor re-checks the brand at runtime. `recorded_by`, the event actor,
 * and the envelope's `issued_by` all derive from that one principal.
 */
export class OpenMaoLocalClient {
  private readonly ingestions: IngestionService;
  private readonly work: WorkService;
  private readonly workspaceId: string;
  private readonly actor: string;

  constructor(
    private readonly database: Database,
    private readonly principal: AuthenticatedPrincipal,
  ) {
    assertAuthenticatedPrincipal(principal);
    this.ingestions = new IngestionService(database);
    this.work = new WorkService(database);
    this.workspaceId = principal.workspace_id;
    this.actor = principal.actor;
  }

  registerWorker(input: RegisterWorkerInput): WorkerIdentity {
    return this.work.registerWorker({
      ...input,
      workspace_id: this.workspaceId,
      actor: this.actor,
    });
  }

  workers(): WorkerIdentity[] {
    return new WorkerIdentityStore(this.database).listForWorkspace(this.workspaceId);
  }

  createWork(input: CreateWorkInput): WorkItem {
    return this.work.createWork({
      ...input,
      workspace_id: this.workspaceId,
      actor: this.actor,
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
      workspace_id: this.workspaceId,
      actor: this.actor,
    });
  }

  workItems(): WorkItem[] {
    return new WorkItemStore(this.database).listForWorkspace(this.workspaceId);
  }

  issueEnvelope(input: IssueEnvelopeInput): BoundedWorkEnvelope {
    return this.work.createBoundedEnvelope({
      ...input,
      workspace_id: this.workspaceId,
      // The issuer is the authenticated principal — never an input field.
      issued_by: issuerRef(this.principal),
    });
  }

  envelopes(workItemId: string): BoundedWorkEnvelope[] {
    return new BoundedWorkEnvelopeStore(this.database).listForWorkItem(
      this.workspaceId,
      workItemId,
    );
  }

  submitOutcome(input: SubmitOutcomeInput): WorkerOutcome {
    return this.work.submitWorkerOutcome({
      ...input,
      workspace_id: this.workspaceId,
      actor: this.actor,
    });
  }

  outcomes(workItemId: string): WorkerOutcome[] {
    return new WorkerOutcomeStore(this.database).listForWorkItem(this.workspaceId, workItemId);
  }

  reviewWork(input: {
    work_item_id: string;
    decision: "accepted" | "changes_requested" | "rejected";
    notes?: string | null;
    idempotency_key?: string | null;
  }): WorkItem {
    return this.work.reviewWork({
      ...input,
      workspace_id: this.workspaceId,
      actor: this.actor,
    });
  }

  recordIngestion(input: RecordIngestionInput): IngestionRecord {
    return this.ingestions.record({
      ...input,
      workspace_id: this.workspaceId,
      source: input.source ?? {
        provider: "openmao-sdk",
        external_id: this.actor,
        external_url: null,
      },
      actor: input.actor ?? {
        // Provenance only: the recording authority is `recorded_by`, and the
        // default ref can never claim OpenMAO operator authority.
        actor_type: "system",
        actor_id: this.actor,
        display_name: null,
      },
      recorded_by: this.actor,
    });
  }

  ingestionRecords(): IngestionRecord[] {
    return new IngestionRecordStore(this.database).listForWorkspace(this.workspaceId);
  }

  events() {
    return new EventStore(this.database).listForWorkspace(this.workspaceId);
  }
}
