import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createServer } from "../src/api/server.js";
import { DiagnosisService } from "../src/diagnosis/index.js";
import { Database, EventStore } from "../src/persistence/index.js";
import { type CapabilityCallRequest, ExternalWorkerClient } from "../src/sdk/index.js";
import { WorkerAuthService } from "../src/security/worker-auth.js";
import { WORKSPACE_ID } from "../src/spine/index.js";
import {
  prepareReferenceWorkerDemo,
  REFERENCE_CREDENTIAL_HANDLE,
  REFERENCE_ENVELOPE_ID,
  REFERENCE_RUN_ID,
  REFERENCE_TASK_ID,
  REFERENCE_WORK_ID,
  REFERENCE_WORKER_ID,
} from "../src/workers/index.js";

const OPERATOR_TOKEN = "test-operator-token";
const MOCK_SECRET = "local_mock_secret_do_not_serialize";

let tmpRoot: string;
let dbPath: string;
let server: Server;
let serverOpen = false;
let baseUrl: string;
let workerToken: string;

function call(overrides: Partial<CapabilityCallRequest>): CapabilityCallRequest {
  // No requested_by / external_actor — the worker's identity is forced server-side from its token.
  return {
    run_id: REFERENCE_RUN_ID,
    capability_name: "mock.side_effect.record",
    provider: "mock.side_effect",
    input: { message: "external worker over HTTP" },
    task_id: REFERENCE_TASK_ID,
    credential_handle: REFERENCE_CREDENTIAL_HANDLE,
    side_effecting: true,
    risk_level: "high",
    idempotency_key: "hermes:capability",
    ...overrides,
  };
}

async function stopServer(): Promise<void> {
  if (!serverOpen) {
    return;
  }
  serverOpen = false;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), "openmao-ext-client-"));
  dbPath = join(tmpRoot, "openmao.sqlite3");
  const database = new Database(dbPath);
  database.initialize();
  prepareReferenceWorkerDemo(database);
  workerToken = new WorkerAuthService(database).mint({
    workspace_id: WORKSPACE_ID,
    worker_id: REFERENCE_WORKER_ID,
  }).token;
  database.close();

  server = createServer({ dbPath, operatorToken: OPERATOR_TOKEN, workspaceId: WORKSPACE_ID });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  serverOpen = true;
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await stopServer();
  rmSync(tmpRoot, { recursive: true, force: true });
});

function newClient(): ExternalWorkerClient {
  return new ExternalWorkerClient({ baseUrl, workerToken });
}

describe("ExternalWorkerClient — out-of-process governed work end to end over HTTP", () => {
  it("requests a governed side effect that suspends for approval, then reports a failed outcome that is diagnosable", async () => {
    const client = newClient();

    // 1. A within-envelope side-effecting request SUSPENDS for approval — governed, not executed.
    const suspended = await client.requestCapability(
      call({ id: "capcall_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", idempotency_key: "hermes:within" }),
    );
    expect(suspended.approval_id).toBeTruthy();
    expect(suspended.result ?? null).toBeNull();

    // 2. The worker reports a FAILED outcome back into the org record over HTTP.
    const outcome = await client.submitOutcome(REFERENCE_WORK_ID, {
      envelope_id: REFERENCE_ENVELOPE_ID,
      status: "failed",
      summary: "Could not complete the bounded task within its granted authority.",
      idempotency_key: "hermes:outcome:failed",
    });
    expect(outcome.status).toBe("failed");

    // 3. The failure is diagnosable end to end: trace the failed outcome back to the work's origin.
    await stopServer();
    const database = new Database(dbPath);
    database.initialize();
    const events = new EventStore(database).listForWorkspace(WORKSPACE_ID);
    const failed = events.find((event) => event.kind === "work.outcome_submitted");
    const created = events.find((event) => event.kind === "work.created");
    if (!failed || !created) {
      throw new Error("expected work.created and work.outcome_submitted events");
    }
    const diagnosis = new DiagnosisService(database).diagnose({
      workspace_id: WORKSPACE_ID,
      failure_event_id: failed.id,
    });
    database.close();

    expect(diagnosis.candidates.map((candidate) => candidate.event_id)).toContain(created.id);
    expect(JSON.stringify(diagnosis)).not.toContain(MOCK_SECRET);
  });

  it("is gated by the bounded envelope: an out-of-bounds request is blocked over the wire", async () => {
    const client = newClient();
    // A mismatched credential handle cannot steer the broker to another credential — it is blocked,
    // not executed, and surfaces to the worker as a block decision (not a thrown error).
    const blocked = await client.requestCapability(
      call({
        id: "capcall_ffffffffffffffffffffffffffffffff",
        credential_handle: "cred_unbound_handle",
        idempotency_key: "hermes:blocked",
      }),
    );
    expect((blocked.decision as { outcome: string }).outcome).toBe("block");
  });
});
