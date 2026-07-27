import {
  EventPayloadSchema,
  type ExternalActorRef,
  type ExternalSource,
  type IngestionRecord,
  IngestionRecordSchema,
  newId,
  utcNow,
} from "../contracts/index.js";
import type { Database } from "../persistence/database.js";
import {
  EventStore,
  IngestionRecordStore,
  RunStore,
  WorkerIdentityStore,
  WorkItemStore,
  WorkspaceStore,
} from "../persistence/index.js";
import {
  assertNoSensitiveMaterial,
  assertNoSensitiveString,
} from "../security/sensitive-material.js";

type RecordIngestionInput = {
  id?: string | null;
  workspace_id: string;
  source: ExternalSource;
  actor: ExternalActorRef;
  kind: IngestionRecord["kind"];
  target_run_id?: string | null;
  target_work_item_id?: string | null;
  payload?: Record<string, unknown>;
  occurred_at?: string | null;
  idempotency_key: string;
  /**
   * The authenticated principal recording this event. The EVENT's actor is
   * always this identity — the body's ExternalActorRef is foreign provenance
   * and lands in payload.actor_ref, so authority and provenance never mix.
   */
  recorded_by: string;
};

/**
 * An inbound foreign event can never claim OpenMAO operator authority: a body
 * asserting actor_type "operator" is refused outright, at the service layer so
 * every entry point (HTTP route, CLI) enforces it identically.
 */
export class OperatorActorRefusedError extends Error {}

export class IngestionService {
  private readonly events: EventStore;
  private readonly ingestions: IngestionRecordStore;
  private readonly runs: RunStore;
  private readonly workers: WorkerIdentityStore;
  private readonly workItems: WorkItemStore;
  private readonly workspaces: WorkspaceStore;

  constructor(private readonly database: Database) {
    this.events = new EventStore(database);
    this.ingestions = new IngestionRecordStore(database);
    this.runs = new RunStore(database);
    this.workers = new WorkerIdentityStore(database);
    this.workItems = new WorkItemStore(database);
    this.workspaces = new WorkspaceStore(database);
  }

  record(input: RecordIngestionInput): IngestionRecord {
    return this.database.transaction(() => {
      this.requireWorkspace(input.workspace_id);
      this.requireIdentity(input);
      this.requireTargets(input);
      const record = IngestionRecordSchema.parse({
        id: input.id ?? newId("ingest"),
        workspace_id: input.workspace_id,
        source: input.source,
        actor: input.actor,
        kind: input.kind,
        target_run_id: input.target_run_id ?? null,
        target_work_item_id: input.target_work_item_id ?? null,
        payload: input.payload ?? {},
        occurred_at: input.occurred_at ?? utcNow(),
        idempotency_key: input.idempotency_key,
      });
      const saved = this.ingestions.record(record);
      this.events.append({
        workspace_id: saved.workspace_id,
        run_id: saved.target_run_id,
        kind: "ingestion.recorded",
        // Authority is the authenticated principal; the foreign actor the body
        // named is provenance and rides payload.actor_ref — a field that
        // exists for exactly this purpose, so this closes the self-assertion
        // channel with zero schema change.
        actor: input.recorded_by,
        payload: EventPayloadSchema.parse({
          data: {
            ingestion_record: saved,
          },
          refs: [
            saved.id,
            ...(saved.target_run_id ? [saved.target_run_id] : []),
            ...(saved.target_work_item_id ? [saved.target_work_item_id] : []),
          ],
          actor_ref: saved.actor,
        }),
        idempotency_key: `${saved.id}:event`,
        timestamp: saved.occurred_at,
      });
      return saved;
    });
  }

  private requireWorkspace(workspaceId: string): void {
    if (!this.workspaces.get(workspaceId)) {
      throw new Error(`workspace not found: ${workspaceId}`);
    }
  }

  private requireIdentity(input: RecordIngestionInput): void {
    if (!input.idempotency_key.trim()) {
      throw new Error("ingestion idempotency key is required");
    }
    assertNoSensitiveString(input.idempotency_key, "ingestion.idempotency_key");
    if (!input.source.provider.trim()) {
      throw new Error("ingestion source provider is required");
    }
    assertNoSensitiveMaterial(input.source, "ingestion.source");
    assertNoSensitiveMaterial(input.actor, "ingestion.actor");
    assertNoSensitiveMaterial(input.payload ?? {}, "ingestion.payload");
    const sourceId = input.source.external_id?.trim() ?? "";
    const sourceUrl = input.source.external_url?.trim() ?? "";
    if (!sourceId && !sourceUrl) {
      throw new Error("ingestion source external identity is required");
    }
    if (!input.actor.actor_id.trim()) {
      throw new Error("ingestion actor identity is required");
    }
    if (input.actor.actor_type === "operator") {
      throw new OperatorActorRefusedError(
        "an inbound foreign event cannot claim OpenMAO operator authority (actor_type: operator)",
      );
    }
    if (input.actor.actor_type === "worker") {
      const worker = this.workers.get(input.actor.actor_id);
      if (!worker || worker.workspace_id !== input.workspace_id) {
        throw new Error(`ingestion worker actor not found in workspace: ${input.actor.actor_id}`);
      }
    }
  }

  private requireTargets(input: RecordIngestionInput): void {
    if (input.target_run_id) {
      const run = this.runs.get(input.target_run_id);
      if (!run || run.workspace_id !== input.workspace_id) {
        throw new Error(`target run not found in workspace: ${input.target_run_id}`);
      }
    }
    if (input.target_work_item_id) {
      const workItem = this.workItems.get(input.target_work_item_id);
      if (!workItem || workItem.workspace_id !== input.workspace_id) {
        throw new Error(`target work item not found in workspace: ${input.target_work_item_id}`);
      }
    }
  }
}
