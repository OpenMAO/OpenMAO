import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CapabilityCallSchema,
  CapabilitySchema,
  type ResourceGrants,
} from "../src/contracts/index.js";
import { Database } from "../src/persistence/index.js";
import { createLocalCapabilityRegistry } from "../src/runtime/capabilities.js";
import { SensitiveMaterialError } from "../src/security/sensitive-material.js";
import { SpineService, WORKSPACE_ID } from "../src/spine/index.js";
import { WorkService } from "../src/work/index.js";

const CAP = "mock.scoped_side_effect";
const HANDLE = "cred_mock_side_effect";
const WORKER_ID = "worker_55555555555555555555555555555555";

let tmpRoot: string;
let database: Database;
let registry: ReturnType<typeof createLocalCapabilityRegistry>;
let work: WorkService;
let seq: number;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "openmao-scoped-"));
  database = new Database(join(tmpRoot, "openmao.sqlite3"));
  database.initialize();
  new SpineService(database).initDemoWorkspace();
  registry = createLocalCapabilityRegistry(database);
  work = new WorkService(database);
  seq = 0;

  // A side-effecting capability that declares its resource fields (owner, repo). Input fields are
  // optional in the canonical schema so the resource-scope check (not schema validation) is what
  // rejects a missing resource.
  registry.register(
    CapabilitySchema.parse({
      name: CAP,
      workspace_id: WORKSPACE_ID,
      description: "A scoped side effect for testing resource grants.",
      tool_name: "mock.side_effect",
      // `repo` is intentionally left unconstrained (additionalProperties) so the resource-scope
      // strict-string guard — not the input schema — is what rejects a non-string repo value.
      canonical_input_schema: {
        type: "object",
        required: [],
        additionalProperties: true,
        properties: {
          owner: { type: "string" },
          message: { type: "string" },
        },
      },
      canonical_output_schema: {
        type: "object",
        required: ["provider", "effect", "handle"],
        properties: {
          provider: { type: "string" },
          effect: { type: "string" },
          handle: { type: "string" },
        },
      },
      providers: ["mock.side_effect"],
      side_effecting: true,
      credential_handle_required: true,
      credential_handle: HANDLE,
      default_permission: "approval_required",
      resource_fields: ["owner", "repo"],
    }),
  );
  work.registerWorker({
    id: WORKER_ID,
    workspace_id: WORKSPACE_ID,
    name: "Scoped Worker",
    runtime: "test",
    allowed_capabilities: [CAP],
    actor: "operator:test",
    idempotency_key: "scoped:worker",
  });
});

afterEach(() => {
  database.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

function seedEnvelope(grants: ResourceGrants): { taskId: string; runId: string } {
  seq += 1;
  const suffix = String(seq).padStart(32, "0");
  const runId = `run_${suffix}`;
  const taskId = `task_${suffix}`;
  const item = work.createWork({
    id: `work_${suffix}`,
    workspace_id: WORKSPACE_ID,
    title: "Scoped work",
    objective: "scope test",
    owner: WORKER_ID,
    reviewer: "human",
    actor: "operator:test",
    idempotency_key: `work_${suffix}:created`,
  });
  work.assignWork({
    workspace_id: WORKSPACE_ID,
    work_item_id: item.id,
    owner: WORKER_ID,
    reviewer: "human",
    actor: "operator:test",
    idempotency_key: `work_${suffix}:assigned`,
  });
  work.ensureExternalRun({
    id: runId,
    workspace_id: WORKSPACE_ID,
    active_node: "scoped",
    actor: "operator:test",
  });
  work.createBoundedEnvelope({
    id: `envelope_${suffix}`,
    workspace_id: WORKSPACE_ID,
    work_item_id: item.id,
    run_id: runId,
    task_envelope_id: taskId,
    worker_id: WORKER_ID,
    issued_by: { actor_type: "operator", actor_id: "operator:test", display_name: null },
    allowed_capabilities: [CAP],
    resource_grants: grants,
    idempotency_key: `envelope_${suffix}:created`,
  });
  return { taskId, runId };
}

async function outcomeFor(
  taskId: string,
  runId: string,
  input: Record<string, unknown>,
): Promise<string> {
  seq += 1;
  const invocation = await registry.invoke(
    CapabilityCallSchema.parse({
      id: `capcall_${String(seq).padStart(32, "0")}`,
      workspace_id: WORKSPACE_ID,
      run_id: runId,
      capability_name: CAP,
      provider: "mock.side_effect",
      input,
      requested_by: WORKER_ID,
      external_actor: { actor_type: "worker", actor_id: WORKER_ID, display_name: "Scoped Worker" },
      task_id: taskId,
      credential_handle: HANDLE,
      side_effecting: true,
      risk_level: "high",
      idempotency_key: `scoped:call:${seq}`,
    }),
  );
  return invocation.decision.outcome;
}

describe("scoped resource grants", () => {
  it("allows a call whose resource is within the bounded envelope's grant (governed, not blocked)", async () => {
    const { taskId, runId } = seedEnvelope({ [CAP]: { owner: ["aeonbilal"], repo: ["OpenMAO"] } });
    const outcome = await outcomeFor(taskId, runId, {
      owner: "aeonbilal",
      repo: "OpenMAO",
      message: "ok",
    });
    expect(outcome).not.toBe("block");
  });

  it("blocks a call whose resource value is outside the grant", async () => {
    const { taskId, runId } = seedEnvelope({ [CAP]: { owner: ["aeonbilal"], repo: ["OpenMAO"] } });
    const outcome = await outcomeFor(taskId, runId, {
      owner: "aeonbilal",
      repo: "victim-repo",
      message: "nope",
    });
    expect(outcome).toBe("block");
  });

  it("default-denies a declared resource field that the envelope did not grant", async () => {
    const { taskId, runId } = seedEnvelope({ [CAP]: { owner: ["aeonbilal"] } });
    const outcome = await outcomeFor(taskId, runId, {
      owner: "aeonbilal",
      repo: "OpenMAO",
      message: "repo not granted",
    });
    expect(outcome).toBe("block");
  });

  it("blocks a call that omits the scoped resource entirely", async () => {
    const { taskId, runId } = seedEnvelope({ [CAP]: { owner: ["aeonbilal"], repo: ["OpenMAO"] } });
    const outcome = await outcomeFor(taskId, runId, { message: "no resource specified" });
    expect(outcome).toBe("block");
  });

  it("does not let a non-string (array) resource value coerce past the grant", async () => {
    const { taskId, runId } = seedEnvelope({ [CAP]: { owner: ["aeonbilal"], repo: ["OpenMAO"] } });
    // `repo: ["OpenMAO"]` would String()-coerce to "OpenMAO" and slip past a loose check — strict
    // string matching blocks it so the provider can't read the array differently.
    const outcome = await outcomeFor(taskId, runId, { owner: "aeonbilal", repo: ["OpenMAO"] });
    expect(outcome).toBe("block");
  });

  it("rejects an envelope carrying a secret-shaped resource-grant value (never reaches the event log)", () => {
    // Resource grants ride the envelope into the append-only event log; a secret-shaped grant value
    // must be screened like every other operator-supplied free string before anything is persisted.
    // Built at runtime so the literal token shape never appears in tracked source (hygiene check).
    const tokenShaped = `ghp_${"a".repeat(36)}`;
    expect(() => seedEnvelope({ [CAP]: { owner: ["aeonbilal"], repo: [tokenShaped] } })).toThrow(
      SensitiveMaterialError,
    );
  });
});
