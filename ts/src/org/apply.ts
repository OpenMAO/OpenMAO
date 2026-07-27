import { createHash } from "node:crypto";

import {
  EventPayloadSchema,
  type OrgChangeApplication,
  OrgChangeApplicationSchema,
  type OrgChangeProposal,
  type OrgChangeTargetState,
  utcNow,
} from "../contracts/index.js";
import {
  DECISION_OBJECT_TYPES,
  type DecisionSigner,
  decisionSignatureRef,
  signOrgChangeApply,
  signOrgChangeRevert,
  snapshotPrincipalIdentity,
} from "../governance/decision-signing.js";
import {
  type Database,
  EventStore,
  MemoryEntryStore,
  OrgChangeApplicationStore,
  OrgChangeProposalStore,
  OrgControlStore,
} from "../persistence/index.js";
import { dumpJson } from "../persistence/serialization.js";

// A single self-correction step can touch at most this many targets unless overridden. This is
// the per-application blast-radius cap: a guardrail against one ratified change rewriting the org
// wholesale. (The per-tick cap across many applications is an M2 heartbeat concern.)
export const DEFAULT_MAX_BLAST_RADIUS = 25;

export class OrgChangeApplyError extends Error {}
export class OrgChangeApplyPausedError extends OrgChangeApplyError {}
export class OrgChangeBlastRadiusError extends OrgChangeApplyError {}
export class ProposerApplierSeparationError extends OrgChangeApplyError {}
export class EvidenceRequiredError extends OrgChangeApplyError {}
export class OrgChangeVerificationError extends OrgChangeApplyError {}
export class OrgChangeRevertConflictError extends OrgChangeApplyError {}

export type ApplierContext = {
  database: Database;
  memory: MemoryEntryStore;
  // The workspace the change belongs to. Every applier read/write must be scoped to it so a
  // change in one workspace can never touch another's state by referencing its id.
  workspace_id: string;
};

/**
 * An applier knows how to apply and reverse exactly one `change_type`. Its methods run INSIDE the
 * engine's transaction, so a failure anywhere rolls the whole application back (auto-revert). The
 * engine owns the cross-cutting concerns — guardrails, idempotency, recording, verification — and
 * the applier owns only the change-type-specific reads and mutations.
 */
export type ChangeApplier = {
  change_type: string;
  reversible: boolean;
  /** Resolve the target refs this proposal would touch, WITHOUT mutating (for blast-radius). */
  plan(ctx: ApplierContext, proposal: OrgChangeProposal): string[];
  /** Current status + content hash of a target (drives verification + revert-conflict detection). */
  inspect(ctx: ApplierContext, ref: string): { status: string; hash: string };
  /** Mutate one target; return the status the target is intended to hold afterwards. */
  applyTarget(
    ctx: ApplierContext,
    proposal: OrgChangeProposal,
    ref: string,
  ): { expected_status: string };
  /** Reverse the mutation for one target, back to its recorded before-state. */
  revertTarget(ctx: ApplierContext, target: OrgChangeTargetState): void;
};

type ApplyInput = { workspace_id: string; signer: DecisionSigner; at?: string | null };
type RevertInput = { workspace_id: string; signer: DecisionSigner; at?: string | null };

export class OrgChangeApplyService {
  private readonly events: EventStore;
  private readonly proposals: OrgChangeProposalStore;
  private readonly applications: OrgChangeApplicationStore;
  private readonly control: OrgControlStore;
  private readonly memory: MemoryEntryStore;
  private readonly appliers = new Map<string, ChangeApplier>();
  private readonly maxBlastRadius: number;

  constructor(
    private readonly database: Database,
    options: { maxBlastRadius?: number; appliers?: ChangeApplier[] } = {},
  ) {
    this.events = new EventStore(database);
    this.proposals = new OrgChangeProposalStore(database);
    this.applications = new OrgChangeApplicationStore(database);
    this.control = new OrgControlStore(database);
    this.memory = new MemoryEntryStore(database);
    this.maxBlastRadius = options.maxBlastRadius ?? DEFAULT_MAX_BLAST_RADIUS;
    for (const applier of options.appliers ?? [memoryCleanupApplier()]) {
      // M1 only supports reversible changes. A non-reversible (destructive) applier is rejected at
      // registration so the "no destructive appliers in M1" boundary is structurally enforced, not
      // merely a convention the revert path relies on.
      if (!applier.reversible) {
        throw new OrgChangeApplyError(
          `M1 only supports reversible appliers; ${applier.change_type} is not reversible`,
        );
      }
      this.appliers.set(applier.change_type, applier);
    }
  }

  /** Whether a real applier exists for a change type (vs the legacy marker path). */
  hasApplier(changeType: string): boolean {
    return this.appliers.has(changeType);
  }

  /**
   * The shared apply guardrails — enforced for BOTH the real apply path and the legacy marker
   * path, so a paused / unevidenced / self-applied proposal can never advance to `applied` by any
   * route. Kept separate so `OrgChangeService.markApplied` can reuse it. Proposer/applier
   * separation compares STABLE PRINCIPAL IDS, never key ids.
   */
  assertApplyAllowed(
    proposal: OrgChangeProposal,
    input: { workspace_id: string; principal_id: string },
  ): void {
    if (this.control.isApplyPaused(input.workspace_id)) {
      throw new OrgChangeApplyPausedError(`apply is paused for workspace ${input.workspace_id}`);
    }
    if (proposal.evidence.length === 0) {
      throw new EvidenceRequiredError(`proposal ${proposal.id} cannot be applied without evidence`);
    }
    if (proposal.proposed_by === input.principal_id) {
      throw new ProposerApplierSeparationError(
        `proposer and applier must differ: ${input.principal_id}`,
      );
    }
  }

  private contextFor(workspaceId: string): ApplierContext {
    return { database: this.database, memory: this.memory, workspace_id: workspaceId };
  }

  /**
   * Apply an approved proposal for real: enforce guardrails, record the before-state, mutate via
   * compare-and-swap, verify the mutation achieved its intended state, and record a verified
   * `OrgChangeApplication`. The whole thing is one transaction, so any failure (a guardrail, a
   * drifted target, a failed verification) rolls back with no partial mutation. Idempotent: a
   * proposal already applied returns its existing application without mutating again.
   */
  apply(proposalId: string, input: ApplyInput): OrgChangeApplication {
    return this.database.transaction(() => {
      // Snapshot the identity ONCE: the proposer/applier guard and the
      // stored-signer resolution both act on this snapshot.
      const identity = snapshotPrincipalIdentity(input.signer.principal);
      const proposal = this.proposals.get(proposalId);
      if (!proposal) {
        throw new OrgChangeApplyError(`org change proposal not found: ${proposalId}`);
      }
      if (proposal.workspace_id !== input.workspace_id) {
        throw new OrgChangeApplyError("org change proposal does not belong to workspace");
      }
      const existing = this.applications.getForProposal(input.workspace_id, proposalId);
      if (proposal.status === "applied") {
        if (existing) {
          return existing;
        }
        throw new OrgChangeApplyError(
          `proposal ${proposalId} is applied but has no application record`,
        );
      }
      if (proposal.status !== "approved") {
        throw new OrgChangeApplyError("org change proposal must be approved before applied");
      }
      const applier = this.requireApplier(proposal.change_type);

      // Guardrails (day one), all inside the transaction so a refusal leaves no trace and no
      // mutation. Shared with the marker path through assertApplyAllowed.
      this.assertApplyAllowed(proposal, {
        workspace_id: input.workspace_id,
        principal_id: identity.principal_id,
      });

      const ctx = this.contextFor(input.workspace_id);
      const refs = dedupe(applier.plan(ctx, proposal));
      if (refs.length === 0) {
        throw new OrgChangeApplyError(`proposal ${proposalId} resolved no targets`);
      }
      if (refs.length > this.maxBlastRadius) {
        throw new OrgChangeBlastRadiusError(
          `proposal ${proposalId} touches ${refs.length} targets, exceeding the cap of ${this.maxBlastRadius}`,
        );
      }

      // Pre-record before-state, then mutate + verify each target.
      const before = refs.map((ref) => ({ ref, ...applier.inspect(ctx, ref) }));
      const targets: OrgChangeTargetState[] = [];
      for (const entry of before) {
        const { expected_status } = applier.applyTarget(ctx, proposal, entry.ref);
        const after = applier.inspect(ctx, entry.ref);
        if (after.status !== expected_status) {
          throw new OrgChangeVerificationError(
            `post-apply verification failed for ${entry.ref}: expected ${expected_status}, observed ${after.status}`,
          );
        }
        targets.push({
          ref: entry.ref,
          before_status: entry.status,
          after_status: after.status,
          before_hash: entry.hash,
          after_hash: after.hash,
        });
      }

      const at = input.at ?? utcNow();
      const applied = this.proposals.setStatus(proposalId, "applied", { resolved_at: at });

      // Explicit lifecycle: record the application as `applied` and emit `org_change.applied`,
      // then — every target having been verified above — promote it to `verified` with its own
      // event. The two steps keep the verification outcome legible in the persisted record and the
      // event log, even though both happen atomically in this transaction.
      const appliedApplication = this.applications.create(
        OrgChangeApplicationSchema.parse({
          id: applicationIdForProposal(proposalId),
          workspace_id: input.workspace_id,
          proposal_id: proposalId,
          change_type: proposal.change_type,
          applied_by: identity.principal_id,
          reversible: applier.reversible,
          targets,
          status: "applied",
          created_at: at,
        }),
      );
      // Sign over the STORED application row (its created_at, never a
      // signing-time clock): mutation, application record, signature row, and
      // events commit together or roll back together.
      const decision = signOrgChangeApply({
        database: this.database,
        workspaceId: input.workspace_id,
        signer: input.signer,
        identity,
        objectType: DECISION_OBJECT_TYPES.org_change_apply,
        application: appliedApplication,
      });
      this.events.append({
        workspace_id: input.workspace_id,
        kind: "org_change.applied",
        actor: identity.actor,
        payload: EventPayloadSchema.parse({
          data: {
            org_change_application: appliedApplication,
            org_change_proposal: applied,
            decision_signature: decisionSignatureRef(decision),
          },
          refs: [appliedApplication.id, proposalId, ...refs.filter(isCanonicalId)],
        }),
        idempotency_key: `${proposalId}:applied`,
      });
      const verified = this.applications.setStatus(appliedApplication.id, "verified", {
        verified_at: at,
      });
      this.events.append({
        workspace_id: input.workspace_id,
        kind: "org_change.verified",
        actor: identity.actor,
        payload: EventPayloadSchema.parse({
          data: { org_change_application: verified },
          refs: [verified.id, proposalId],
        }),
        idempotency_key: `${proposalId}:verified`,
      });
      return verified;
    });
  }

  /**
   * Reverse a verified application. Refuses (revert-conflict) if any target has drifted since it
   * was applied — its live content hash no longer matches the recorded `after_hash` — so a reverse
   * never silently clobbers an intervening change. Idempotent: an already-reverted application is
   * returned unchanged.
   */
  revert(applicationId: string, input: RevertInput): OrgChangeApplication {
    return this.database.transaction(() => {
      const identity = snapshotPrincipalIdentity(input.signer.principal);
      const application = this.applications.get(applicationId);
      if (!application || application.workspace_id !== input.workspace_id) {
        throw new OrgChangeApplyError(`org change application not found: ${applicationId}`);
      }
      if (application.status === "reverted") {
        return application;
      }
      if (application.status !== "verified") {
        throw new OrgChangeApplyError(
          `only verified applications can be reverted: ${applicationId}`,
        );
      }
      if (!application.reversible) {
        throw new OrgChangeApplyError(`application is not reversible: ${applicationId}`);
      }
      const applier = this.requireApplier(application.change_type);
      const ctx = this.contextFor(input.workspace_id);

      // Revert-conflict guard: every target must still match the state we left it in.
      for (const target of application.targets) {
        const observed = applier.inspect(ctx, target.ref);
        if (observed.hash !== target.after_hash) {
          throw new OrgChangeRevertConflictError(
            `target ${target.ref} changed since it was applied; refusing to revert`,
          );
        }
      }
      for (const target of application.targets) {
        applier.revertTarget(ctx, target);
        const observed = applier.inspect(ctx, target.ref);
        if (observed.status !== target.before_status) {
          throw new OrgChangeVerificationError(
            `revert verification failed for ${target.ref}: expected ${target.before_status}, observed ${observed.status}`,
          );
        }
      }

      const at = input.at ?? utcNow();
      const reverted = this.applications.setStatus(applicationId, "reverted", { reverted_at: at });
      // Sign over the STORED reverted row (its reverted_at, never a
      // signing-time clock), inside the same transaction as the reversal. The
      // wrapper requires the stored row's reverted_at — there is no `?? at`
      // fallback; a reverted row without its decision time refuses to sign.
      const decision = signOrgChangeRevert({
        database: this.database,
        workspaceId: input.workspace_id,
        signer: input.signer,
        identity,
        objectType: DECISION_OBJECT_TYPES.org_change_revert,
        application: reverted,
      });
      this.events.append({
        workspace_id: input.workspace_id,
        kind: "org_change.reverted",
        actor: identity.actor,
        payload: EventPayloadSchema.parse({
          data: {
            org_change_application: reverted,
            decision_signature: decisionSignatureRef(decision),
          },
          refs: [reverted.id, reverted.proposal_id],
        }),
        idempotency_key: `${applicationId}:reverted`,
      });
      return reverted;
    });
  }

  private requireApplier(changeType: string): ChangeApplier {
    const applier = this.appliers.get(changeType);
    if (!applier) {
      throw new OrgChangeApplyError(`no applier registered for change_type: ${changeType}`);
    }
    return applier;
  }
}

/**
 * The first applier: a `memory_cleanup` change flips the named memory entries from `stale` to
 * `rejected`. It is fully reversible (`rejected` → `stale`). Targets are read from the proposal's
 * `patch_json.memory_entries`, and the compare-and-swap enforces that every target really is
 * `stale` before it is touched.
 */
export function memoryCleanupApplier(): ChangeApplier {
  return {
    change_type: "memory_cleanup",
    reversible: true,
    plan(_ctx, proposal) {
      return resolveMemoryTargets(proposal);
    },
    inspect(ctx, ref) {
      const entry = ctx.memory.get(ref);
      // Workspace isolation: a target that belongs to another workspace is treated as absent.
      if (!entry || entry.workspace_id !== ctx.workspace_id) {
        throw new OrgChangeApplyError(
          `memory entry not found in workspace ${ctx.workspace_id}: ${ref}`,
        );
      }
      return { status: entry.status, hash: hashJson(entry) };
    },
    applyTarget(ctx, _proposal, ref) {
      ctx.memory.setStatusIfCurrent(ref, {
        workspace_id: ctx.workspace_id,
        expected_status: "stale",
        next_status: "rejected",
      });
      return { expected_status: "rejected" };
    },
    revertTarget(ctx, target) {
      ctx.memory.setStatusIfCurrent(target.ref, {
        workspace_id: ctx.workspace_id,
        expected_status: "rejected",
        next_status: "stale",
      });
    },
  };
}

function resolveMemoryTargets(proposal: OrgChangeProposal): string[] {
  // `memory_entries` is the key the learning detector emits for stale-memory proposals
  // (LearningService.staleMemory); the applier reads that same contract.
  const raw = (proposal.patch_json as Record<string, unknown>).memory_entries;
  if (!Array.isArray(raw)) {
    throw new OrgChangeApplyError(
      `memory_cleanup proposal ${proposal.id} requires patch_json.memory_entries[]`,
    );
  }
  const refs = raw.filter((value): value is string => typeof value === "string");
  if (refs.length !== raw.length) {
    throw new OrgChangeApplyError(
      `memory_cleanup proposal ${proposal.id} memory_entries must all be strings`,
    );
  }
  for (const ref of refs) {
    if (!isCanonicalId(ref)) {
      throw new OrgChangeApplyError(`memory_cleanup target is not a canonical id: ${ref}`);
    }
  }
  return refs;
}

function applicationIdForProposal(proposalId: string): string {
  // Require the full `orgchg_` proposal prefix before deriving, so two ids that merely share a
  // 32-hex suffix can never collide on the derived application id.
  const suffix = proposalId.match(/^orgchg_([0-9a-f]{32})$/)?.[1];
  if (!suffix) {
    throw new OrgChangeApplyError(`invalid org change proposal id: ${proposalId}`);
  }
  return `application_${suffix}`;
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(dumpJson(value)).digest("hex");
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function isCanonicalId(value: string): boolean {
  return /^[a-z][a-z0-9]*_[0-9a-f]{32}$/.test(value);
}
