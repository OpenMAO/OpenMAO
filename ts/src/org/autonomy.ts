import {
  type AutonomyCase,
  AutonomyCaseSchema,
  type AutonomyLevel,
  EventPayloadSchema,
  newId,
  type Organization,
  type OrgChangeEvidence,
  utcNow,
} from "../contracts/index.js";
import {
  AutonomyCaseStore,
  type Database,
  EventStore,
  OrganizationStore,
  OrgChangeApplicationStore,
} from "../persistence/index.js";

// The autonomy ladder, tightest → widest. A widening moves exactly one step up; narrowing moves down.
const LADDER: readonly AutonomyLevel[] = ["advisory", "supervised", "bounded"];

// Minimum audited track record (verified org-change applies) before autonomy may be widened — trust
// is earned through successful supervised operations, not granted.
export const DEFAULT_MIN_TRACK_RECORD = 3;

export class AutonomyServiceError extends Error {}
export class InsufficientTrackRecordError extends AutonomyServiceError {}
export class AutonomyCapError extends AutonomyServiceError {}
export class AutonomyStepError extends AutonomyServiceError {}
export class AutonomyRatificationError extends AutonomyServiceError {}

/**
 * Earned autonomy (M4). The autonomy dial only ever WIDENS via a human-ratified, evidence-backed
 * `AutonomyCase`, **one step at a time**, under a **ceiling**, and only after an **audited track
 * record** of successful supervised operations. The mechanism is conservative by construction:
 *
 *   - `proposeWidening` only RECORDS a case — it never moves the dial.
 *   - `ratifyWidening` is the human gate; it is the *only* path that moves the dial, it requires a
 *     ratifier other than the proposer, and it compare-and-swaps on the exact level the case was
 *     justified against (so the dial can never drift past its evidence).
 *   - Nothing auto-widens; there is no flag.
 *   - `narrow` (tightening) is always allowed without a case — the safe direction.
 */
export class AutonomyService {
  private readonly orgs: OrganizationStore;
  private readonly cases: AutonomyCaseStore;
  private readonly applications: OrgChangeApplicationStore;
  private readonly events: EventStore;
  private readonly maxLevel: AutonomyLevel;
  private readonly minTrackRecord: number;

  constructor(
    private readonly database: Database,
    options: { maxLevel?: AutonomyLevel; minTrackRecord?: number } = {},
  ) {
    this.orgs = new OrganizationStore(database);
    this.cases = new AutonomyCaseStore(database);
    this.applications = new OrgChangeApplicationStore(database);
    this.events = new EventStore(database);
    this.maxLevel = options.maxLevel ?? "bounded";
    this.minTrackRecord = options.minTrackRecord ?? DEFAULT_MIN_TRACK_RECORD;
  }

  // The shared, re-checkable widening preconditions, evaluated against LIVE state. Enforced at BOTH
  // propose and ratify time so a forged or stale case can never land a widening the live org hasn't
  // earned: one-step from the current level, under the ceiling, with evidence + an audited track
  // record. Returns the validated one-step target.
  private assertWidenable(
    org: Organization,
    evidenceCount: number,
    workspaceId: string,
  ): AutonomyLevel {
    const proposedLevel = nextWider(org.autonomy_level);
    if (!proposedLevel) {
      throw new AutonomyStepError(`organization ${org.id} is already at the widest autonomy level`);
    }
    if (ladderIndex(proposedLevel) > ladderIndex(this.maxLevel)) {
      throw new AutonomyCapError(
        `proposed level '${proposedLevel}' exceeds the autonomy ceiling '${this.maxLevel}'`,
      );
    }
    if (evidenceCount === 0) {
      throw new InsufficientTrackRecordError("widening autonomy requires an evidence packet");
    }
    const trackRecord = this.verifiedApplyCount(workspaceId);
    if (trackRecord < this.minTrackRecord) {
      throw new InsufficientTrackRecordError(
        `widening autonomy requires at least ${this.minTrackRecord} verified applies; found ${trackRecord}`,
      );
    }
    return proposedLevel;
  }

  /**
   * Propose widening an org's autonomy one step, backed by evidence + an audited track record. This
   * only records a case for a human to ratify; it never moves the dial.
   */
  proposeWidening(input: {
    workspace_id: string;
    org_id: string;
    proposed_by: string;
    rationale: string;
    evidence?: OrgChangeEvidence[];
    id?: string | null;
    at?: string | null;
  }): AutonomyCase {
    return this.database.transaction(() => {
      const proposedBy = normalizeActor(input.proposed_by, "proposed_by");
      const org = this.requireOrg(input.workspace_id, input.org_id);
      const evidence = input.evidence ?? [];
      const proposedLevel = this.assertWidenable(org, evidence.length, input.workspace_id);

      // At most one pending widening per org/step — avoid duplicate cases racing to ratify.
      const duplicate = this.cases
        .listForWorkspace(input.workspace_id)
        .find(
          (existing) =>
            existing.org_id === input.org_id &&
            existing.status === "proposed" &&
            existing.proposed_level === proposedLevel,
        );
      if (duplicate) {
        throw new AutonomyServiceError(
          `a pending widening to '${proposedLevel}' already exists for organization ${input.org_id}: ${duplicate.id}`,
        );
      }

      const at = input.at ?? utcNow();
      const stored = this.cases.save(
        AutonomyCaseSchema.parse({
          id: input.id ?? newId("autonomy"),
          workspace_id: input.workspace_id,
          org_id: input.org_id,
          current_level: org.autonomy_level,
          proposed_level: proposedLevel,
          evidence,
          rationale: input.rationale,
          status: "proposed",
          proposed_by: proposedBy,
          created_at: at,
        }),
      );
      this.events.append({
        workspace_id: input.workspace_id,
        kind: "autonomy.widening_proposed",
        actor: "autonomy_service",
        payload: EventPayloadSchema.parse({
          data: {
            autonomy_case: stored,
            track_record: this.verifiedApplyCount(input.workspace_id),
          },
          refs: [stored.id, stored.org_id],
        }),
        idempotency_key: `${stored.id}:proposed`,
      });
      return stored;
    });
  }

  /**
   * Ratify a proposed widening — the human gate. This is the only path that moves the dial. It
   * refuses self-ratification and compare-and-swaps on the level the case was justified against, so a
   * widening can never land if the dial has drifted since the case was made.
   */
  ratifyWidening(
    caseId: string,
    input: { workspace_id: string; actor: string; at?: string | null },
  ): AutonomyCase {
    return this.database.transaction(() => {
      const ratifier = normalizeActor(input.actor, "actor");
      const autonomyCase = this.requireCase(input.workspace_id, caseId);
      if (autonomyCase.status !== "proposed") {
        if (autonomyCase.status === "ratified") {
          return autonomyCase;
        }
        throw new AutonomyRatificationError(
          `autonomy case already ${autonomyCase.status}: ${caseId}`,
        );
      }
      if (normalizeActor(autonomyCase.proposed_by, "proposed_by") === ratifier) {
        throw new AutonomyRatificationError(
          `autonomy widening must be ratified by someone other than the proposer: ${ratifier}`,
        );
      }

      // RE-VALIDATE every invariant against LIVE state — never trust the stored case. A forged or
      // stale case (skip-level, over-cap, thinned-out track record, drifted dial) is rejected here,
      // so ratification is the only trustworthy widening path regardless of how the case was made.
      const org = this.requireOrg(input.workspace_id, autonomyCase.org_id);
      const proposedLevel = this.assertWidenable(
        org,
        autonomyCase.evidence.length,
        input.workspace_id,
      );
      if (autonomyCase.proposed_level !== proposedLevel) {
        throw new AutonomyStepError(
          `case proposes '${autonomyCase.proposed_level}', but the only valid one-step widening from the live level '${org.autonomy_level}' is '${proposedLevel}'`,
        );
      }

      const at = input.at ?? utcNow();
      // Mark the case ratified FIRST, then widen with that case as proof. The store only widens when
      // a matching ratified case exists, so ratification is the sole widening path — even at the
      // store layer. If the widen fails, the whole transaction (including the ratify) rolls back.
      const ratified = this.cases.setStatus(caseId, "ratified", {
        ratified_by: ratifier,
        resolved_at: at,
      });
      const updatedOrg = this.orgs.setAutonomyLevel(autonomyCase.org_id, {
        workspace_id: input.workspace_id,
        expected_level: org.autonomy_level,
        next_level: proposedLevel,
        ratified_case_id: caseId,
      });
      this.events.append({
        workspace_id: input.workspace_id,
        kind: "autonomy.widened",
        actor: ratifier,
        payload: EventPayloadSchema.parse({
          data: {
            autonomy_case: ratified,
            organization: updatedOrg,
            from: org.autonomy_level,
            to: proposedLevel,
          },
          refs: [ratified.id, ratified.org_id],
        }),
        idempotency_key: `${caseId}:ratified`,
      });
      return ratified;
    });
  }

  /** Reject a proposed widening (human action). Records the rejection; never touches the dial. */
  rejectWidening(
    caseId: string,
    input: { workspace_id: string; actor: string; at?: string | null },
  ): AutonomyCase {
    return this.database.transaction(() => {
      const autonomyCase = this.requireCase(input.workspace_id, caseId);
      if (autonomyCase.status === "rejected") {
        return autonomyCase;
      }
      const rejected = this.cases.setStatus(caseId, "rejected", {
        resolved_at: input.at ?? utcNow(),
      });
      this.events.append({
        workspace_id: input.workspace_id,
        kind: "autonomy.widening_rejected",
        actor: input.actor,
        payload: EventPayloadSchema.parse({
          data: { autonomy_case: rejected },
          refs: [rejected.id, rejected.org_id],
        }),
        idempotency_key: `${caseId}:rejected`,
      });
      return rejected;
    });
  }

  /**
   * Tighten an org's autonomy (operator action). Always allowed without a case or evidence —
   * narrowing is the safe direction. Must lower the level.
   */
  narrow(input: {
    workspace_id: string;
    org_id: string;
    to_level: AutonomyLevel;
    actor: string;
    at?: string | null;
  }): Organization {
    return this.database.transaction(() => {
      const org = this.requireOrg(input.workspace_id, input.org_id);
      if (ladderIndex(input.to_level) >= ladderIndex(org.autonomy_level)) {
        throw new AutonomyStepError(
          `narrow must lower autonomy; '${input.to_level}' is not below '${org.autonomy_level}'`,
        );
      }
      const updated = this.orgs.setAutonomyLevel(input.org_id, {
        workspace_id: input.workspace_id,
        expected_level: org.autonomy_level,
        next_level: input.to_level,
      });
      this.events.append({
        workspace_id: input.workspace_id,
        kind: "autonomy.narrowed",
        actor: input.actor,
        payload: EventPayloadSchema.parse({
          data: { organization: updated, from: org.autonomy_level, to: input.to_level },
          refs: [updated.id],
        }),
        idempotency_key: `autonomy:narrow:${input.org_id}:${input.at ?? utcNow()}`,
      });
      return updated;
    });
  }

  // The audited track record: verified OrgChangeApplication *records* (successful, post-apply-checked
  // applies) in the workspace — NOT raw `org_change.verified` events, which the event log would
  // accept synthetically. Autonomy is earned against these structured apply artifacts. Acknowledged
  // org changes (applier-less recommendations, #105) never create an application row, so they
  // are structurally excluded: a recommendation that changed nothing earns nothing.
  private verifiedApplyCount(workspaceId: string): number {
    return this.applications
      .listForWorkspace(workspaceId)
      .filter((application) => application.status === "verified").length;
  }

  private requireOrg(workspaceId: string, orgId: string): Organization {
    const org = this.orgs.get(orgId);
    if (!org || org.workspace_id !== workspaceId) {
      throw new AutonomyServiceError(
        `organization not found in workspace ${workspaceId}: ${orgId}`,
      );
    }
    return org;
  }

  private requireCase(workspaceId: string, caseId: string): AutonomyCase {
    const autonomyCase = this.cases.get(caseId);
    if (!autonomyCase || autonomyCase.workspace_id !== workspaceId) {
      throw new AutonomyServiceError(
        `autonomy case not found in workspace ${workspaceId}: ${caseId}`,
      );
    }
    return autonomyCase;
  }
}

// Reject blank/whitespace actor identities and normalize for comparison, so proposer/ratifier
// separation cannot be bypassed with an empty or padded string. (Canonical authenticated identities
// from a session are a higher-layer concern; this is the floor.)
function normalizeActor(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new AutonomyRatificationError(`${field} must be a non-empty actor identity`);
  }
  return normalized;
}

function ladderIndex(level: AutonomyLevel): number {
  return LADDER.indexOf(level);
}

function nextWider(level: AutonomyLevel): AutonomyLevel | null {
  const index = ladderIndex(level);
  return index >= 0 && index < LADDER.length - 1 ? (LADDER[index + 1] ?? null) : null;
}
