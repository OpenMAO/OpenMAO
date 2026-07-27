import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createServer } from "../src/api/server.js";
import { runCli } from "../src/cli.js";
import { WorkItemSchema, WorkspaceSchema } from "../src/contracts/index.js";
import { OrgChangeService } from "../src/org/index.js";
import { Database, WorkItemStore, WorkspaceStore } from "../src/persistence/index.js";
import {
  COORDINATOR_AGENT_ID,
  PROMOTION_APPROVAL_ID,
  RUN_ID,
  WORK_ITEM_ID,
  WORKSPACE_ID,
} from "../src/spine/index.js";
import {
  REFERENCE_CAPABILITY_APPROVAL_ID,
  REFERENCE_RUN_ID,
  REFERENCE_WORKER_ID,
} from "../src/workers/index.js";
import { principalHeaders, seedPrincipalAtPath } from "./helpers/principals.js";

let tmpRoot: string;
let dbPath: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "openmao-ts-surfaces-"));
  dbPath = join(tmpRoot, "openmao.sqlite3");
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function capture(): { lines: string[]; write: (message: string) => void } {
  const lines: string[] = [];
  return { lines, write: (message: string) => lines.push(message) };
}

describe("TypeScript operator surfaces", () => {
  it("runs demo and approval through the CLI", async () => {
    const demoOutput = capture();
    const approvalOutput = capture();
    const worldOutput = capture();

    expect(await runCli(["demo"], { dbPath, write: demoOutput.write })).toBe(0);
    expect(JSON.parse(demoOutput.lines[0] ?? "{}").status).toBe("suspended_approval");
    const resumeOutput = capture();
    expect(await runCli(["run", "resume"], { dbPath, write: resumeOutput.write })).toBe(0);
    expect(JSON.parse(resumeOutput.lines[0] ?? "{}").status).toBe("suspended_approval");

    expect(await runCli(["approvals", "list"], { dbPath, write: approvalOutput.write })).toBe(0);
    expect(JSON.parse(approvalOutput.lines[0] ?? "[]")[0].id).toBe(PROMOTION_APPROVAL_ID);

    await expect(
      runCli(
        [
          "approvals",
          "approve",
          PROMOTION_APPROVAL_ID,
          "--workspace",
          "ws_22222222222222222222222222222222",
        ],
        { dbPath },
      ),
    ).rejects.toThrow("approval does not belong to workspace");
    expect(await runCli(["approvals", "approve", PROMOTION_APPROVAL_ID], { dbPath })).toBe(0);
    expect(await runCli(["world"], { dbPath, write: worldOutput.write })).toBe(0);
    expect(JSON.parse(worldOutput.lines[0] ?? "{}").latest_run_status).toBe("completed");
    const workspaceWorldOutput = capture();
    expect(
      await runCli(["world", "--workspace", WORKSPACE_ID], {
        dbPath,
        write: workspaceWorldOutput.write,
      }),
    ).toBe(0);
    expect(JSON.parse(workspaceWorldOutput.lines[0] ?? "{}").latest_run_status).toBe("completed");
    const workspaceEventsOutput = capture();
    expect(
      await runCli(["events", "--workspace", WORKSPACE_ID], {
        dbPath,
        write: workspaceEventsOutput.write,
      }),
    ).toBe(0);
    expect(JSON.parse(workspaceEventsOutput.lines[0] ?? "[]").length).toBeGreaterThan(0);
    const consoleOutput = capture();
    expect(await runCli(["console"], { dbPath, write: consoleOutput.write })).toBe(0);
    expect(consoleOutput.lines[0]).toContain("127.0.0.1");

    const runEventsOutput = capture();
    expect(
      await runCli(["events", RUN_ID], {
        dbPath,
        write: runEventsOutput.write,
      }),
    ).toBe(0);
    expect(JSON.parse(runEventsOutput.lines[0] ?? "[]").length).toBeGreaterThan(0);
  });

  it("shares one state dir between the demo and the Chief of Staff without colliding (#106)", async () => {
    // Regression: the completed demo mutates the seeded work item (status -> "done"), and a
    // later `cos init`/`cos tick` re-runs initDemoWorkspace() against the same database. The
    // seeder must adopt the existing work item instead of throwing "work item already exists".
    const demoOutput = capture();
    const approveOutput = capture();
    const initOutput = capture();
    const tickOutput = capture();
    const at = "2026-03-01T00:00:00Z";

    expect(await runCli(["demo"], { dbPath, write: demoOutput.write })).toBe(0);
    expect(await runCli(["demo-approve"], { dbPath, write: approveOutput.write })).toBe(0);
    expect(JSON.parse(approveOutput.lines[0] ?? "{}").status).toBe("completed");

    expect(await runCli(["cos", "init", "--at", at], { dbPath, write: initOutput.write })).toBe(0);
    expect(JSON.parse(initOutput.lines[0] ?? "[]").length).toBeGreaterThan(0);
    expect(await runCli(["cos", "tick", "--at", at], { dbPath, write: tickOutput.write })).toBe(0);
    const tick = JSON.parse(tickOutput.lines[0] ?? "{}") as {
      fired: unknown[];
      notification_count: number;
    };
    expect(tick.fired.length).toBeGreaterThan(0);
    expect(tick.notification_count).toBeGreaterThan(0);

    // Adoption, not reset: re-seeding must keep the completed demo work item intact.
    const database = new Database(dbPath);
    try {
      expect(new WorkItemStore(database).get(WORK_ITEM_ID)?.status).toBe("done");
    } finally {
      database.close();
    }
  });

  it("refuses to adopt a tampered work item occupying the demo work-item id (#106 audit P2)", async () => {
    // The re-entrant seeder may only adopt the demo fixture itself: `status` is the sole
    // field the demo lifecycle mutates, so a row that differs in any other field is a
    // foreign work item and must surface as a conflict instead of being silently adopted
    // while later demo events assume the fixture's owner/objective values.
    expect(await runCli(["demo"], { dbPath })).toBe(0);

    const tamperDatabase = new Database(dbPath);
    try {
      const store = new WorkItemStore(tamperDatabase);
      const seeded = store.get(WORK_ITEM_ID);
      expect(seeded?.status).toBe("queued");
      store.update(
        WorkItemSchema.parse({
          ...seeded,
          objective: "Audit production access controls.",
          owner: "agent_ffffffffffffffffffffffffffffffff",
        }),
      );
    } finally {
      tamperDatabase.close();
    }

    const conflictMessage = `work item already exists and does not match the demo fixture: ${WORK_ITEM_ID}`;
    await expect(
      runCli(["cos", "init", "--at", "2026-03-01T00:00:00Z"], { dbPath }),
    ).rejects.toThrow(conflictMessage);
    await expect(runCli(["demo"], { dbPath })).rejects.toThrow(conflictMessage);

    // The conflict must leave the tampered row untouched, not reset it to the fixture.
    const database = new Database(dbPath);
    try {
      const row = new WorkItemStore(database).get(WORK_ITEM_ID);
      expect(row?.objective).toBe("Audit production access controls.");
      expect(row?.owner).toBe("agent_ffffffffffffffffffffffffffffffff");
    } finally {
      database.close();
    }
  });

  it("creates work, registers a worker, and issues bounded envelopes through the CLI", async () => {
    const initOutput = capture();
    const workerOutput = capture();
    const workOutput = capture();
    const assignOutput = capture();
    const envelopeOutput = capture();
    const envelopesOutput = capture();
    const outcomeOutput = capture();
    const outcomesOutput = capture();
    const reviewOutput = capture();
    const ingestOutput = capture();
    const ingestionListOutput = capture();

    expect(await runCli(["init"], { dbPath, write: initOutput.write })).toBe(0);
    expect(
      await runCli(
        [
          "workers",
          "register",
          "--id",
          "worker_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "--name",
          "Reference Worker",
          "--runtime",
          "openmao.example.worker",
          "--capabilities",
          "mock.research_lookup",
        ],
        { dbPath, write: workerOutput.write },
      ),
    ).toBe(0);
    expect(
      await runCli(
        [
          "work",
          "create",
          "--id",
          "work_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "--title",
          "Prepare governed update",
          "--objective",
          "Prepare a governed update for review.",
          "--owner",
          "role_33333333333333333333333333333",
          "--reviewer",
          "human",
          "--criteria",
          "bounded envelope exists,events are inspectable",
        ],
        { dbPath, write: workOutput.write },
      ),
    ).toBe(0);
    expect(
      await runCli(
        [
          "work",
          "assign",
          "work_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "--owner",
          "worker_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ],
        { dbPath, write: assignOutput.write },
      ),
    ).toBe(0);
    expect(
      await runCli(
        [
          "work",
          "envelope",
          "work_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "--id",
          "envelope_cccccccccccccccccccccccccccccccc",
          "--worker",
          "worker_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "--capabilities",
          "mock.research_lookup",
          "--input",
          '{"topic":"governed update"}',
        ],
        { dbPath, write: envelopeOutput.write },
      ),
    ).toBe(0);
    expect(
      await runCli(["work", "envelopes", "work_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"], {
        dbPath,
        write: envelopesOutput.write,
      }),
    ).toBe(0);
    expect(
      await runCli(
        [
          "work",
          "outcome",
          "work_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "--id",
          "outcome_dddddddddddddddddddddddddddddddd",
          "--envelope",
          "envelope_cccccccccccccccccccccccccccccccc",
          "--worker",
          "worker_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "--status",
          "completed",
          "--summary",
          "Prepared the governed update.",
          "--output",
          '{"ready":true}',
        ],
        { dbPath, write: outcomeOutput.write },
      ),
    ).toBe(0);
    expect(
      await runCli(["work", "outcomes", "work_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"], {
        dbPath,
        write: outcomesOutput.write,
      }),
    ).toBe(0);
    expect(
      await runCli(["work", "review", "work_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "accepted"], {
        dbPath,
        write: reviewOutput.write,
      }),
    ).toBe(0);
    expect(
      await runCli(
        [
          "ingest",
          "record",
          "--id",
          "ingest_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
          "--kind",
          "trace",
          "--source-provider",
          "openmao",
          "--source-id",
          "reference-worker",
          "--actor-id",
          "worker_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "--work",
          "work_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "--payload",
          '{"observed":true}',
          "--idempotency-key",
          "worker:reference:trace",
        ],
        { dbPath, write: ingestOutput.write },
      ),
    ).toBe(0);
    expect(await runCli(["ingest", "list"], { dbPath, write: ingestionListOutput.write })).toBe(0);

    expect(JSON.parse(workerOutput.lines[0] ?? "{}").id).toBe(
      "worker_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(JSON.parse(workOutput.lines[0] ?? "{}").status).toBe("queued");
    expect(JSON.parse(assignOutput.lines[0] ?? "{}").status).toBe("in_progress");
    expect(JSON.parse(envelopeOutput.lines[0] ?? "{}").worker_id).toBe(
      "worker_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(JSON.parse(envelopesOutput.lines[0] ?? "[]")).toHaveLength(1);
    expect(JSON.parse(outcomeOutput.lines[0] ?? "{}").status).toBe("completed");
    expect(JSON.parse(outcomesOutput.lines[0] ?? "[]")).toHaveLength(1);
    expect(JSON.parse(reviewOutput.lines[0] ?? "{}").status).toBe("done");
    expect(JSON.parse(ingestOutput.lines[0] ?? "{}").kind).toBe("trace");
    expect(JSON.parse(ingestionListOutput.lines[0] ?? "[]")).toHaveLength(1);
  });

  it("runs learning scans and proposal review through the CLI", async () => {
    const initOutput = capture();
    const firstWorkOutput = capture();
    const secondWorkOutput = capture();
    const scanOutput = capture();
    const proposalsOutput = capture();
    const approvedOutput = capture();
    const appliedOutput = capture();

    expect(await runCli(["init"], { dbPath, write: initOutput.write })).toBe(0);
    expect(
      await runCli(
        [
          "work",
          "create",
          "--id",
          "work_11111111111111111111111111111111",
          "--title",
          "Blocked research",
          "--objective",
          "Research is blocked.",
          "--owner",
          "worker:research",
        ],
        { dbPath, write: firstWorkOutput.write },
      ),
    ).toBe(0);
    expect(
      await runCli(
        [
          "work",
          "create",
          "--id",
          "work_22222222222222222222222222222222",
          "--title",
          "Blocked brief",
          "--objective",
          "Brief is blocked.",
          "--owner",
          "worker:research",
        ],
        { dbPath, write: secondWorkOutput.write },
      ),
    ).toBe(0);
    expect(
      await runCli(["work", "status", "work_11111111111111111111111111111111", "blocked"], {
        dbPath,
      }),
    ).toBe(0);
    expect(
      await runCli(["work", "status", "work_22222222222222222222222222222222", "blocked"], {
        dbPath,
      }),
    ).toBe(0);
    expect(await runCli(["learning", "scan"], { dbPath, write: scanOutput.write })).toBe(0);
    const scan = JSON.parse(scanOutput.lines[0] ?? "{}") as {
      proposals: Array<{ approval_id: string; proposal: { id: string; source_signal: string } }>;
    };
    const proposal = scan.proposals.find(
      (item) => item.proposal.source_signal === "repeated_blocker",
    );
    expect(proposal).toBeDefined();
    expect(await runCli(["learning", "proposals"], { dbPath, write: proposalsOutput.write })).toBe(
      0,
    );
    expect(JSON.parse(proposalsOutput.lines[0] ?? "[]").at(0).status).toBe("proposed");
    expect(
      await runCli(["approvals", "approve", proposal?.approval_id ?? ""], {
        dbPath,
        write: approvedOutput.write,
      }),
    ).toBe(0);
    expect(JSON.parse(approvedOutput.lines[0] ?? "{}").status).toBe("approved");
    expect(
      await runCli(["learning", "apply", proposal?.proposal.id ?? ""], {
        dbPath,
        write: appliedOutput.write,
      }),
    ).toBe(0);
    // `workflow` has no real applier: the record is acknowledged, never claimed `applied`
    // (truth-in-status, #105).
    expect(JSON.parse(appliedOutput.lines[0] ?? "{}").status).toBe("acknowledged");
  });

  it("runs the reference external-worker demo through the CLI", async () => {
    const workerDemoOutput = capture();
    const approvalsOutput = capture();
    const workerApprovalOutput = capture();
    const worldOutput = capture();

    expect(await runCli(["worker", "demo"], { dbPath, write: workerDemoOutput.write })).toBe(0);
    expect(JSON.parse(workerDemoOutput.lines[0] ?? "{}").status).toBe("suspended_approval");
    expect(await runCli(["approvals", "list"], { dbPath, write: approvalsOutput.write })).toBe(0);
    expect(JSON.parse(approvalsOutput.lines[0] ?? "[]")[0].id).toBe(
      "approval_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );
    await expect(
      runCli(
        [
          "approvals",
          "approve",
          REFERENCE_CAPABILITY_APPROVAL_ID,
          "--workspace",
          "ws_22222222222222222222222222222222",
        ],
        { dbPath },
      ),
    ).rejects.toThrow("approval does not belong to workspace");
    expect(
      await runCli(["worker", "demo-approve"], {
        dbPath,
        write: workerApprovalOutput.write,
      }),
    ).toBe(0);
    expect(JSON.parse(workerApprovalOutput.lines[0] ?? "{}").work_status).toBe("done");
    expect(await runCli(["world"], { dbPath, write: worldOutput.write })).toBe(0);
    expect(JSON.parse(worldOutput.lines[0] ?? "{}").external_workers).toEqual([
      "worker_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ]);
  });

  it("serves demo, approvals, world, and console over HTTP", async () => {
    const principal = seedPrincipalAtPath(dbPath, WORKSPACE_ID, "Test Operator");
    const operatorHeaders = principalHeaders(principal.token);
    const server = createServer({ dbPath });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    try {
      const rejected = await fetch(`${baseUrl}/runs/demo`, { method: "POST" });
      // A forged actor header is a spoof attempt: 400 even alongside a valid
      // credential, and 400 without one — never ignored, never a hint.
      const forgedActorWithToken = await fetch(`${baseUrl}/runs/demo`, {
        method: "POST",
        headers: { ...operatorHeaders, "x-openmao-actor": "mallory" },
      });
      const forgedActorOnly = await fetch(`${baseUrl}/runs/demo`, {
        method: "POST",
        headers: { "x-openmao-actor": "mallory" },
      });
      // The retired shared operator token is not a fallback path: presenting
      // it is refused outright.
      const legacyOperatorToken = await fetch(`${baseUrl}/runs/demo`, {
        method: "POST",
        headers: { "x-openmao-operator-token": "test-operator-token" },
      });
      const demo = (await fetch(`${baseUrl}/runs/demo`, {
        method: "POST",
        headers: operatorHeaders,
      }).then((response) => response.json())) as { status: string };
      const approvals = (await fetch(`${baseUrl}/approvals`, { headers: operatorHeaders }).then(
        (response) => response.json(),
      )) as Array<{ id: string }>;
      const workspaces = (await fetch(`${baseUrl}/workspaces`, { headers: operatorHeaders }).then(
        (response) => response.json(),
      )) as Array<{ id: string }>;
      const org = (await fetch(`${baseUrl}/org`, { headers: operatorHeaders }).then((response) =>
        response.json(),
      )) as { agents: unknown[]; organizations: unknown[]; roles: unknown[] };
      const capabilities = (await fetch(`${baseUrl}/capabilities`, {
        headers: operatorHeaders,
      }).then((response) => response.json())) as unknown[];
      const runs = (await fetch(`${baseUrl}/runs`, { headers: operatorHeaders }).then((response) =>
        response.json(),
      )) as unknown[];
      const run = (await fetch(`${baseUrl}/runs/${RUN_ID}`, { headers: operatorHeaders }).then(
        (response) => response.json(),
      )) as { id: string };
      const wrongWorkspaceRun = await fetch(`${baseUrl}/runs/${RUN_ID}`, {
        headers: {
          ...operatorHeaders,
          "x-openmao-workspace": "ws_22222222222222222222222222222222",
        },
      });
      const wrongWorkspaceRunBody = (await wrongWorkspaceRun.json()) as { error: string };
      const wrongWorkspaceResume = await fetch(`${baseUrl}/runs/${RUN_ID}/resume`, {
        method: "POST",
        headers: {
          ...operatorHeaders,
          "x-openmao-workspace": "ws_22222222222222222222222222222222",
        },
      });
      const work = (await fetch(`${baseUrl}/work`, { headers: operatorHeaders }).then((response) =>
        response.json(),
      )) as unknown[];
      const individualMemory = (await fetch(
        `${baseUrl}/memory/individual/${COORDINATOR_AGENT_ID}`,
        {
          headers: operatorHeaders,
        },
      ).then((response) => response.json())) as unknown[];
      const promotions = (await fetch(`${baseUrl}/memory/promotions`, {
        headers: operatorHeaders,
      }).then((response) => response.json())) as unknown[];
      const wrongWorkspaceEvents = await fetch(
        `${baseUrl}/events?run_id=${RUN_ID}&workspace_id=${WORKSPACE_ID}`,
        {
          headers: {
            ...operatorHeaders,
            "x-openmao-workspace": "ws_22222222222222222222222222222222",
          },
        },
      );
      const wrongWorkspacePathEvents = await fetch(`${baseUrl}/workspaces/${WORKSPACE_ID}/events`, {
        headers: {
          ...operatorHeaders,
          "x-openmao-workspace": "ws_22222222222222222222222222222222",
        },
      });
      const completed = (await fetch(`${baseUrl}/approvals/${PROMOTION_APPROVAL_ID}/approve`, {
        method: "POST",
        headers: operatorHeaders,
      }).then((response) => response.json())) as { status: string };
      const collectiveMemory = (await fetch(`${baseUrl}/memory/collective`, {
        headers: operatorHeaders,
      }).then((response) => response.json())) as unknown[];
      const world = (await fetch(`${baseUrl}/world`, { headers: operatorHeaders }).then(
        (response) => response.json(),
      )) as { latest_run_status: string };
      const runEvents = (await fetch(`${baseUrl}/runs/${RUN_ID}/events`, {
        headers: operatorHeaders,
      }).then((response) => response.json())) as unknown[];
      const runTraces = (await fetch(`${baseUrl}/runs/${RUN_ID}/traces`, {
        headers: operatorHeaders,
      }).then((response) => response.json())) as unknown[];
      const wrongWorkspaceTraces = await fetch(`${baseUrl}/runs/${RUN_ID}/traces`, {
        headers: {
          ...operatorHeaders,
          "x-openmao-workspace": "ws_22222222222222222222222222222222",
        },
      });
      const workspaceEvents = (await fetch(`${baseUrl}/workspaces/${WORKSPACE_ID}/events`, {
        headers: operatorHeaders,
      }).then((response) => response.json())) as unknown[];
      const consoleHtml = await fetch(`${baseUrl}/console`).then((response) => response.text());

      expect(rejected.status).toBe(403);
      expect(forgedActorWithToken.status).toBe(400);
      expect(await forgedActorWithToken.json()).toMatchObject({ error: "actor_header_rejected" });
      expect(forgedActorOnly.status).toBe(400);
      expect(await forgedActorOnly.json()).toMatchObject({ error: "actor_header_rejected" });
      expect(legacyOperatorToken.status).toBe(400);
      expect(await legacyOperatorToken.json()).toMatchObject({ error: "operator_token_removed" });
      expect(demo.status).toBe("suspended_approval");
      expect(approvals.at(0)?.id).toBe(PROMOTION_APPROVAL_ID);
      expect(workspaces.at(0)?.id).toBe(WORKSPACE_ID);
      expect(org.organizations).toHaveLength(1);
      expect(org.roles).toHaveLength(2);
      expect(org.agents).toHaveLength(2);
      expect(capabilities).toHaveLength(1);
      expect(runs).toHaveLength(1);
      expect(run.id).toBe(RUN_ID);
      // The credential forces the workspace; a conflicting explicit selection
      // fails closed with 400 before routing — there is no wrong-workspace 404.
      expect(wrongWorkspaceRun.status).toBe(400);
      expect(wrongWorkspaceRunBody).toEqual({ error: "workspace_mismatch" });
      expect(wrongWorkspaceResume.status).toBe(400);
      expect(work).toHaveLength(1);
      expect(individualMemory.length).toBeGreaterThan(0);
      expect(promotions).toHaveLength(1);
      expect(wrongWorkspaceEvents.status).toBe(400);
      expect(wrongWorkspacePathEvents.status).toBe(400);
      expect(completed.status).toBe("completed");
      expect(collectiveMemory).toHaveLength(1);
      expect(world.latest_run_status).toBe("completed");
      expect(runEvents.length).toBeGreaterThan(0);
      expect(runTraces.length).toBeGreaterThan(0);
      expect(wrongWorkspaceTraces.status).toBe(400);
      expect(workspaceEvents.length).toBeGreaterThan(runEvents.length);
      expect(consoleHtml).toContain("OpenMAO Console");
      expect(consoleHtml).toContain('data-view="traces"');
      expect(consoleHtml).toContain("/approvals/");
      expect(consoleHtml).not.toContain(principal.token);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("closes the self-assertion channel on POST /ingestion", async () => {
    const principal = seedPrincipalAtPath(dbPath, WORKSPACE_ID, "Test Operator");
    const operatorHeaders = principalHeaders(principal.token);
    const server = createServer({ dbPath });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const jsonHeaders = { ...operatorHeaders, "content-type": "application/json" };
    try {
      // An inbound foreign event can never claim OpenMAO operator authority.
      const operatorClaim = await fetch(`${baseUrl}/ingestion`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          kind: "event",
          source: { provider: "foreign", external_id: "foreign-system" },
          actor: { actor_type: "operator", actor_id: "self-proclaimed-operator" },
          idempotency_key: "foreign:operator-claim",
        }),
      });
      // Any other foreign actor type is accepted — but the EVENT's actor is
      // the authenticated principal, and the body-named actor is provenance
      // riding payload.actor_ref.
      const accepted = await fetch(`${baseUrl}/ingestion`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          kind: "event",
          source: { provider: "foreign", external_id: "foreign-system" },
          actor: { actor_type: "system", actor_id: "foreign-monitor" },
          idempotency_key: "foreign:monitor-observation",
        }),
      });
      const events = (await fetch(`${baseUrl}/events`, { headers: operatorHeaders }).then(
        (response) => response.json(),
      )) as Array<{
        kind: string;
        actor: string;
        payload: { actor_ref: { actor_type: string; actor_id: string } | null };
      }>;
      const ingestionEvent = events.find((event) => event.kind === "ingestion.recorded");

      expect(operatorClaim.status).toBe(400);
      expect(await operatorClaim.json()).toMatchObject({ error: "operator_actor_forbidden" });
      expect(accepted.status).toBe(201);
      expect(ingestionEvent?.actor).toBe(principal.principal_id);
      expect(ingestionEvent?.payload.actor_ref).toMatchObject({
        actor_type: "system",
        actor_id: "foreign-monitor",
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("records the authenticated principal, never a supplied name, on CLI writes", async () => {
    // The retired --by flag is not ignored: presenting it is a hard error
    // naming the replacement, so a scripted spoof fails loudly.
    await expect(
      runCli(["memory", "attest", "mementry_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "--by", "mallory"], {
        dbPath,
      }),
    ).rejects.toThrow(/--by is no longer accepted/);

    expect(
      await runCli(
        [
          "work",
          "create",
          "--title",
          "Authored",
          "--objective",
          "Authored objective.",
          "--owner",
          "ops",
        ],
        { dbPath },
      ),
    ).toBe(0);
    const eventsOutput = capture();
    expect(await runCli(["events"], { dbPath, write: eventsOutput.write })).toBe(0);
    const events = JSON.parse(eventsOutput.lines[0] ?? "[]") as Array<{
      kind: string;
      actor: string;
    }>;
    const created = events.find((event) => event.kind === "work.created");
    // The recorded actor is the authenticated principal's stored id — the
    // legacy self-asserted CLI identity is gone from the record.
    expect(created?.actor).toMatch(/^principal_[0-9a-f]{32}$/);
    expect(new Set(events.map((event) => event.actor)).has("cli_operator")).toBe(false);
  });

  it("refuses workers mint-token without an authenticated operator profile", async () => {
    await expect(
      runCli(["workers", "mint-token", "worker_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"], { dbPath }),
    ).rejects.toThrow("no authenticated operator profile");
  });

  it("enforces separation of duties between two authenticated principals over HTTP", async () => {
    // The retired version of this test spoofed `x-openmao-actor` to pose as
    // the proposer. Self-asserted identity is gone, so the demonstrable
    // separation of duties is now between two real principals: the requester
    // approving their own request is a 409, a second principal's token is a 200.
    const requester = seedPrincipalAtPath(dbPath, WORKSPACE_ID, "Requesting Operator");
    const approver = seedPrincipalAtPath(dbPath, WORKSPACE_ID, "Approving Operator");
    const seeded = (() => {
      const database = new Database(dbPath);
      database.initialize();
      try {
        return new OrgChangeService(database).propose({
          id: "orgchange_50d50d50d50d50d50d50d50d50d50d50",
          workspace_id: WORKSPACE_ID,
          proposed_by: requester.principal_id,
          change_type: "workflow",
          rationale: "Separate the requester from the approver.",
        });
      } finally {
        database.close();
      }
    })();
    const server = createServer({ dbPath });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    try {
      const selfApproval = await fetch(`${baseUrl}/approvals/${seeded.approval_id}/approve`, {
        method: "POST",
        headers: principalHeaders(requester.token),
      });
      const selfApprovalBody = (await selfApproval.json()) as { error: string; message?: string };
      const approved = await fetch(`${baseUrl}/approvals/${seeded.approval_id}/approve`, {
        method: "POST",
        headers: principalHeaders(approver.token),
      });
      const approvedBody = (await approved.json()) as { status: string };

      expect(selfApproval.status).toBe(409);
      expect(selfApproval.status).not.toBe(500);
      expect(selfApprovalBody.error).toBe("self_approval_forbidden");
      expect(approved.status).toBe(200);
      expect(approvedBody.status).toBe("approved");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("serves work substrate operations over HTTP", async () => {
    const principal = seedPrincipalAtPath(dbPath, WORKSPACE_ID, "Test Operator");
    const operatorHeaders = principalHeaders(principal.token);
    const server = createServer({ dbPath });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const jsonHeaders = { ...operatorHeaders, "content-type": "application/json" };
    try {
      await fetch(`${baseUrl}/runs/demo`, { method: "POST", headers: operatorHeaders });
      const worker = (await fetch(`${baseUrl}/workers`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          id: "worker_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          name: "Reference Worker",
          runtime: "openmao.example.worker",
          allowed_capabilities: ["mock.research_lookup"],
        }),
      }).then((response) => response.json())) as { id: string };
      const work = (await fetch(`${baseUrl}/work`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          id: "work_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          title: "Prepare governed update",
          objective: "Prepare a governed update for review.",
          owner: "role_33333333333333333333333333333333",
          reviewer: "human",
          success_criteria: ["bounded envelope exists"],
        }),
      }).then((response) => response.json())) as { id: string; status: string };
      const assigned = (await fetch(`${baseUrl}/work/${work.id}/assign`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ owner: worker.id }),
      }).then((response) => response.json())) as { owner: string; status: string };
      const envelope = (await fetch(`${baseUrl}/work/${work.id}/envelopes`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          id: "envelope_cccccccccccccccccccccccccccccccc",
          run_id: RUN_ID,
          worker_id: worker.id,
          allowed_capabilities: ["mock.research_lookup"],
          input: { topic: "governed update" },
        }),
      }).then((response) => response.json())) as {
        task_envelope_id: string | null;
        worker_id: string;
        work_item_id: string;
      };
      const outcome = (await fetch(`${baseUrl}/work/${work.id}/outcomes`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          id: "outcome_dddddddddddddddddddddddddddddddd",
          envelope_id: "envelope_cccccccccccccccccccccccccccccccc",
          worker_id: worker.id,
          status: "completed",
          summary: "Prepared the governed update.",
          output: { ready: true },
        }),
      }).then((response) => response.json())) as { status: string; work_item_id: string };
      const outcomes = (await fetch(`${baseUrl}/work/${work.id}/outcomes`, {
        headers: operatorHeaders,
      }).then((response) => response.json())) as unknown[];
      const reviewed = (await fetch(`${baseUrl}/work/${work.id}/review`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ decision: "accepted", notes: "Looks good." }),
      }).then((response) => response.json())) as { status: string };
      const ingestion = (await fetch(`${baseUrl}/ingestion`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          id: "ingest_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
          kind: "trace",
          source: { provider: "openmao", external_id: "reference-worker" },
          actor: { actor_type: "worker", actor_id: worker.id },
          target_work_item_id: work.id,
          payload: { observed: true },
          idempotency_key: "worker:reference:trace",
        }),
      }).then((response) => response.json())) as { id: string; kind: string };
      const ingestionList = (await fetch(`${baseUrl}/ingestion`, {
        headers: operatorHeaders,
      }).then((response) => response.json())) as unknown[];
      const invalidIngestion = await fetch(`${baseUrl}/ingestion`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          kind: "trace",
          source: { provider: "openmao", external_id: "reference-worker" },
          actor: { actor_type: "worker", actor_id: worker.id },
        }),
      });
      const envelopes = (await fetch(`${baseUrl}/work/${work.id}/envelopes`, {
        headers: operatorHeaders,
      }).then((response) => response.json())) as unknown[];
      const database = new Database(dbPath);
      database.initialize();
      try {
        new WorkspaceStore(database).save(
          WorkspaceSchema.parse({
            id: "ws_22222222222222222222222222222222",
            name: "Second Workspace",
            created_at: "2026-05-27T15:20:00Z",
            default_org_id: null,
          }),
        );
      } finally {
        database.close();
      }
      const wrongWorkspaceEnvelopes = await fetch(`${baseUrl}/work/${work.id}/envelopes`, {
        headers: {
          ...operatorHeaders,
          "x-openmao-workspace": "ws_22222222222222222222222222222222",
        },
      });
      const events = (await fetch(`${baseUrl}/events`, { headers: operatorHeaders }).then(
        (response) => response.json(),
      )) as Array<{ kind: string }>;

      expect(worker.id).toBe("worker_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
      expect(work.status).toBe("queued");
      expect(assigned.owner).toBe(worker.id);
      expect(assigned.status).toBe("in_progress");
      expect(envelope.worker_id).toBe(worker.id);
      expect(envelope.work_item_id).toBe(work.id);
      expect(envelope.task_envelope_id).toBe("task_cccccccccccccccccccccccccccccccc");
      expect(outcome.status).toBe("completed");
      expect(outcome.work_item_id).toBe(work.id);
      expect(outcomes).toHaveLength(1);
      expect(reviewed.status).toBe("done");
      expect(ingestion.kind).toBe("trace");
      expect(ingestionList).toHaveLength(1);
      expect(invalidIngestion.status).toBe(400);
      expect(await invalidIngestion.json()).toEqual({ error: "missing_idempotency_key" });
      expect(envelopes).toHaveLength(1);
      expect(wrongWorkspaceEnvelopes.status).toBe(400);
      expect(events.map((event) => event.kind)).toEqual(
        expect.arrayContaining([
          "worker.registered",
          "work.created",
          "work.assigned",
          "work.outcome_submitted",
          "work.reviewed",
          "ingestion.recorded",
        ]),
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("serves learning scans and proposal review over HTTP", async () => {
    const principal = seedPrincipalAtPath(dbPath, WORKSPACE_ID, "Test Operator");
    const operatorHeaders = principalHeaders(principal.token);
    const server = createServer({ dbPath });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const jsonHeaders = { ...operatorHeaders, "content-type": "application/json" };
    try {
      await fetch(`${baseUrl}/workspaces`, { headers: operatorHeaders });
      for (const [id, title] of [
        ["work_11111111111111111111111111111111", "Blocked research"],
        ["work_22222222222222222222222222222222", "Blocked brief"],
      ]) {
        await fetch(`${baseUrl}/work`, {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify({
            id,
            title,
            objective: `${title} objective.`,
            owner: "worker:research",
          }),
        });
        await fetch(`${baseUrl}/work/${id}/status`, {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify({ status: "blocked", reason: "Missing input." }),
        });
      }
      const scan = (await fetch(`${baseUrl}/learning/scan`, {
        method: "POST",
        headers: operatorHeaders,
      }).then((response) => response.json())) as {
        proposals: Array<{ approval_id: string; proposal: { id: string; status: string } }>;
      };
      const listed = (await fetch(`${baseUrl}/learning/proposals`, {
        headers: operatorHeaders,
      }).then((response) => response.json())) as Array<{
        id: string;
        review_approval_id: string;
        status: string;
      }>;
      const proposal = listed[0];
      const approved = (await fetch(
        `${baseUrl}/approvals/${proposal?.review_approval_id}/approve`,
        {
          method: "POST",
          headers: operatorHeaders,
        },
      ).then((response) => response.json())) as { status: string };
      const applied = (await fetch(`${baseUrl}/learning/proposals/${proposal?.id}/apply`, {
        method: "POST",
        headers: operatorHeaders,
      }).then((response) => response.json())) as { status: string };
      const world = (await fetch(`${baseUrl}/world`, { headers: operatorHeaders }).then(
        (response) => response.json(),
      )) as { learning_signals: string[] };

      expect(scan.proposals.at(0)?.proposal.status).toBe("proposed");
      expect(proposal?.status).toBe("proposed");
      expect(approved.status).toBe("approved");
      // `workflow` has no real applier: acknowledged, never `applied` (#105).
      expect(applied.status).toBe("acknowledged");
      expect(world.learning_signals).toContain("repeated_blocker");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("serves the reference worker gateway flow over HTTP", async () => {
    const principal = seedPrincipalAtPath(dbPath, WORKSPACE_ID, "Test Operator");
    const operatorHeaders = principalHeaders(principal.token);
    const server = createServer({ dbPath });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    try {
      const started = (await fetch(`${baseUrl}/workers/reference-demo`, {
        method: "POST",
        headers: operatorHeaders,
      }).then((response) => response.json())) as {
        capability_approval_id: string;
        status: string;
      };
      const approvals = (await fetch(`${baseUrl}/approvals`, { headers: operatorHeaders }).then(
        (response) => response.json(),
      )) as Array<{ id: string }>;
      const approved = (await fetch(
        `${baseUrl}/approvals/${REFERENCE_CAPABILITY_APPROVAL_ID}/approve`,
        {
          method: "POST",
          headers: operatorHeaders,
        },
      ).then((response) => response.json())) as {
        capability_result_id: string;
        status: string;
        work_status: string;
      };
      const capabilityCalls = (await fetch(`${baseUrl}/capability-calls`, {
        headers: operatorHeaders,
      }).then((response) => response.json())) as Array<{ id: string; requested_by: string }>;
      const capabilityResults = (await fetch(`${baseUrl}/capability-results`, {
        headers: operatorHeaders,
      }).then((response) => response.json())) as Array<{ call_id: string; status: string }>;
      const world = (await fetch(`${baseUrl}/world?run_id=${REFERENCE_RUN_ID}`, {
        headers: operatorHeaders,
      }).then((response) => response.json())) as {
        external_workers: string[];
        latest_run_status: string;
      };
      const consoleHtml = await fetch(`${baseUrl}/console`).then((response) => response.text());

      expect(started.status).toBe("suspended_approval");
      expect(started.capability_approval_id).toBe(REFERENCE_CAPABILITY_APPROVAL_ID);
      expect(approvals.at(0)?.id).toBe(REFERENCE_CAPABILITY_APPROVAL_ID);
      expect(approved.status).toBe("completed");
      expect(approved.work_status).toBe("done");
      expect(approved.capability_result_id).toMatch(/^capresult_/);
      expect(capabilityCalls.at(0)?.requested_by).toBe(REFERENCE_WORKER_ID);
      expect(capabilityResults.at(0)?.status).toBe("ok");
      expect(world.latest_run_status).toBe("completed");
      expect(world.external_workers).toContain(REFERENCE_WORKER_ID);
      expect(consoleHtml).toContain("/workers/reference-demo");
      expect(consoleHtml).toContain('data-view="capabilityCalls"');
      // Capability results are folded into the Actions-requested (capabilityCalls) view
      // rather than a top-level peer, per the Tier-1 drill-down IA.
      expect(consoleHtml).toContain("/capability-results");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("materializes rejected reference-worker capability results over HTTP", async () => {
    const principal = seedPrincipalAtPath(dbPath, WORKSPACE_ID, "Test Operator");
    const operatorHeaders = principalHeaders(principal.token);
    const server = createServer({ dbPath });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    try {
      const started = (await fetch(`${baseUrl}/workers/reference-demo`, {
        method: "POST",
        headers: operatorHeaders,
      }).then((response) => response.json())) as {
        capability_approval_id: string;
        status: string;
      };
      const rejected = (await fetch(
        `${baseUrl}/approvals/${REFERENCE_CAPABILITY_APPROVAL_ID}/reject`,
        {
          method: "POST",
          headers: operatorHeaders,
        },
      ).then((response) => response.json())) as {
        result?: { status: string };
      };
      const capabilityResults = (await fetch(`${baseUrl}/capability-results`, {
        headers: operatorHeaders,
      }).then((response) => response.json())) as Array<{ call_id: string; status: string }>;

      expect(started.status).toBe("suspended_approval");
      expect(started.capability_approval_id).toBe(REFERENCE_CAPABILITY_APPROVAL_ID);
      expect(rejected.result?.status).toBe("blocked");
      expect(capabilityResults.at(0)?.status).toBe("blocked");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("binds the acting workspace to the credential even once multiple workspaces exist", async () => {
    // The retired shared token needed an explicit workspace header to
    // disambiguate writes (workspace_required). A principal credential BINDS
    // the workspace, so the ambiguity cannot occur: unqualified requests act
    // in the credential's workspace, and a conflicting explicit selection is
    // a 400, never silent cross-workspace action.
    const principal = seedPrincipalAtPath(dbPath, WORKSPACE_ID, "Test Operator");
    const operatorHeaders = principalHeaders(principal.token);
    const server = createServer({ dbPath });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    try {
      const demo = (await fetch(`${baseUrl}/runs/demo`, {
        method: "POST",
        headers: operatorHeaders,
      }).then((response) => response.json())) as { status: string };
      const database = new Database(dbPath);
      database.initialize();
      try {
        new WorkspaceStore(database).save(
          WorkspaceSchema.parse({
            id: "ws_22222222222222222222222222222222",
            name: "Second Workspace",
            created_at: "2026-05-27T15:20:00Z",
            default_org_id: null,
          }),
        );
      } finally {
        database.close();
      }

      const unqualifiedApproval = (await fetch(`${baseUrl}/runs/demo/approve`, {
        method: "POST",
        headers: operatorHeaders,
      }).then((response) => response.json())) as { status: string };
      const unqualifiedWorld = await fetch(`${baseUrl}/world`, { headers: operatorHeaders });
      const agreeingApproval = await fetch(`${baseUrl}/runs/demo/approve`, {
        method: "POST",
        headers: { ...operatorHeaders, "x-openmao-workspace": WORKSPACE_ID },
      });
      const conflictingWorld = await fetch(`${baseUrl}/world`, {
        headers: {
          ...operatorHeaders,
          "x-openmao-workspace": "ws_22222222222222222222222222222222",
        },
      });

      expect(demo.status).toBe("suspended_approval");
      expect(unqualifiedApproval.status).toBe("completed");
      expect(unqualifiedWorld.status).toBe(200);
      expect(agreeingApproval.status).toBe(200);
      expect(conflictingWorld.status).toBe(400);
      expect(await conflictingWorld.json()).toEqual({ error: "workspace_mismatch" });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
