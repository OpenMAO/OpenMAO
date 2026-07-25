import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CorroborationSchema,
  type MemoryEntry,
  MemoryEntrySchema,
  PromotionCandidateSchema,
  WorkspaceSchema,
} from "../src/contracts/index.js";
import { MemoryRetrievalService, PromotionService } from "../src/memory/index.js";
import {
  CorroborationStore,
  Database,
  MemoryEntryStore,
  PromotionCandidateStore,
  WorkspaceStore,
} from "../src/persistence/index.js";

const ATTESTOR = "test_operator";

const fixturePath = new URL("../../tests/fixtures/canonical_v0.json", import.meta.url);
const WS = "ws_11111111111111111111111111111111";
const CANDIDATE_ID = "promo_cccccccccccccccccccccccccccccccc";

const E1 = "mem_e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1"; // collective, both terms, conf 0.9
const E2 = "mem_e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2"; // individual, "email", conf 0.6
const E3 = "mem_e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3"; // collective, "deliverability", conf 0.8
const E4 = "mem_e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4"; // individual, unrelated, conf 0.5

let tmpRoot: string;
let database: Database;

function saveEntry(over: Partial<MemoryEntry> & Pick<MemoryEntry, "id" | "content">): MemoryEntry {
  const base = {
    workspace_id: WS,
    scope: "individual",
    owner_id: null,
    kind: "semantic",
    // Operator-attested so the corpus is guidance-eligible under the
    // provenance invariant (#113); recall-by-default only sees such memory.
    provenance: {
      agent_id: null,
      role_id: null,
      task_id: null,
      run_id: null,
      source_event_id: null,
      note: null,
      capability_result_id: null,
      attested_by: ATTESTOR,
    },
    confidence: 0.5,
    status: "confirmed",
    created_at: "2026-05-27T15:20:00Z",
  };
  const entry = new MemoryEntryStore(database).save(MemoryEntrySchema.parse({ ...base, ...over }));
  // The bare `attested_by` confers nothing without a resolvable attestation
  // event (#113), so put the operator attestation on the record.
  new PromotionService(database).attestMemory(entry.id, { attested_by: ATTESTOR });
  return entry;
}

function seedCorpus(): void {
  saveEntry({
    id: E1,
    scope: "collective",
    kind: "semantic",
    confidence: 0.9,
    content: "cold outreach email deliverability improves with domain warmup",
    provenance: {
      agent_id: null,
      role_id: null,
      task_id: null,
      run_id: null,
      source_event_id: null,
      note: `source_promotion:${CANDIDATE_ID}`,
      capability_result_id: null,
      attested_by: "test_operator",
    },
  });
  saveEntry({
    id: E2,
    scope: "individual",
    kind: "episodic",
    confidence: 0.6,
    content: "email warmup takes about two weeks",
  });
  saveEntry({
    id: E3,
    scope: "collective",
    kind: "semantic",
    confidence: 0.8,
    content: "deliverability depends on sender reputation",
  });
  saveEntry({
    id: E4,
    scope: "individual",
    kind: "decision",
    confidence: 0.5,
    content: "the database migration completed cleanly",
  });
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "openmao-ts-retrieval-"));
  database = new Database(join(tmpRoot, "openmao.sqlite3"));
  database.initialize();
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Record<string, unknown>;
  new WorkspaceStore(database).save(WorkspaceSchema.parse(fixture.workspace));
});

afterEach(() => {
  database.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("evidence-backed memory retrieval", () => {
  it("ranks by term overlap, then confidence, deterministically", () => {
    seedCorpus();
    const results = new MemoryRetrievalService(database).search(WS, "email deliverability");

    // E1 matches both terms; E3 and E2 match one each, ordered by confidence (0.8 > 0.6).
    expect(results.map((r) => r.entry.id)).toEqual([E1, E3, E2]);
    expect(results[0]?.matched_terms.sort()).toEqual(["deliverability", "email"]);
    expect(results[0]?.score).toBeCloseTo(2.9, 5);
  });

  it("returns nothing for an empty query or a query with no matches", () => {
    seedCorpus();
    const service = new MemoryRetrievalService(database);
    expect(service.search(WS, "")).toEqual([]);
    expect(service.search(WS, "   ")).toEqual([]);
    expect(service.search(WS, "kubernetes")).toEqual([]);
  });

  it("filters by scope", () => {
    seedCorpus();
    const service = new MemoryRetrievalService(database);
    expect(service.search(WS, "email", { scope: "collective" }).map((r) => r.entry.id)).toEqual([
      E1,
    ]);
    expect(service.search(WS, "email", { scope: "individual" }).map((r) => r.entry.id)).toEqual([
      E2,
    ]);
  });

  it("filters by kind and by minimum confidence", () => {
    seedCorpus();
    const service = new MemoryRetrievalService(database);
    expect(service.search(WS, "email", { kind: "episodic" }).map((r) => r.entry.id)).toEqual([E2]);
    // min_confidence 0.85 keeps E1 (0.9), drops E3 (0.8).
    expect(
      service.search(WS, "deliverability", { min_confidence: 0.85 }).map((r) => r.entry.id),
    ).toEqual([E1]);
  });

  it("attaches corroboration evidence to promoted collective memory", () => {
    seedCorpus();
    new PromotionCandidateStore(database).save(
      PromotionCandidateSchema.parse({
        id: CANDIDATE_ID,
        workspace_id: WS,
        source_memory_entry: E2,
        proposed_by: "agent_55555555555555555555555555555555",
        proposed_content: "cold outreach email deliverability improves with domain warmup",
        rationale: "repeatedly observed across runs",
        corroboration_count: 0,
        status: "pending",
        created_at: "2026-05-27T15:20:00Z",
      }),
    );
    const corroborations = new CorroborationStore(database);
    for (const [id, source, actor] of [
      ["corrob_c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1", E3, "agent_66666666666666666666666666666666"],
      ["corrob_c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2", E4, "agent_77777777777777777777777777777777"],
    ] as const) {
      corroborations.save(
        CorroborationSchema.parse({
          id,
          workspace_id: WS,
          candidate_id: CANDIDATE_ID,
          source_memory_entry: source,
          corroborated_by: actor,
          strength: 1,
          note: null,
          created_at: "2026-05-27T15:20:05Z",
        }),
      );
    }

    const results = new MemoryRetrievalService(database).search(WS, "email deliverability");
    const collective = results.find((r) => r.entry.id === E1);
    const individual = results.find((r) => r.entry.id === E2);

    expect(collective?.evidence).toEqual({
      confidence: 0.9,
      corroboration_count: 2,
      source_promotion: CANDIDATE_ID,
    });
    expect(individual?.evidence).toEqual({
      confidence: 0.6,
      corroboration_count: 0,
      source_promotion: null,
    });
  });

  it("treats a malformed source_promotion note as no promotion", () => {
    saveEntry({
      id: "mem_e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5",
      scope: "collective",
      content: "email cadence matters for replies",
      provenance: {
        agent_id: null,
        role_id: null,
        task_id: null,
        run_id: null,
        source_event_id: null,
        note: "source_promotion:",
        capability_result_id: null,
        attested_by: "test_operator",
      },
    });

    const [result] = new MemoryRetrievalService(database).search(WS, "email");
    expect(result?.evidence.source_promotion).toBeNull();
    expect(result?.evidence.corroboration_count).toBe(0);
  });

  it("hides owned individual memory unless the search is scoped to that owner", () => {
    const owner = "agent_99999999999999999999999999999999";
    const id = "mem_abababababababababababababababab";
    saveEntry({
      id,
      scope: "individual",
      owner_id: owner,
      content: "a private note about email strategy",
    });
    const service = new MemoryRetrievalService(database);

    expect(service.search(WS, "email").map((r) => r.entry.id)).toEqual([]);
    expect(service.search(WS, "email", { owner_id: owner }).map((r) => r.entry.id)).toEqual([id]);
  });

  it("never returns rejected or stale memory as reusable knowledge", () => {
    saveEntry({
      id: "mem_cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
      scope: "collective",
      status: "stale",
      content: "email tips that went stale",
    });
    saveEntry({
      id: "mem_dcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdc",
      scope: "collective",
      status: "rejected",
      content: "email tips that were rejected",
    });
    saveEntry({
      id: "mem_efefefefefefefefefefefefefefefef",
      scope: "collective",
      status: "confirmed",
      content: "email tips that still hold up",
    });

    const results = new MemoryRetrievalService(database).search(WS, "email");
    expect(results.map((r) => r.entry.id)).toEqual(["mem_efefefefefefefefefefefefefefefef"]);
  });
});
