import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Database, EventStore, WorkItemStore } from "../src/persistence/index.js";
import { SpineService, WORKSPACE_ID } from "../src/spine/index.js";
import {
  approveReferenceWorkerDemo,
  REFERENCE_CAPABILITY_APPROVAL_ID,
  REFERENCE_CAPABILITY_CALL_ID,
  REFERENCE_INGESTION_ID,
  REFERENCE_OUTCOME_ID,
  REFERENCE_RUN_ID,
  REFERENCE_WORK_ID,
  REFERENCE_WORKER_ID,
  runReferenceWorkerDemo,
} from "../src/workers/index.js";
import { WorldModelService } from "../src/world/index.js";
import { createSigningOperator } from "./helpers/principals.js";

let tmpRoot: string;
let database: Database;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "openmao-ts-reference-worker-"));
  database = new Database(join(tmpRoot, "openmao.sqlite3"));
  database.initialize();
});

afterEach(() => {
  database.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("reference external worker", () => {
  it("suspends for approval, resumes idempotently, and projects into the world model", async () => {
    new SpineService(database).initDemoWorkspace();
    // The demo records under a genuinely authenticated operator — the demo
    // mock is not an identity and never appears as an actor. The approval is
    // signed by that operator's enrolled key.
    const operator = createSigningOperator(database, WORKSPACE_ID, "Demo Operator");
    const suspended = await runReferenceWorkerDemo(database, operator.principal);
    const replayedSuspension = await runReferenceWorkerDemo(database, operator.principal);
    const approved = await approveReferenceWorkerDemo(database, operator.signer);
    const replayedApproval = await approveReferenceWorkerDemo(database, operator.signer);
    const events = new EventStore(database).listForWorkspace(approved.workspace_id);
    const work = new WorkItemStore(database).get(REFERENCE_WORK_ID);
    const world = new WorldModelService(database).rebuild(approved.workspace_id, REFERENCE_RUN_ID);

    expect(replayedSuspension).toEqual(suspended);
    expect(replayedApproval).toEqual(approved);
    expect(suspended.status).toBe("suspended_approval");
    expect(suspended.capability_approval_id).toBe(REFERENCE_CAPABILITY_APPROVAL_ID);
    expect(suspended.capability_result_id).toBeNull();
    expect(approved.status).toBe("completed");
    expect(approved.worker_id).toBe(REFERENCE_WORKER_ID);
    expect(approved.capability_call_id).toBe(REFERENCE_CAPABILITY_CALL_ID);
    expect(approved.capability_result_id).toMatch(/^capresult_/);
    expect(approved.outcome_id).toBe(REFERENCE_OUTCOME_ID);
    expect(approved.ingestion_id).toBe(REFERENCE_INGESTION_ID);
    expect(approved.work_status).toBe("done");
    expect(work?.status).toBe("done");
    expect(events.map((event) => event.kind)).toEqual(
      expect.arrayContaining([
        "run.started",
        "worker.registered",
        "work.created",
        "work.assigned",
        "task.envelope.created",
        "work.envelope.created",
        "capability_call.persisted",
        "capability.requested",
        "policy.decision",
        "approval.requested",
        "approval.approved",
        "capability.completed",
        "work.outcome_submitted",
        "ingestion.recorded",
        "work.reviewed",
        "run.completed",
      ]),
    );
    expect(world.external_workers).toContain(REFERENCE_WORKER_ID);
    expect(world.recent_ingestions).toContain(REFERENCE_INGESTION_ID);
    // The approval went on the record under the AUTHENTICATED operator — the
    // hardcoded "reference_worker_demo" actor is gone from every event.
    const approvalEvent = events.find(
      (event) =>
        event.kind === "approval.approved" &&
        JSON.stringify(event.payload).includes(REFERENCE_CAPABILITY_APPROVAL_ID),
    );
    expect(approvalEvent?.actor).toBe(operator.principal.principal_id);
    expect(events.every((event) => event.actor !== "reference_worker_demo")).toBe(true);
  });
});
