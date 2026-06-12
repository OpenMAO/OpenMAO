import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";
import {
  CapabilityCallSchema,
  CapabilityResultSchema,
  CapabilitySchema,
  EventPayloadSchema,
  type MemoryEntry,
  MemoryEntrySchema,
  PromotionCandidateSchema,
  RunSchema,
  WorkspaceSchema,
} from "../src/contracts/index.js";
import {
  deriveMemoryTrust,
  type MemoryListResult,
  MemoryRetrievalService,
  MemoryReviewError,
  PromotionService,
} from "../src/memory/index.js";
import {
  CapabilityCallStore,
  CapabilityResultStore,
  CapabilityStore,
  CorroborationStore,
  Database,
  EventStore,
  MemoryEntryStore,
  RunStore,
  WorkspaceStore,
} from "../src/persistence/index.js";
import { COORDINATOR_MEMORY_ID, RUN_ID, SpineService, WORKSPACE_ID } from "../src/spine/index.js";

const fixturePath = new URL("../../tests/fixtures/canonical_v0.json", import.meta.url);
const WS = "ws_11111111111111111111111111111111";
const OTHER_WS = "ws_22222222222222222222222222222222";
const SOURCE_EVENT_ID = "evt_11111111111111111111111111111111";
const CAPABILITY_RESULT_ID = "capresult_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const REVIEWER = "operator_bilal";

let tmpRoot: string;
let database: Database;

function loadFixture(): Record<string, unknown> {
  return JSON.parse(readFileSync(fixturePath, "utf8")) as Record<string, unknown>;
}

/**
 * Seeds the canonical workspace, run, fixture event, and the full capability
 * chain (capability -> call -> result) so every trust-bearing ref kind has a
 * real row it can resolve against.
 */
function seedProvenanceTargets(): void {
  const fixture = loadFixture();
  new WorkspaceStore(database).save(WorkspaceSchema.parse(fixture.workspace));
  const fixtureRun = RunSchema.parse(fixture.run);
  const queued = RunSchema.parse({
    ...fixtureRun,
    status: "queued",
    active_node: null,
    suspended_approval_id: null,
    updated_at: fixtureRun.created_at,
  });
  const runStore = new RunStore(database);
  runStore.create(queued);
  runStore.setStatus(queued.id, "running", {
    active_node: "run_started",
    updated_at: "2026-05-27T15:20:02Z",
  });

  const event = fixture.event as {
    id: string;
    workspace_id: string;
    run_id: string | null;
    kind: string;
    actor: string;
    payload: Record<string, unknown>;
    idempotency_key: string | null;
    timestamp: string;
  };
  new EventStore(database).append({
    workspace_id: event.workspace_id,
    run_id: event.run_id,
    kind: event.kind,
    actor: event.actor,
    payload: EventPayloadSchema.parse(event.payload),
    idempotency_key: event.idempotency_key,
    event_id: event.id,
    timestamp: event.timestamp,
  });

  new CapabilityStore(database).save(CapabilitySchema.parse(fixture.capability));
  new CapabilityCallStore(database).record(CapabilityCallSchema.parse(fixture.capability_call));
  new CapabilityResultStore(database).record(
    CapabilityResultSchema.parse({
      ...(fixture.capability_result as Record<string, unknown>),
      node_effect_id: null,
    }),
  );
}

function makeEntry(
  id: string,
  provenance: Partial<MemoryEntry["provenance"]>,
  over: Partial<Omit<MemoryEntry, "provenance">> = {},
): MemoryEntry {
  return MemoryEntrySchema.parse({
    id,
    workspace_id: WS,
    scope: "individual",
    owner_id: null,
    kind: "semantic",
    content: "warmup improves deliverability",
    provenance: {
      agent_id: null,
      role_id: null,
      task_id: null,
      run_id: null,
      source_event_id: null,
      note: null,
      capability_result_id: null,
      attested_by: null,
      ...provenance,
    },
    confidence: 0.6,
    status: "confirmed",
    created_at: "2026-05-27T15:21:00Z",
    ...over,
  });
}

function promotionService(): PromotionService {
  return new PromotionService(database, {
    collective_memory_dir: join(tmpRoot, "collective_memory"),
  });
}

function trustStores() {
  return {
    events: new EventStore(database),
    capabilityResults: new CapabilityResultStore(database),
  };
}

function eventsOfKind(kind: string) {
  return new EventStore(database).listForWorkspace(WS).filter((event) => event.kind === kind);
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "openmao-ts-provenance-"));
  database = new Database(join(tmpRoot, "openmao.sqlite3"));
  database.initialize();
  seedProvenanceTargets();
});

afterEach(() => {
  database.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("memory provenance invariant (#113)", () => {
  it("derives guidance_eligible from a capability result that resolves in-workspace", () => {
    const entry = promotionService().writeIndividual(
      makeEntry("mem_11111111111111111111111111111111", {
        capability_result_id: CAPABILITY_RESULT_ID,
      }),
    );

    expect(deriveMemoryTrust(entry, trustStores())).toEqual({
      trust: "guidance_eligible",
      basis: "capability_result",
      unresolved: [],
    });
    const written = eventsOfKind("memory.individual_written").find(
      (event) => event.payload.data.trust !== undefined && event.payload.refs[0] === entry.id,
    );
    expect(written?.payload.data.trust).toBe("guidance_eligible");
    expect(written?.payload.data.trust_basis).toBe("capability_result");
    expect(eventsOfKind("memory.provenance_unresolved")).toEqual([]);
  });

  it("derives guidance_eligible from a source event that resolves in-workspace", () => {
    const entry = promotionService().writeIndividual(
      makeEntry("mem_22222222222222222222222222222222", { source_event_id: SOURCE_EVENT_ID }),
    );

    expect(deriveMemoryTrust(entry, trustStores())).toEqual({
      trust: "guidance_eligible",
      basis: "source_event",
      unresolved: [],
    });
  });

  it("derives guidance_eligible from an operator attestation once it is on the record", () => {
    const service = promotionService();
    const entry = service.writeIndividual(
      makeEntry("mem_33333333333333333333333333333333", { attested_by: REVIEWER }),
    );

    // The bare claim is not proof: before the attestation event it stays
    // untrusted and is recorded as an unresolved marker.
    expect(deriveMemoryTrust(entry, trustStores())).toEqual({
      trust: "untrusted",
      basis: null,
      unresolved: [`operator_attestation:${REVIEWER}`],
    });

    service.attestMemory(entry.id, { attested_by: REVIEWER });

    expect(deriveMemoryTrust(entry, trustStores())).toEqual({
      trust: "guidance_eligible",
      basis: "operator_attestation",
      unresolved: [],
    });
  });

  it("requires a bare attested_by with no attestation event to stay untrusted", () => {
    const entry = promotionService().writeIndividual(
      makeEntry("mem_a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0", { attested_by: REVIEWER }),
    );

    // A self-asserted attestor with no resolvable attestation event is a
    // supplied-but-unresolved marker, so it is untrusted and the integrity
    // event fires.
    expect(deriveMemoryTrust(entry, trustStores())).toEqual({
      trust: "untrusted",
      basis: null,
      unresolved: [`operator_attestation:${REVIEWER}`],
    });
    const integrity = eventsOfKind("memory.provenance_unresolved");
    expect(integrity).toHaveLength(1);
    expect(integrity[0]?.payload.data.unresolved).toEqual([`operator_attestation:${REVIEWER}`]);
  });

  it("makes a bare attested_by guidance_eligible after attestMemory puts proof on the record", () => {
    const service = promotionService();
    const entry = service.writeIndividual(
      makeEntry("mem_a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1", { attested_by: REVIEWER }),
    );
    expect(deriveMemoryTrust(entry, trustStores()).trust).toBe("untrusted");

    const attestation = service.attestMemory(entry.id, { attested_by: REVIEWER });
    expect(attestation.kind).toBe("memory.operator_attested");
    expect(attestation.actor).toBe(REVIEWER);
    expect(attestation.idempotency_key).toBe(`${entry.id}:operator_attested`);
    expect(attestation.payload.refs).toEqual([entry.id]);
    expect(deriveMemoryTrust(entry, trustStores()).trust).toBe("guidance_eligible");
  });

  it("rejects an operator attestation by a blank or agent-shaped attestor", () => {
    const service = promotionService();
    const entry = service.writeIndividual(
      makeEntry("mem_a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2", { attested_by: REVIEWER }),
    );

    expect(() => service.attestMemory(entry.id, { attested_by: "   " })).toThrow(/non-blank/);
    expect(() =>
      service.attestMemory(entry.id, { attested_by: "agent_55555555555555555555555555555555" }),
    ).toThrow(/agent id/);
    // Neither rejected call left an attestation behind: still untrusted.
    expect(deriveMemoryTrust(entry, trustStores()).trust).toBe("untrusted");
  });

  it("is idempotent: re-attesting the same entry is a no-op", () => {
    const service = promotionService();
    const entry = service.writeIndividual(
      makeEntry("mem_a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3", { attested_by: REVIEWER }),
    );

    const first = service.attestMemory(entry.id, { attested_by: REVIEWER });
    const second = service.attestMemory(entry.id, { attested_by: REVIEWER });
    expect(second.id).toBe(first.id);
    expect(eventsOfKind("memory.operator_attested")).toHaveLength(1);
    expect(deriveMemoryTrust(entry, trustStores()).trust).toBe("guidance_eligible");
  });

  it("never accepts an agent id as an operator attestation", () => {
    const forgedAttestor = "agent_55555555555555555555555555555555";
    const entry = promotionService().writeIndividual(
      makeEntry("mem_44444444444444444444444444444444", { attested_by: forgedAttestor }),
    );

    expect(deriveMemoryTrust(entry, trustStores())).toEqual({
      trust: "untrusted",
      basis: null,
      unresolved: [`operator_attestation:${forgedAttestor}`],
    });
    expect(eventsOfKind("memory.provenance_unresolved")).toHaveLength(1);
  });

  it("records a forged ref as untrusted and emits the integrity event", () => {
    const dangling = "evt_ffffffffffffffffffffffffffffffff";
    const entry = promotionService().writeIndividual(
      makeEntry("mem_55555555555555555555555555555555", { source_event_id: dangling }),
    );

    expect(deriveMemoryTrust(entry, trustStores())).toEqual({
      trust: "untrusted",
      basis: null,
      unresolved: [`source_event:${dangling}`],
    });
    const integrity = eventsOfKind("memory.provenance_unresolved");
    expect(integrity).toHaveLength(1);
    expect(integrity[0]?.idempotency_key).toBe(`${entry.id}:provenance_unresolved`);
    expect(integrity[0]?.payload.refs).toEqual([entry.id]);
    expect(integrity[0]?.payload.data.unresolved).toEqual([`source_event:${dangling}`]);
  });

  it("does not resolve refs across workspaces", () => {
    new WorkspaceStore(database).save(
      WorkspaceSchema.parse({
        id: OTHER_WS,
        name: "Other workspace",
        created_at: "2026-05-27T15:20:00Z",
        default_org_id: null,
      }),
    );
    // Points at a real event — but one recorded in another workspace.
    const entry = promotionService().writeIndividual(
      makeEntry(
        "mem_66666666666666666666666666666666",
        { source_event_id: SOURCE_EVENT_ID },
        { workspace_id: OTHER_WS },
      ),
    );

    const derivation = deriveMemoryTrust(entry, trustStores());
    expect(derivation.trust).toBe("untrusted");
    expect(derivation.unresolved).toEqual([`source_event:${SOURCE_EVENT_ID}`]);
  });

  it("records refless memory as untrusted without an integrity event (absence is not forgery)", () => {
    const entry = promotionService().writeIndividual(
      makeEntry("mem_77777777777777777777777777777777", {}),
    );

    expect(deriveMemoryTrust(entry, trustStores())).toEqual({
      trust: "untrusted",
      basis: null,
      unresolved: [],
    });
    const written = eventsOfKind("memory.individual_written").find(
      (event) => event.payload.refs[0] === entry.id,
    );
    expect(written?.payload.data.trust).toBe("untrusted");
    expect(eventsOfKind("memory.provenance_unresolved")).toEqual([]);
    // Recorded all the same: anything may be remembered, it just stays untrusted.
    expect(new MemoryEntryStore(database).get(entry.id)).not.toBeNull();
  });

  it("blocks promotion of memory that is not guidance-eligible", () => {
    const service = promotionService();
    const untrusted = service.writeIndividual(
      makeEntry("mem_88888888888888888888888888888888", {}),
    );

    expect(() =>
      service.propose(
        PromotionCandidateSchema.parse({
          id: "promo_11111111111111111111111111111111",
          workspace_id: WS,
          source_memory_entry: untrusted.id,
          proposed_by: "agent_55555555555555555555555555555555",
          proposed_content: "should never become guidance",
          rationale: "untrusted source",
          corroboration_count: 0,
          status: "pending",
          created_at: "2026-05-27T15:21:01Z",
        }),
        { requested_by: "agent_55555555555555555555555555555555" },
      ),
    ).toThrow(/not guidance-eligible/);
  });

  it("rejects corroboration by untrusted evidence so the count never includes it", () => {
    const service = promotionService();
    const source = service.writeIndividual(
      makeEntry("mem_99999999999999999999999999999999", { source_event_id: SOURCE_EVENT_ID }),
    );
    const candidate = PromotionCandidateSchema.parse({
      id: "promo_22222222222222222222222222222222",
      workspace_id: WS,
      source_memory_entry: source.id,
      proposed_by: "agent_55555555555555555555555555555555",
      proposed_content: "warmup improves deliverability",
      rationale: "observed across runs",
      corroboration_count: 0,
      status: "pending",
      created_at: "2026-05-27T15:21:01Z",
    });
    service.propose(candidate, { requested_by: "agent_55555555555555555555555555555555" });
    const untrustedEvidence = service.writeIndividual(
      makeEntry("mem_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", {}),
    );

    expect(() =>
      service.recordCorroboration(candidate.id, {
        source_memory_entry: untrustedEvidence.id,
        corroborated_by: "agent_77777777777777777777777777777777",
      }),
    ).toThrow(/never counts as corroboration/);
    expect(new CorroborationStore(database).countForCandidate(candidate.id)).toBe(0);
  });

  it("excludes untrusted memory from default recall (search and list)", () => {
    const service = promotionService();
    const eligible = service.writeIndividual(
      makeEntry("mem_e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1", { attested_by: REVIEWER }),
    );
    service.attestMemory(eligible.id, { attested_by: REVIEWER });
    const untrusted = service.writeIndividual(
      makeEntry("mem_e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2", {}),
    );
    const retrieval = new MemoryRetrievalService(database);

    const searched = retrieval.search(WS, "deliverability");
    expect(searched.map((result) => result.entry.id)).toEqual([eligible.id]);
    expect(searched[0]?.trust).toBe("guidance_eligible");

    const listed = retrieval.list(WS);
    expect(listed.map((result) => result.entry.id)).toContain(eligible.id);
    expect(listed.map((result) => result.entry.id)).not.toContain(untrusted.id);
  });

  it("review path returns labeled untrusted memory and puts the review on the record", () => {
    const service = promotionService();
    service.writeIndividual(makeEntry("mem_e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3", {}));
    const retrieval = new MemoryRetrievalService(database);

    const review = { include_untrusted: true as const, reviewed_by: REVIEWER };
    const results = retrieval.search(WS, "deliverability", {}, review);
    expect(results.map((result) => result.trust)).toEqual(["untrusted"]);

    retrieval.search(WS, "deliverability", {}, review);
    const audits = eventsOfKind("memory.untrusted_reviewed");
    // No idempotency key: each review is its own event on the record.
    expect(audits).toHaveLength(2);
    expect(audits[0]?.actor).toBe(REVIEWER);
    expect(audits[0]?.idempotency_key).toBeNull();
    expect(audits[0]?.payload.refs).toEqual(["mem_e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3"]);
    expect(audits[0]?.payload.data.reviewed_by).toBe(REVIEWER);
  });

  it("review requires a named reviewer and stays silent when nothing untrusted is returned", () => {
    const service = promotionService();
    const attested = service.writeIndividual(
      makeEntry("mem_e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4", { attested_by: REVIEWER }),
    );
    service.attestMemory(attested.id, { attested_by: REVIEWER });
    const retrieval = new MemoryRetrievalService(database);

    expect(() =>
      retrieval.search(WS, "deliverability", {}, { include_untrusted: true, reviewed_by: "  " }),
    ).toThrow(MemoryReviewError);
    expect(() => retrieval.list(WS, {}, { include_untrusted: true, reviewed_by: "" })).toThrow(
      MemoryReviewError,
    );

    // All workspace memory is guidance-eligible: the review reads nothing
    // untrusted, so nothing goes on the record.
    retrieval.list(WS, {}, { include_untrusted: true, reviewed_by: REVIEWER });
    expect(eventsOfKind("memory.untrusted_reviewed")).toEqual([]);
  });

  it("gates the CLI review path behind --include-untrusted --by", async () => {
    const dbPath = join(tmpRoot, "openmao.sqlite3");
    const attested = promotionService().writeIndividual(
      makeEntry("mem_e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5", { attested_by: REVIEWER }),
    );
    promotionService().writeIndividual(makeEntry("mem_e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6", {}));

    // Attest e5 over the CLI so it is guidance-eligible and visible by default.
    const attestLines: string[] = [];
    expect(
      await runCli(["memory", "attest", attested.id, "--by", REVIEWER, "--workspace", WS], {
        dbPath,
        write: (message) => attestLines.push(message),
      }),
    ).toBe(0);
    expect(JSON.parse(attestLines.join("\n")).kind).toBe("memory.operator_attested");

    const defaultLines: string[] = [];
    expect(
      await runCli(["memory", "list", "--workspace", WS], {
        dbPath,
        write: (message) => defaultLines.push(message),
      }),
    ).toBe(0);
    const defaultRows = JSON.parse(defaultLines.join("\n")) as MemoryListResult[];
    // The attested entry is guidance-eligible and shows by default; the
    // unprovenanced one does not.
    expect(defaultRows.map((row) => row.entry.id)).toContain(attested.id);
    expect(defaultRows.map((row) => row.entry.id)).not.toContain(
      "mem_e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6",
    );

    await expect(
      runCli(["memory", "list", "--workspace", WS, "--include-untrusted"], {
        dbPath,
        write: () => {},
      }),
    ).rejects.toThrow(/--include-untrusted requires --by/);

    const reviewLines: string[] = [];
    expect(
      await runCli(["memory", "list", "--workspace", WS, "--include-untrusted", "--by", REVIEWER], {
        dbPath,
        write: (message) => reviewLines.push(message),
      }),
    ).toBe(0);
    const reviewRows = JSON.parse(reviewLines.join("\n")) as MemoryListResult[];
    const untrustedRow = reviewRows.find(
      (row) => row.entry.id === "mem_e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6",
    );
    expect(untrustedRow?.trust).toBe("untrusted");
    expect(eventsOfKind("memory.untrusted_reviewed")).toHaveLength(1);
  });

  it("anchors the demo's memories to the artifact_created event so they stay guidance-eligible", async () => {
    // The demo runs in its own database: it owns the canonical workspace ids.
    const demoRoot = mkdtempSync(join(tmpdir(), "openmao-ts-provenance-demo-"));
    const demoDatabase = new Database(join(demoRoot, "openmao.sqlite3"));
    demoDatabase.initialize();
    try {
      const spine = new SpineService(demoDatabase, {
        artifact_dir: join(demoRoot, "artifacts"),
        collective_memory_dir: join(demoRoot, "collective_memory"),
      });
      await spine.startDemo();

      const events = new EventStore(demoDatabase);
      const artifactEvent = events.getByIdempotencyKey(WORKSPACE_ID, `${RUN_ID}:artifact_created`);
      const memory = new MemoryEntryStore(demoDatabase).get(COORDINATOR_MEMORY_ID);
      expect(artifactEvent).not.toBeNull();
      expect(memory?.provenance.source_event_id).toBe(artifactEvent?.id);
      expect(
        deriveMemoryTrust(memory as MemoryEntry, {
          events,
          capabilityResults: new CapabilityResultStore(demoDatabase),
        }),
      ).toEqual({ trust: "guidance_eligible", basis: "source_event", unresolved: [] });
      expect(
        events
          .listForWorkspace(WORKSPACE_ID)
          .filter((event) => event.kind === "memory.provenance_unresolved"),
      ).toEqual([]);
    } finally {
      demoDatabase.close();
      rmSync(demoRoot, { recursive: true, force: true });
    }
  });
});
