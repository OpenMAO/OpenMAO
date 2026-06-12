import { EventPayloadSchema, type MemoryEntry } from "../contracts/index.js";
import {
  CapabilityResultStore,
  CorroborationStore,
  type Database,
  EventStore,
  MemoryEntryStore,
} from "../persistence/index.js";
import {
  deriveMemoryTrust,
  type MemoryTrust,
  type MemoryTrustStores,
  parseSourcePromotion,
} from "./provenance.js";

export class MemoryReviewError extends Error {}

export type MemorySearchFilters = {
  scope?: MemoryEntry["scope"];
  kind?: MemoryEntry["kind"];
  min_confidence?: number;
  limit?: number;
  /**
   * Scopes the search to a specific owner so a caller can retrieve that owner's
   * private individual memory. Owned individual memory is otherwise excluded.
   */
  owner_id?: string;
};

/**
 * The review path of the provenance invariant (#113). Recall is
 * guidance-eligible only; untrusted memory is reachable solely through this
 * explicit, operator/diagnosis-grade option, and reading it is itself put on
 * the record as a `memory.untrusted_reviewed` audit event.
 */
export type MemoryReviewOptions = {
  include_untrusted: true;
  /** The reviewing actor; required because the review is an audited act. */
  reviewed_by: string;
};

/**
 * The evidence that justifies reusing a piece of remembered knowledge: how
 * confident it is, how many independent sources corroborated its promotion, and
 * which promotion produced it (for collective memory).
 */
export type MemorySearchEvidence = {
  confidence: number;
  corroboration_count: number;
  source_promotion: string | null;
};

export type MemorySearchResult = {
  entry: MemoryEntry;
  score: number;
  matched_terms: string[];
  evidence: MemorySearchEvidence;
  /** Derived trust tier; always "guidance_eligible" outside the review path. */
  trust: MemoryTrust;
};

export type MemoryListResult = {
  entry: MemoryEntry;
  /** Derived trust tier; always "guidance_eligible" outside the review path. */
  trust: MemoryTrust;
};

export type MemoryListFilters = {
  scope?: MemoryEntry["scope"];
  /**
   * Restrict to individual memory owned by this actor. The API individual-memory
   * read uses this so a per-agent surface still runs through the trust filter
   * (#113) instead of reading the store directly.
   */
  owner_id?: string;
};

const DEFAULT_LIMIT = 50;
// ASCII-alphanumeric, lowercased tokens — deterministic and dependency-free.
// Non-Latin scripts are out of scope for v0.5.0; a future analyzer/FTS can extend this.
const TOKEN_PATTERN = /[a-z0-9]+/g;

function uniqueTokens(text: string): Set<string> {
  return new Set(text.toLowerCase().match(TOKEN_PATTERN) ?? []);
}

/**
 * Deterministic, dependency-free retrieval over stored memory. Ranks entries by
 * query-term overlap, breaking ties by confidence, then corroboration evidence,
 * then id, so results are stable and reproducible without a search engine. Each
 * result carries the evidence (confidence, corroboration count, source
 * promotion) that justifies reusing the knowledge — turning memory from
 * write-only storage into a reusable, evidence-backed asset.
 *
 * Recall enforces the provenance invariant (#113): by default only
 * guidance-eligible memory (derived, never asserted — see deriveMemoryTrust)
 * is returned. Untrusted memory is reachable only through the explicit review
 * option, comes back labeled, and the review itself is appended to the event
 * log.
 */
export class MemoryRetrievalService {
  private readonly entries: MemoryEntryStore;
  private readonly corroborations: CorroborationStore;
  private readonly events: EventStore;
  private readonly capabilityResults: CapabilityResultStore;

  constructor(database: Database) {
    this.entries = new MemoryEntryStore(database);
    this.corroborations = new CorroborationStore(database);
    this.events = new EventStore(database);
    this.capabilityResults = new CapabilityResultStore(database);
  }

  search(
    workspaceId: string,
    query: string,
    filters: MemorySearchFilters = {},
    review?: MemoryReviewOptions,
  ): MemorySearchResult[] {
    const reviewer = this.requireReviewer(review);
    const queryTerms = [...uniqueTokens(query)];
    if (queryTerms.length === 0) {
      return [];
    }

    const minConfidence =
      filters.min_confidence === undefined || Number.isNaN(filters.min_confidence)
        ? 0
        : filters.min_confidence;
    const limit =
      filters.limit === undefined || Number.isNaN(filters.limit)
        ? DEFAULT_LIMIT
        : Math.max(0, Math.floor(filters.limit));

    const results: MemorySearchResult[] = [];
    for (const entry of this.entries.listForWorkspace(workspaceId)) {
      if (filters.scope && entry.scope !== filters.scope) {
        continue;
      }
      if (filters.kind && entry.kind !== filters.kind) {
        continue;
      }
      if (entry.confidence < minConfidence) {
        continue;
      }
      // Only confirmed-tier knowledge is reusable; never surface rejected or
      // stale memory as evidence.
      if (entry.status === "rejected" || entry.status === "stale") {
        continue;
      }
      // Agent-private individual memory (owned) is returned only when the caller
      // scopes the search to that owner; collective and unowned memory are shared.
      if (
        entry.scope === "individual" &&
        entry.owner_id !== null &&
        entry.owner_id !== filters.owner_id
      ) {
        continue;
      }

      const contentTokens = uniqueTokens(entry.content);
      const matched = queryTerms.filter((term) => contentTokens.has(term));
      if (matched.length === 0) {
        continue;
      }

      // Provenance invariant (#113): unprovenanced memory never reaches recall.
      const { trust } = deriveMemoryTrust(entry, this.trustStores());
      if (trust === "untrusted" && !reviewer) {
        continue;
      }

      const evidence = this.evidenceFor(entry);
      results.push({
        entry,
        score: matched.length + entry.confidence,
        matched_terms: matched,
        evidence,
        trust,
      });
    }

    results.sort((a, b) => {
      if (b.matched_terms.length !== a.matched_terms.length) {
        return b.matched_terms.length - a.matched_terms.length;
      }
      if (b.entry.confidence !== a.entry.confidence) {
        return b.entry.confidence - a.entry.confidence;
      }
      if (b.evidence.corroboration_count !== a.evidence.corroboration_count) {
        return b.evidence.corroboration_count - a.evidence.corroboration_count;
      }
      if (a.entry.id < b.entry.id) {
        return -1;
      }
      return a.entry.id > b.entry.id ? 1 : 0;
    });

    const limited = results.slice(0, limit);
    if (reviewer) {
      this.recordUntrustedReview(
        workspaceId,
        reviewer,
        limited.filter((result) => result.trust === "untrusted").map((result) => result.entry.id),
      );
    }
    return limited;
  }

  /**
   * Lists workspace memory with the derived trust tier. The default omits
   * untrusted entries; the review option includes them labeled and puts the
   * review on the record. Optional filters narrow by scope/owner so per-agent
   * and per-scope surfaces still run through the trust filter (#113).
   */
  list(
    workspaceId: string,
    filters: MemoryListFilters = {},
    review?: MemoryReviewOptions,
  ): MemoryListResult[] {
    const reviewer = this.requireReviewer(review);
    const results: MemoryListResult[] = [];
    for (const entry of this.entries.listForWorkspace(workspaceId)) {
      if (filters.scope && entry.scope !== filters.scope) {
        continue;
      }
      if (filters.owner_id !== undefined && entry.owner_id !== filters.owner_id) {
        continue;
      }
      const { trust } = deriveMemoryTrust(entry, this.trustStores());
      if (trust === "untrusted" && !reviewer) {
        continue;
      }
      results.push({ entry, trust });
    }
    if (reviewer) {
      this.recordUntrustedReview(
        workspaceId,
        reviewer,
        results.filter((result) => result.trust === "untrusted").map((result) => result.entry.id),
      );
    }
    return results;
  }

  private trustStores(): MemoryTrustStores {
    return { events: this.events, capabilityResults: this.capabilityResults };
  }

  private requireReviewer(review?: MemoryReviewOptions): string | null {
    if (!review?.include_untrusted) {
      return null;
    }
    const reviewer = review.reviewed_by?.trim();
    if (!reviewer) {
      throw new MemoryReviewError(
        "reviewing untrusted memory requires reviewed_by: the reviewing actor goes on the record",
      );
    }
    return reviewer;
  }

  /**
   * Reading unpromoted memory is itself on the record: every review that
   * actually returned untrusted entries appends its own audit event. No
   * idempotency key on purpose — each review is a distinct act.
   */
  private recordUntrustedReview(
    workspaceId: string,
    reviewedBy: string,
    untrustedIds: string[],
  ): void {
    if (untrustedIds.length === 0) {
      return;
    }
    this.events.append({
      workspace_id: workspaceId,
      kind: "memory.untrusted_reviewed",
      actor: reviewedBy,
      payload: EventPayloadSchema.parse({
        data: { reviewed_by: reviewedBy, memory_entry_ids: untrustedIds },
        refs: untrustedIds,
      }),
    });
  }

  private evidenceFor(entry: MemoryEntry): MemorySearchEvidence {
    const sourcePromotion =
      entry.scope === "collective" ? parseSourcePromotion(entry.provenance.note) : null;
    const corroborationCount = sourcePromotion
      ? this.corroborations.countForCandidate(sourcePromotion)
      : 0;
    return {
      confidence: entry.confidence,
      corroboration_count: corroborationCount,
      source_promotion: sourcePromotion,
    };
  }
}
