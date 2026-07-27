import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  Database,
  EventStore,
  MemoryEntryStore,
  PromotionCandidateStore,
} from "../src/persistence/index.js";
import {
  DENY_CAPABILITY_NAME,
  DENY_RUN_ID,
  PROMOTION_CANDIDATE_ID,
  RUN_ID,
  SpineService,
  WORKSPACE_ID,
} from "../src/spine/index.js";
import { createSigningOperator } from "./helpers/principals.js";

const COLLECTIVE_MEMORY_ID = "mem_cccccccccccccccccccccccccccccccc";

describe("demo deny leg", () => {
  let tmpRoot: string;
  let database: Database;
  let service: SpineService;

  /** A signing operator in the demo workspace, for decision calls in these tests. */
  function demoSigner() {
    // The signer may be needed before any demo command has run, so make sure
    // the workspace row the principals tables FK to exists (idempotent).
    service.initDemoWorkspace();
    return createSigningOperator(database, WORKSPACE_ID, "Demo Operator").signer;
  }

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "openmao-ts-deny-"));
    database = new Database(join(tmpRoot, "openmao.sqlite3"));
    database.initialize();
    service = new SpineService(database, {
      artifact_dir: join(tmpRoot, "artifacts"),
      collective_memory_dir: join(tmpRoot, "collective_memory"),
    });
  });

  afterEach(() => {
    database.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("rejects the promotion approval, fails the run, and writes no collective memory", async () => {
    const result = await service.denyDemo({ signer: demoSigner() });

    expect(result.promotion_leg.status).toBe("failed");
    expect(result.promotion_leg.active_node).toBe("approval_rejected");
    expect(result.promotion_leg.approval_status).toBe("rejected");
    expect(new MemoryEntryStore(database).get(COLLECTIVE_MEMORY_ID)).toBeFalsy();
    expect(new PromotionCandidateStore(database).get(PROMOTION_CANDIDATE_ID)?.status).toBe(
      "rejected",
    );

    const kinds = new EventStore(database).listForRun(WORKSPACE_ID, RUN_ID).map((e) => e.kind);
    expect(kinds).toContain("approval.rejected");
    expect(kinds).toContain("run.failed");
    expect(kinds).not.toContain("memory.collective_written");
  });

  it("records the deny-by-default block with the policy decision on the chain", async () => {
    const result = await service.denyDemo({ signer: demoSigner() });

    expect(result.blocked_leg.capability_name).toBe(DENY_CAPABILITY_NAME);
    expect(result.blocked_leg.decision_outcome).toBe("block");
    expect(result.blocked_leg.reason).toContain("lacks capability grant");
    expect(result.blocked_leg.result_status).toBe("blocked");
    expect(result.blocked_leg.status).toBe("failed");

    const kinds = new EventStore(database).listForRun(WORKSPACE_ID, DENY_RUN_ID).map((e) => e.kind);
    expect(kinds).toContain("capability.requested");
    expect(kinds).toContain("policy.decision");
    expect(kinds).toContain("capability.failed");
    expect(kinds).toContain("run.failed");
    expect(kinds).not.toContain("capability.completed");

    expect(new EventStore(database).verifyChain(WORKSPACE_ID)).toEqual({ ok: true });
  });

  it("summarizes the deny story as ordered events with reasons", async () => {
    const result = await service.denyDemo({ signer: demoSigner() });

    expect(result.events.map((event) => event.kind)).toEqual([
      "approval.rejected",
      "run.failed",
      "policy.decision",
      "capability.failed",
      "run.failed",
    ]);
    expect(result.events.some((event) => event.note?.includes("lacks capability grant"))).toBe(
      true,
    );
  });

  it("replays idempotently", async () => {
    const result = await service.denyDemo({ signer: demoSigner() });
    const replayed = await service.denyDemo({ signer: demoSigner() });

    expect(replayed).toEqual(result);
  });

  it("refuses after the approve leg and points at a fresh state dir", async () => {
    await service.startDemo();
    service.resumeDemo(null, { signer: demoSigner() });

    await expect(service.denyDemo({ signer: demoSigner() })).rejects.toThrow(/already completed/);
  });

  it("keeps the rejected approval durable: the approve leg cannot run after deny", async () => {
    await service.denyDemo({ signer: demoSigner() });

    expect(() => service.resumeDemo(null, { signer: demoSigner() })).toThrow(/failed/);
  });
});
