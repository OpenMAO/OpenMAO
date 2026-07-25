import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createServer } from "../src/api/server.js";
import { Database } from "../src/persistence/index.js";
import { WORKSPACE_ID } from "../src/spine/index.js";
import {
  prepareReferenceWorkerDemo,
  REFERENCE_CREDENTIAL_HANDLE,
  REFERENCE_RUN_ID,
  REFERENCE_TASK_ID,
  REFERENCE_WORKER_ID,
} from "../src/workers/index.js";

const OPERATOR_TOKEN = "test-operator-token";
const MOCK_SECRET = "local_mock_secret_do_not_serialize";

let tmpRoot: string;
let dbPath: string;
let server: Server;
let baseUrl: string;

type CallResponse = {
  status: number;
  // biome-ignore lint/suspicious/noExplicitAny: test asserts on a dynamic JSON invocation shape.
  json: any;
  text: string;
};

async function postCall(body: Record<string, unknown>): Promise<CallResponse> {
  const response = await fetch(`${baseUrl}/capability-calls`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-openmao-operator-token": OPERATOR_TOKEN,
      "x-openmao-actor": "external-worker-test",
      "x-openmao-workspace": WORKSPACE_ID,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null, text };
}

function withinEnvelopeCall(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    run_id: REFERENCE_RUN_ID,
    capability_name: "mock.side_effect.record",
    provider: "mock.side_effect",
    input: { message: "external worker over HTTP" },
    requested_by: REFERENCE_WORKER_ID,
    external_actor: {
      actor_type: "worker",
      actor_id: REFERENCE_WORKER_ID,
      display_name: "Reference External Worker",
    },
    task_id: REFERENCE_TASK_ID,
    credential_handle: REFERENCE_CREDENTIAL_HANDLE,
    side_effecting: true,
    risk_level: "high",
    idempotency_key: "http-test:within-envelope",
    ...overrides,
  };
}

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), "openmao-ext-worker-"));
  dbPath = join(tmpRoot, "openmao.sqlite3");
  const database = new Database(dbPath);
  database.initialize();
  // Seed worker/work/run/envelope/task/capability WITHOUT invoking — run stays `running`.
  prepareReferenceWorkerDemo(database);
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

describe("POST /capability-calls — external-worker capability-initiate route", () => {
  it("suspends a within-envelope side-effecting call for approval without executing the provider", async () => {
    const { status, json } = await postCall(withinEnvelopeCall());
    expect(status).toBe(200);
    expect(json.call.workspace_id).toBe(WORKSPACE_ID);
    expect(json.approval_id).toBeTruthy();
    // Pending — the provider has not run and there is no successful result yet.
    expect(json.result ?? null).toBeNull();
  });

  it("blocks a call whose credential handle does not match the capability's bound handle", async () => {
    const { status, json } = await postCall(
      withinEnvelopeCall({
        credential_handle: "cred_other_secret",
        idempotency_key: "http-test:bad-handle",
      }),
    );
    expect(status).toBe(200);
    expect(json.decision.outcome).toBe("block");
    expect(json.result?.status).toBe("blocked");
  });

  it("blocks a call whose requested_by is not the bounded envelope's assignee", async () => {
    const { status, json } = await postCall(
      withinEnvelopeCall({
        requested_by: "worker_intruder",
        external_actor: {
          actor_type: "worker",
          actor_id: "worker_intruder",
          display_name: "Intruder",
        },
        idempotency_key: "http-test:wrong-worker",
      }),
    );
    expect(status).toBe(200);
    expect(json.decision.outcome).toBe("block");
  });

  it("forces the call into the authenticated workspace even if the body claims another", async () => {
    const { status, json } = await postCall(
      withinEnvelopeCall({ workspace_id: "ws_attacker", idempotency_key: "http-test:ws-forcing" }),
    );
    expect(status).toBe(200);
    expect(json.call.workspace_id).toBe(WORKSPACE_ID);
  });

  it("is idempotent on replay — the same call id + key returns the same call, recorded once", async () => {
    // A real worker owns a stable call id for the logical action; replaying it (e.g. after a crash)
    // must return the same call, not double-record. (A replay that mints a fresh id for the same key
    // is correctly rejected as a conflict — the caller is responsible for a stable id.)
    const replayCall = withinEnvelopeCall({
      id: "capcall_dddddddddddddddddddddddddddddddd",
      idempotency_key: "http-test:replay",
    });
    const first = await postCall(replayCall);
    const second = await postCall(replayCall);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.json.call.id).toBe(second.json.call.id);
  });

  it("never serializes the provider secret into the response", async () => {
    const { text } = await postCall(withinEnvelopeCall({ idempotency_key: "http-test:no-secret" }));
    expect(text).not.toContain(MOCK_SECRET);
  });

  it("rejects a malformed call body with 400, not a 500", async () => {
    const { status, json } = await postCall(
      withinEnvelopeCall({ risk_level: "extreme", idempotency_key: "http-test:malformed" }),
    );
    expect(status).toBe(400);
    expect(json.error).toBeTruthy();
    expect(json.error).not.toContain(MOCK_SECRET);
  });

  it("rejects body-controlled actor material that looks like a secret (4xx, scrubbed)", async () => {
    // external_actor.display_name is persisted + emitted, so it must pass the sensitive-material
    // perimeter. A token-shaped display name is rejected before any record/emit, and the secret-ish
    // value is never echoed back.
    // Built at runtime so the literal token shape never appears in tracked source (hygiene check).
    const tokenShaped = `ghp_${"a".repeat(36)}`;
    const { status, json } = await postCall(
      withinEnvelopeCall({
        external_actor: {
          actor_type: "worker",
          actor_id: REFERENCE_WORKER_ID,
          display_name: tokenShaped,
        },
        idempotency_key: "http-test:sensitive-actor",
      }),
    );
    expect(status).toBe(400);
    expect(JSON.stringify(json)).not.toContain(tokenShaped);
  });

  it("rejects a call with an empty idempotency key (400)", async () => {
    const { status, json } = await postCall(withinEnvelopeCall({ idempotency_key: "" }));
    expect(status).toBe(400);
    expect(json.error).toContain("idempotency_key");
  });
});
