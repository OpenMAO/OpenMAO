import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WorkspaceSchema } from "../src/contracts/index.js";
import { Database, EventStore, WorkspaceStore } from "../src/persistence/index.js";
import { OpenMaoLocalClient } from "../src/sdk/index.js";
import type { AuthenticatedPrincipal } from "../src/security/authenticated-principal.js";
import { authenticateOperatorPrincipal } from "./helpers/principals.js";

const fixturePath = new URL("../../tests/fixtures/canonical_v0.json", import.meta.url);

let tmpRoot: string;
let database: Database;

async function loadFixture(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(fixturePath, "utf8")) as Record<string, unknown>;
}

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), "openmao-ts-sdk-"));
  database = new Database(join(tmpRoot, "openmao.sqlite3"));
  database.initialize();
  const fixture = await loadFixture();
  new WorkspaceStore(database).save(WorkspaceSchema.parse(fixture.workspace));
});

afterEach(() => {
  database.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("local SDK client", () => {
  it("lets a governed worker flow use services without importing stores", async () => {
    const fixture = await loadFixture();
    const workspaceId = (fixture.workspace as { id: string }).id;
    // The acting identity is a principal authenticated through the ordinary
    // credential path — there is no actor parameter to name.
    const operator = authenticateOperatorPrincipal(database, workspaceId, "SDK Operator");
    const client = new OpenMaoLocalClient(database, operator);

    const worker = client.registerWorker({
      id: "worker_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      name: "SDK Reference Worker",
      runtime: "openmao.sdk.test",
      allowed_capabilities: ["mock.research_lookup"],
      idempotency_key: "sdk:worker:register",
    });
    const work = client.createWork({
      id: "work_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      title: "SDK governed work",
      objective: "Demonstrate service-backed SDK worker flow.",
      owner: "sdk_operator",
      reviewer: "human",
      success_criteria: ["outcome is reviewable"],
      idempotency_key: "sdk:work:create",
    });
    const assigned = client.assignWork({
      work_item_id: work.id,
      owner: worker.id,
      idempotency_key: "sdk:work:assign",
    });
    const envelope = client.issueEnvelope({
      id: "envelope_cccccccccccccccccccccccccccccccc",
      work_item_id: work.id,
      worker_id: worker.id,
      input: { task: "prepare update" },
      idempotency_key: "sdk:work:envelope",
    });
    const outcome = client.submitOutcome({
      id: "outcome_dddddddddddddddddddddddddddddddd",
      envelope_id: envelope.id,
      worker_id: worker.id,
      status: "completed",
      summary: "SDK worker completed the bounded task.",
      output: { ready: true },
      idempotency_key: "sdk:work:outcome",
    });
    const ingestion = client.recordIngestion({
      id: "ingest_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      kind: "trace",
      target_work_item_id: work.id,
      payload: { node: "sdk_worker.completed" },
      idempotency_key: "sdk:ingestion:trace",
    });
    const reviewed = client.reviewWork({
      work_item_id: work.id,
      decision: "accepted",
      idempotency_key: "sdk:work:review",
    });

    expect(client.workers()).toEqual([worker]);
    expect(client.workItems().map((item) => item.id)).toEqual([work.id]);
    expect(assigned.status).toBe("in_progress");
    expect(client.envelopes(work.id)).toEqual([envelope]);
    expect(client.outcomes(work.id)).toEqual([outcome]);
    expect(client.ingestionRecords()).toEqual([ingestion]);
    expect(reviewed.status).toBe("done");
    expect(client.events().map((event) => event.kind)).toEqual([
      "worker.registered",
      "work.created",
      "work.assigned",
      "work.envelope.created",
      "work.outcome_submitted",
      "ingestion.recorded",
      "work.reviewed",
    ]);
    // Every authority-bearing event is recorded under the authenticated
    // principal — the envelope's issuer is derived from it, never from input.
    const events = client.events();
    const byKind = new Map(events.map((event) => [event.kind, event]));
    expect(byKind.get("work.created")?.actor).toBe(operator.principal_id);
    expect(byKind.get("ingestion.recorded")?.actor).toBe(operator.principal_id);
    expect(envelope.issued_by).toEqual({
      actor_type: "operator",
      actor_id: operator.principal_id,
      display_name: null,
    });
  });

  it("cannot be constructed with a hand-built identity — no actor parameter exists", async () => {
    const fixture = await loadFixture();
    const workspaceId = (fixture.workspace as { id: string }).id;
    // The old {workspace_id, actor} context no longer typechecks; this drives
    // the same shape through a cast to prove it also fails AT RUNTIME — a
    // caller cannot record an event attributed to an identity it did not
    // authenticate as, typed or not.
    const forged = { workspace_id: workspaceId, actor: "mallory" };
    expect(
      () => new OpenMaoLocalClient(database, forged as unknown as AuthenticatedPrincipal),
    ).toThrow(/identity must be an authenticated principal/);
    // A structurally complete but unauthenticated lookalike fails the same way.
    const lookalike = {
      principal_id: "principal_mallory",
      workspace_id: workspaceId,
      kind: "human",
      actor: "principal_mallory",
      key_id: null,
      can_sign: false,
      dev_bootstrap: false,
    };
    expect(
      () => new OpenMaoLocalClient(database, lookalike as unknown as AuthenticatedPrincipal),
    ).toThrow(/identity must be an authenticated principal/);
    expect(new EventStore(database).listForWorkspace(workspaceId)).toHaveLength(0);
  });
});
