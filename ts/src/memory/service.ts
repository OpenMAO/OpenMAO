import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  ApprovalPayloadSchema,
  type ApprovalRequest,
  type Corroboration,
  CorroborationSchema,
  EventPayloadSchema,
  type MemoryEntry,
  MemoryEntrySchema,
  NodeEffectSchema,
  newId,
  PolicyDecisionSchema,
  type PromotionCandidate,
  PromotionCandidateSchema,
  utcNow,
} from "../contracts/index.js";
import { ApprovalService } from "../governance/index.js";
import {
  ApprovalStore,
  CorroborationStore,
  type Database,
  EventStore,
  MemoryEntryStore,
  NodeEffectStore,
  PromotionCandidateStore,
} from "../persistence/index.js";
import { sourcePromotionNote } from "./provenance.js";

export class PromotionServiceError extends Error {}

export class CollectiveMemoryEffectError extends PromotionServiceError {
  constructor(
    readonly workspace_id: string,
    readonly run_id: string,
    readonly reason: string,
  ) {
    super(reason);
  }
}

function deterministicCorroborationId(
  workspaceId: string,
  candidateId: string,
  sourceMemoryEntry: string,
): string {
  const digest = createHash("sha256")
    .update(`${workspaceId}:${candidateId}:${sourceMemoryEntry}`)
    .digest("hex");
  return `corrob_${digest.slice(0, 32)}`;
}

export class PromotionService {
  private readonly entries: MemoryEntryStore;
  private readonly candidates: PromotionCandidateStore;
  private readonly events: EventStore;
  private readonly effects: NodeEffectStore;
  private readonly approvals: ApprovalStore;
  private readonly corroborations: CorroborationStore;
  private readonly minCorroboration: number;
  private readonly collectiveMemoryDir: string;

  constructor(
    private readonly database: Database,
    options: { collective_memory_dir?: string | null; min_corroboration?: number } = {},
  ) {
    this.entries = new MemoryEntryStore(database);
    this.candidates = new PromotionCandidateStore(database);
    this.events = new EventStore(database);
    this.effects = new NodeEffectStore(database);
    this.approvals = new ApprovalStore(database);
    this.corroborations = new CorroborationStore(database);
    // Independent corroboration is required by default. Callers that intentionally ratify
    // without it (the deterministic demo, focused unit tests) must opt in to 0 explicitly.
    this.minCorroboration = Math.max(0, Math.floor(options.min_corroboration ?? 1));
    this.collectiveMemoryDir =
      options.collective_memory_dir ??
      (database.path === ":memory:"
        ? join(tmpdir(), "openmao-collective-memory")
        : join(dirname(database.path), "collective_memory"));
  }

  writeIndividual(entry: MemoryEntry): MemoryEntry {
    const parsed = MemoryEntrySchema.parse(entry);
    if (parsed.scope !== "individual") {
      throw new PromotionServiceError("writeIndividual only accepts individual memory");
    }

    return this.database.transaction(() => {
      const stored = this.entries.save(parsed);
      this.events.append({
        workspace_id: stored.workspace_id,
        run_id: stored.provenance.run_id,
        kind: "memory.individual_written",
        actor: "promotion_service",
        payload: EventPayloadSchema.parse({ data: { memory_entry: stored }, refs: [stored.id] }),
        idempotency_key: `${stored.id}:individual_written`,
      });
      return stored;
    });
  }

  propose(
    candidate: PromotionCandidate,
    input: { requested_by: string; run_id?: string | null; approval_id?: string | null },
  ): { candidate: PromotionCandidate; approval_id: string } {
    const parsed = PromotionCandidateSchema.parse(candidate);

    return this.database.transaction(() => {
      if (parsed.status !== "pending") {
        throw new PromotionServiceError("only pending promotion candidates can be proposed");
      }
      // The proposer requests promotion of their own candidate: the approval's requested_by
      // must be the candidate's proposed_by, so the downstream approver != requester guard is
      // genuinely an approver != proposer check (not a check against an unrelated requester).
      if (input.requested_by !== parsed.proposed_by) {
        throw new PromotionServiceError(
          "promotion requested_by must match the candidate's proposed_by",
        );
      }
      const source = this.entries.get(parsed.source_memory_entry);
      if (!source) {
        throw new Error(`source memory entry not found: ${parsed.source_memory_entry}`);
      }
      if (source.workspace_id !== parsed.workspace_id) {
        throw new PromotionServiceError(
          "source memory entry does not belong to promotion workspace",
        );
      }
      if (input.run_id && source.provenance.run_id !== input.run_id) {
        throw new PromotionServiceError(
          "run-bound promotion must match source memory provenance run",
        );
      }

      const stored = this.candidates.save(parsed);
      this.recordPromotionPolicyDecision(stored, source);
      this.events.append({
        workspace_id: stored.workspace_id,
        run_id: input.run_id ?? source.provenance.run_id,
        kind: "memory.promotion_proposed",
        actor: "promotion_service",
        payload: EventPayloadSchema.parse({
          data: { promotion_candidate: stored },
          refs: [stored.id, stored.source_memory_entry],
        }),
        idempotency_key: `${stored.id}:promotion_proposed`,
      });
      const approval = new ApprovalService(this.database).request({
        approval_id: input.approval_id ?? null,
        workspace_id: stored.workspace_id,
        run_id: input.run_id ?? null,
        action: "memory.promote",
        requested_by: input.requested_by,
        payload: ApprovalPayloadSchema.parse({
          target_type: "promotion_candidate",
          target_id: stored.id,
          reason: stored.rationale,
          data: { promotion_candidate: stored },
        }),
        on_approve: input.run_id ? "resume_run" : "apply_without_run",
        on_reject: input.run_id ? "fail_run" : "no_op",
      });
      return { candidate: stored, approval_id: approval.id };
    });
  }

  recordCorroboration(
    candidateId: string,
    input: {
      source_memory_entry: string;
      corroborated_by: string;
      strength?: number;
      note?: string | null;
      run_id?: string | null;
      corroboration_id?: string | null;
    },
  ): { corroboration: Corroboration; candidate: PromotionCandidate } {
    return this.database.transaction(() => {
      const candidate = this.candidates.get(candidateId);
      if (!candidate) {
        throw new PromotionServiceError(`promotion candidate not found: ${candidateId}`);
      }
      const corroborationId =
        input.corroboration_id ??
        deterministicCorroborationId(
          candidate.workspace_id,
          candidate.id,
          input.source_memory_entry,
        );
      const priorCorroboration = this.corroborations.get(corroborationId);
      if (priorCorroboration) {
        // Idempotent retry: this exact corroboration was already recorded.
        if (
          priorCorroboration.candidate_id !== candidateId ||
          priorCorroboration.source_memory_entry !== input.source_memory_entry
        ) {
          throw new PromotionServiceError(
            "corroboration id already records a different corroboration",
          );
        }
        return { corroboration: priorCorroboration, candidate };
      }
      if (candidate.status !== "pending") {
        throw new PromotionServiceError("only pending promotion candidates can be corroborated");
      }
      if (input.corroborated_by === candidate.proposed_by) {
        throw new PromotionServiceError("a promotion cannot be corroborated by its proposer");
      }
      if (input.source_memory_entry === candidate.source_memory_entry) {
        throw new PromotionServiceError(
          "a promotion cannot be corroborated by its own source memory entry",
        );
      }
      const source = this.entries.get(input.source_memory_entry);
      if (!source) {
        throw new PromotionServiceError(
          `corroborating memory entry not found: ${input.source_memory_entry}`,
        );
      }
      if (source.workspace_id !== candidate.workspace_id) {
        throw new PromotionServiceError(
          "corroborating memory entry does not belong to candidate workspace",
        );
      }
      if (input.run_id && source.provenance.run_id !== input.run_id) {
        throw new PromotionServiceError(
          "run-bound corroboration must match the corroborating memory's provenance run",
        );
      }
      if (source.scope !== "individual") {
        throw new PromotionServiceError("corroboration must come from an individual memory entry");
      }
      if (source.status === "rejected" || source.status === "stale") {
        throw new PromotionServiceError(
          "a rejected or stale memory entry cannot corroborate a promotion",
        );
      }
      const alreadyCorroborated = this.corroborations
        .listForCandidate(candidateId)
        .some(
          (existing) =>
            existing.source_memory_entry === input.source_memory_entry ||
            existing.corroborated_by === input.corroborated_by,
        );
      if (alreadyCorroborated) {
        throw new PromotionServiceError(
          "this memory entry or actor has already corroborated this promotion candidate",
        );
      }

      const corroboration = this.corroborations.save(
        CorroborationSchema.parse({
          id: corroborationId,
          workspace_id: candidate.workspace_id,
          candidate_id: candidate.id,
          source_memory_entry: input.source_memory_entry,
          corroborated_by: input.corroborated_by,
          strength: input.strength ?? 1,
          note: input.note ?? null,
          created_at: utcNow(),
        }),
      );
      const count = this.corroborations.countForCandidate(candidateId);
      const updatedCandidate = this.candidates.setCorroborationCount(candidateId, count);

      this.events.append({
        workspace_id: candidate.workspace_id,
        run_id: input.run_id ?? source.provenance.run_id,
        kind: "memory.corroboration_recorded",
        actor: "promotion_service",
        payload: EventPayloadSchema.parse({
          data: {
            corroboration,
            corroboration_count: count,
            promotion_candidate: updatedCandidate,
          },
          refs: [corroboration.id, candidate.id, input.source_memory_entry],
        }),
        idempotency_key: `${corroboration.id}:corroboration_recorded`,
      });
      return { corroboration, candidate: updatedCandidate };
    });
  }

  ratifyAndWriteCollective(
    candidateId: string,
    input: { workspace_id: string; approval_id: string; resolved_at?: string | null },
  ): MemoryEntry {
    return this.database.transaction(() => {
      const approval = this.requireApprovedPromotionApproval(
        input.approval_id,
        input.workspace_id,
        candidateId,
      );
      const candidate = this.candidates.get(candidateId);
      if (!candidate) {
        throw new Error(`promotion candidate not found: ${candidateId}`);
      }
      if (candidate.workspace_id !== input.workspace_id) {
        throw new PromotionServiceError(
          "promotion candidate does not belong to approval workspace",
        );
      }
      const source = this.entries.get(candidate.source_memory_entry);
      if (!source) {
        throw new Error(`source memory entry not found: ${candidate.source_memory_entry}`);
      }
      if (source.workspace_id !== input.workspace_id) {
        throw new PromotionServiceError(
          "source memory entry does not belong to approval workspace",
        );
      }
      if (approval.run_id && approval.run_id !== source.provenance.run_id) {
        throw new PromotionServiceError("approval run does not match source memory provenance run");
      }
      const corroborationCount = this.corroborations.countForCandidate(candidate.id);
      if (corroborationCount < this.minCorroboration) {
        throw new PromotionServiceError(
          `promotion requires at least ${this.minCorroboration} corroboration(s): ${candidate.id}`,
        );
      }

      const ratified = this.candidates.setStatus(candidate.id, "ratified", {
        resolved_at: input.resolved_at ?? null,
      });
      const collective = this.entries.save(
        this.collectiveEntry(ratified, source, corroborationCount),
      );
      const content = this.collectiveMarkdown(collective, ratified);
      const contentHash = this.contentHash(content);
      const { contentRef, effect } = this.ensureCollectiveFileAndEffect(
        ratified,
        collective,
        content,
        contentHash,
      );

      this.events.append({
        workspace_id: input.workspace_id,
        run_id: collective.provenance.run_id,
        kind: "memory.collective_written",
        actor: "promotion_service",
        payload: EventPayloadSchema.parse({
          data: {
            approval_id: input.approval_id,
            approval_request: approval,
            promotion_candidate: ratified,
            memory_entry: collective,
            content_ref: contentRef,
            node_effect_id: effect?.id ?? null,
          },
          refs: [input.approval_id, ratified.id, collective.id, ...(effect ? [effect.id] : [])],
        }),
        idempotency_key: `${ratified.id}:collective_written`,
      });
      return collective;
    });
  }

  private recordPromotionPolicyDecision(candidate: PromotionCandidate, source: MemoryEntry): void {
    const decision = PolicyDecisionSchema.parse({
      id: `decision_${candidate.id.split("_", 2)[1]}`,
      workspace_id: candidate.workspace_id,
      run_id: source.provenance.run_id,
      action: "memory.promote",
      target_type: "promotion_candidate",
      target_id: candidate.id,
      outcome: "require_approval",
      reason: "Collective memory writes are approval-gated in v0.",
    });
    this.events.append({
      workspace_id: decision.workspace_id,
      run_id: decision.run_id,
      kind: "policy.decision",
      actor: "governance",
      payload: EventPayloadSchema.parse({ data: { policy_decision: decision } }),
      idempotency_key: `${candidate.id}:policy_decision`,
    });
  }

  private requireApprovedPromotionApproval(
    approvalId: string,
    workspaceId: string,
    candidateId: string,
  ): ApprovalRequest {
    const approval = this.approvals.get(approvalId);
    if (!approval) {
      throw new PromotionServiceError(`approval request not found: ${approvalId}`);
    }
    if (approval.workspace_id !== workspaceId) {
      throw new PromotionServiceError(
        `approval request does not belong to workspace: ${approvalId}`,
      );
    }
    if (approval.status !== "approved") {
      throw new PromotionServiceError(
        `promotion requires an approved approval request: ${approvalId}`,
      );
    }
    if (
      approval.payload.target_type !== "promotion_candidate" ||
      approval.payload.target_id !== candidateId
    ) {
      throw new PromotionServiceError(
        `approval request does not target promotion candidate: ${approvalId}`,
      );
    }
    return approval;
  }

  private collectiveEntry(
    candidate: PromotionCandidate,
    source: MemoryEntry,
    corroborationCount: number,
  ): MemoryEntry {
    return MemoryEntrySchema.parse({
      id: `mem_${candidate.id.split("_", 2)[1]}`,
      workspace_id: candidate.workspace_id,
      scope: "collective",
      owner_id: null,
      kind: source.kind,
      content: candidate.proposed_content,
      provenance: {
        agent_id: candidate.proposed_by,
        run_id: source.provenance.run_id,
        task_id: source.provenance.task_id,
        source_event_id: source.provenance.source_event_id,
        note: sourcePromotionNote(candidate.id),
      },
      confidence: Math.min(1, source.confidence + 0.05 * corroborationCount),
      status: "confirmed",
      created_at: candidate.resolved_at ?? utcNow(),
    });
  }

  private collectiveMarkdown(entry: MemoryEntry, candidate: PromotionCandidate): string {
    return [
      "---",
      `id: ${entry.id}`,
      `workspace_id: ${entry.workspace_id}`,
      `status: ${entry.status}`,
      `source_promotion: ${candidate.id}`,
      `proposed_by: ${candidate.proposed_by}`,
      `confidence: ${entry.confidence}`,
      `created_at: ${entry.created_at}`,
      "---",
      "",
      "# Collective Memory",
      "",
      entry.content,
      "",
    ].join("\n");
  }

  private contentHash(content: string): string {
    return createHash("sha256").update(content).digest("hex");
  }

  private writeCollectiveFile(
    candidate: PromotionCandidate,
    content: string,
    hash: string,
  ): string {
    mkdirSync(this.collectiveMemoryDir, { recursive: true });
    const path = this.collectiveFilePath(candidate);
    if (existsSync(path)) {
      const existingHash = createHash("sha256").update(readFileSync(path)).digest("hex");
      if (existingHash !== hash) {
        throw new PromotionServiceError(
          `collective memory file already exists with different content: ${path}`,
        );
      }
      return path;
    }
    const tempPath = `${path}.tmp`;
    writeFileSync(tempPath, content, "utf8");
    renameSync(tempPath, path);
    return path;
  }

  private verifyCollectiveFile(candidate: PromotionCandidate, hash: string, runId: string): string {
    const path = this.collectiveFilePath(candidate);
    if (!existsSync(path)) {
      throw new CollectiveMemoryEffectError(
        candidate.workspace_id,
        runId,
        `collective memory node effect exists but file is missing: ${path}`,
      );
    }
    const existingHash = createHash("sha256").update(readFileSync(path)).digest("hex");
    if (existingHash !== hash) {
      throw new CollectiveMemoryEffectError(
        candidate.workspace_id,
        runId,
        `collective memory node effect hash does not match stored file content: ${path}`,
      );
    }
    return path;
  }

  private collectiveFilePath(candidate: PromotionCandidate): string {
    return join(this.collectiveMemoryDir, `${candidate.id}.md`);
  }

  private ensureCollectiveFileAndEffect(
    candidate: PromotionCandidate,
    entry: MemoryEntry,
    content: string,
    contentHash: string,
  ): { contentRef: string; effect: ReturnType<NodeEffectStore["record"]> | null } {
    if (!entry.provenance.run_id) {
      return {
        contentRef: this.writeCollectiveFile(candidate, content, contentHash),
        effect: null,
      };
    }

    const node = "memory:collective";
    const idempotencyKey = `${candidate.id}:collective_write`;
    const existing = this.effects.getByKey(entry.provenance.run_id, node, idempotencyKey);
    if (existing) {
      if (existing.content_hash !== contentHash) {
        throw new CollectiveMemoryEffectError(
          entry.workspace_id,
          entry.provenance.run_id,
          "collective memory node effect hash does not match stored file content",
        );
      }
      return {
        contentRef: this.verifyCollectiveFile(candidate, contentHash, existing.run_id),
        effect: existing,
      };
    }

    const contentRef = this.writeCollectiveFile(candidate, content, contentHash);
    const effect = this.effects.record(
      NodeEffectSchema.parse({
        id: newId("effect"),
        workspace_id: candidate.workspace_id,
        run_id: entry.provenance.run_id,
        node,
        idempotency_key: idempotencyKey,
        effect_type: "memory.collective_write",
        effect_ref: entry.id,
        content_hash: contentHash,
        created_at: entry.created_at,
      }),
    );
    return { contentRef, effect };
  }
}
