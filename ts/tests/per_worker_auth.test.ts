import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createServer } from "../src/api/server.js";
import { CapabilityCallSchema, CapabilityResultSchema } from "../src/contracts/index.js";
import { CapabilityCallStore, CapabilityResultStore, Database } from "../src/persistence/index.js";
import { WorkerAuthService } from "../src/security/worker-auth.js";
import { WORKSPACE_ID } from "../src/spine/index.js";
import {
  prepareReferenceWorkerDemo,
  REFERENCE_CREDENTIAL_HANDLE,
  REFERENCE_RUN_ID,
  REFERENCE_TASK_ID,
  REFERENCE_WORK_ID,
  REFERENCE_WORKER_ID,
} from "../src/workers/index.js";

const OPERATOR_TOKEN = "test-operator-token";

let tmpRoot: string;
let dbPath: string;
let server: Server;
let baseUrl: string;
let workerToken: string;

type Res = {
  status: number;
  // biome-ignore lint/suspicious/noExplicitAny: test asserts on a dynamic JSON response shape.
  json: any;
};

async function req(
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<Res> {
  const init: RequestInit = {
    method,
    headers: { "content-type": "application/json", ...headers },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}

const workerHeaders = (): Record<string, string> => ({ "x-openmao-worker-token": workerToken });
const operatorHeaders = (): Record<string, string> => ({
  "x-openmao-operator-token": OPERATOR_TOKEN,
  "x-openmao-actor": "operator",
});

function capabilityCallBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    run_id: REFERENCE_RUN_ID,
    capability_name: "mock.side_effect.record",
    provider: "mock.side_effect",
    input: { message: "x" },
    task_id: REFERENCE_TASK_ID,
    credential_handle: REFERENCE_CREDENTIAL_HANDLE,
    side_effecting: true,
    risk_level: "high",
    idempotency_key: "pwa:call",
    ...overrides,
  };
}

// Seed a completed capability call + its result for `workerId`, returning the result's id. Written
// straight to the shared sqlite file (the server reads the same path) so the read-scoping route can
// be probed deterministically without driving a full approve/execute cycle.
function seedResultForWorker(suffix: string, workerId: string): string {
  const callId = `capcall_${suffix}`;
  const resultId = `capresult_${suffix}`;
  const database = new Database(dbPath);
  try {
    new CapabilityCallStore(database).record(
      CapabilityCallSchema.parse({
        id: callId,
        workspace_id: WORKSPACE_ID,
        run_id: REFERENCE_RUN_ID,
        capability_name: "mock.side_effect.record",
        provider: "mock.side_effect",
        input: { message: "seeded" },
        requested_by: workerId,
        task_id: REFERENCE_TASK_ID,
        credential_handle: REFERENCE_CREDENTIAL_HANDLE,
        side_effecting: true,
        risk_level: "high",
        idempotency_key: `pwa:seed:${suffix}`,
      }),
    );
    new CapabilityResultStore(database).record(
      CapabilityResultSchema.parse({
        id: resultId,
        workspace_id: WORKSPACE_ID,
        run_id: REFERENCE_RUN_ID,
        call_id: callId,
        status: "ok",
        output: { ok: true },
      }),
    );
  } finally {
    database.close();
  }
  return resultId;
}

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), "openmao-pwa-"));
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
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("per-worker auth", () => {
  it("lets a worker token request a capability AS ITSELF — identity is forced from the token", async () => {
    const { status, json } = await req(
      "POST",
      "/capability-calls",
      workerHeaders(),
      // The body tries to name another worker; the route ignores it and forces the token's worker.
      capabilityCallBody({ requested_by: "worker_imposter", idempotency_key: "pwa:self" }),
    );
    expect(status).toBe(200);
    expect(json.call.requested_by).toBe(REFERENCE_WORKER_ID);
    expect(json.approval_id).toBeTruthy();
  });

  it("forbids a worker token from issuing itself an envelope (operator-only)", async () => {
    const { status, json } = await req(
      "POST",
      `/work/${REFERENCE_WORK_ID}/envelopes`,
      workerHeaders(),
      {
        worker_id: REFERENCE_WORKER_ID,
        run_id: REFERENCE_RUN_ID,
        allowed_capabilities: ["mock.side_effect.record"],
        resource_grants: {},
      },
    );
    expect(status).toBe(403);
    expect(json.error).toBe("worker_forbidden");
  });

  it("forbids a worker token from approving a capability call", async () => {
    const { status } = await req(
      "POST",
      "/approvals/approval_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/approve",
      workerHeaders(),
      {},
    );
    expect(status).toBe(403);
  });

  it("rejects an invalid worker token", async () => {
    const { status } = await req(
      "POST",
      "/capability-calls",
      { "x-openmao-worker-token": "wkr_invalid" },
      capabilityCallBody({ idempotency_key: "pwa:invalid" }),
    );
    expect(status).toBe(403);
  });

  it("still lets the operator issue an envelope — operator retains full authority", async () => {
    const { status } = await req(
      "POST",
      `/work/${REFERENCE_WORK_ID}/envelopes`,
      operatorHeaders(),
      {
        id: "envelope_dddddddddddddddddddddddddddddddd",
        worker_id: REFERENCE_WORKER_ID,
        run_id: REFERENCE_RUN_ID,
        allowed_capabilities: ["mock.side_effect.record"],
      },
    );
    expect(status).not.toBe(403);
  });

  it("scopes a worker's reads to its OWN records (no workspace-wide leakage)", async () => {
    // The operator records a call attributed to a different worker.
    await req(
      "POST",
      "/capability-calls",
      operatorHeaders(),
      capabilityCallBody({
        requested_by: "worker_other",
        external_actor: { actor_type: "worker", actor_id: "worker_other", display_name: null },
        idempotency_key: "pwa:other",
      }),
    );
    // The worker records its own call.
    await req(
      "POST",
      "/capability-calls",
      workerHeaders(),
      capabilityCallBody({ idempotency_key: "pwa:mine" }),
    );

    const { json } = await req("GET", "/capability-calls", workerHeaders());
    const requesters = new Set(
      (json as Array<{ requested_by: string }>).map((c) => c.requested_by),
    );
    expect(requesters.has(REFERENCE_WORKER_ID)).toBe(true);
    expect(requesters.has("worker_other")).toBe(false);
  });

  it("does not let a worker read another worker's capability result via GET /capability-results", async () => {
    // The route filters results to the caller worker's OWN call ids. Seed one result for another
    // worker and one for the reference worker, then prove the worker's read returns only its own
    // result id and never the other worker's — there is no by-id path that leaks across workers.
    const otherResultId = seedResultForWorker("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "worker_other");
    const ownResultId = seedResultForWorker(
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      REFERENCE_WORKER_ID,
    );

    const { status, json } = await req("GET", "/capability-results", workerHeaders());
    expect(status).toBe(200);
    const visibleIds = new Set((json as Array<{ id: string }>).map((r) => r.id));
    expect(visibleIds.has(ownResultId)).toBe(true);
    expect(visibleIds.has(otherResultId)).toBe(false);
  });

  it("rejects a whitespace-only operator actor over HTTP with 400 missing_actor", async () => {
    // A blank actor cannot anchor an audit trail; the operator boundary treats "   " exactly like a
    // missing actor header so merge order with the approval-integrity work can never regress it.
    const { status, json } = await req("GET", "/capability-calls", {
      "x-openmao-operator-token": OPERATOR_TOKEN,
      "x-openmao-actor": "   ",
    });
    expect(status).toBe(400);
    expect(json.error).toBe("missing_actor");
  });

  it("maps an idempotency-key conflict (same key, different id) to 409, not 500", async () => {
    // Reusing an idempotency key for a DIFFERENT call id is a client-side conflict. The store raises
    // CapabilityCallConflictError; the route must surface it as 409 with a scrubbed code, never a 500.
    const first = await req(
      "POST",
      "/capability-calls",
      operatorHeaders(),
      capabilityCallBody({
        id: "capcall_11111111111111111111111111111111",
        idempotency_key: "pwa:conflict",
      }),
    );
    expect(first.status).toBe(200);
    const conflict = await req(
      "POST",
      "/capability-calls",
      operatorHeaders(),
      capabilityCallBody({
        id: "capcall_22222222222222222222222222222222",
        idempotency_key: "pwa:conflict",
      }),
    );
    expect(conflict.status).toBe(409);
    expect(conflict.json.error).toBe("capability_call_conflict");
  });
});
