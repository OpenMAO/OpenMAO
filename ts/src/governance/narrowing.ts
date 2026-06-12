import { createHash } from "node:crypto";

import {
  ApprovalRequestSchema,
  CapabilityCallSchema,
  type Event,
  EventPayloadSchema,
  formatUtc,
  type GrantSuspension,
  GrantSuspensionSchema,
  type NarrowingPolicy,
  NarrowingPolicySchema,
  normalizeInstant,
  PolicyDecisionSchema,
  utcNow,
} from "../contracts/index.js";
import {
  CapabilityCallStore,
  type Database,
  EventStore,
  GrantSuspensionStore,
  NarrowingPolicyStore,
} from "../persistence/index.js";

export class NarrowingError extends Error {}

// The exact reason format the capability gateway emits for a suspended grant. The scan
// recognizes (and excludes) decisions carrying this prefix so that blocks CAUSED by a
// suspension can never become evidence for the next suspension — without this guard the
// gate would feed its own trigger and flap against a human-ratified lift.
const SUSPENDED_GRANT_REASON_PREFIX = "Capability grant is suspended: ";

export function suspendedGrantReason(suspension: GrantSuspension): string {
  return `${SUSPENDED_GRANT_REASON_PREFIX}${suspension.capability_name} (suspension ${suspension.id})`;
}

export type NarrowingScanResult = {
  workspace_id: string;
  policy: NarrowingPolicy | null;
  suspensions: GrantSuspension[];
};

type TriggerKind = GrantSuspension["trigger"];

/**
 * Asymmetric autonomy v1 (#120): evidence-triggered narrowing of a single capability grant
 * for a single actor. Narrowing is deliberately easier than widening:
 *
 *   - `scan` is deterministic over already-recorded events and acts ONLY under an
 *     operator-ratified `NarrowingPolicy` (no policy, no action — there are no silent
 *     defaults). It suspends a grant when the actor's capability calls were rejected N
 *     times, or policy-blocked M times, within the ratified window, and writes a
 *     hash-chained `autonomy.grant_suspended` event carrying the exact evidence refs.
 *   - There is no automatic widening: only `lift` — an explicit human action with an
 *     actor and note — re-opens a grant, and never before the suspension's cooldown
 *     elapses (hysteresis against flapping).
 *
 * Enforcement lives in the capability gateway (`GovernanceService.decideCapability` and the
 * external-worker decision path), which queries the suspension store per decision.
 */
export class NarrowingService {
  private readonly calls: CapabilityCallStore;
  private readonly events: EventStore;
  private readonly policies: NarrowingPolicyStore;
  private readonly suspensions: GrantSuspensionStore;

  constructor(private readonly database: Database) {
    this.calls = new CapabilityCallStore(database);
    this.events = new EventStore(database);
    this.policies = new NarrowingPolicyStore(database);
    this.suspensions = new GrantSuspensionStore(database);
  }

  ratifyPolicy(input: {
    workspace_id: string;
    ratified_by: string;
    rejection_threshold: number;
    violation_threshold: number;
    window_seconds: number;
    cooldown_seconds: number;
    now?: string | null;
  }): NarrowingPolicy {
    if (!input.ratified_by.trim()) {
      throw new NarrowingError("narrowing policy ratification requires a non-blank operator");
    }
    return this.database.transaction(() => {
      const policy = NarrowingPolicySchema.parse({
        workspace_id: input.workspace_id,
        ratified_by: input.ratified_by,
        rejection_threshold: input.rejection_threshold,
        violation_threshold: input.violation_threshold,
        window_seconds: input.window_seconds,
        cooldown_seconds: input.cooldown_seconds,
        ratified_at: normalizeInstant(input.now ?? utcNow()),
      });
      this.policies.save(policy);
      this.events.append({
        workspace_id: policy.workspace_id,
        kind: "autonomy.narrowing_policy_ratified",
        actor: policy.ratified_by,
        payload: EventPayloadSchema.parse({ data: { narrowing_policy: policy } }),
        idempotency_key: `${policy.workspace_id}:narrowing_policy:${stableHash([
          policy.ratified_by,
          String(policy.rejection_threshold),
          String(policy.violation_threshold),
          String(policy.window_seconds),
          String(policy.cooldown_seconds),
          policy.ratified_at,
        ])}`,
      });
      return policy;
    });
  }

  /**
   * Deterministic, idempotent narrowing scan. Replaying a scan over the same events creates
   * nothing new: suspension ids derive from the windowed evidence, an active suspension for
   * an actor+capability is never duplicated, and evidence a human already adjudicated (a
   * lifted suspension's exact id) never re-suspends — only NEW evidence can.
   */
  scan(input: { workspace_id: string; now?: string | null }): NarrowingScanResult {
    return this.database.transaction(() => {
      const policy = this.policies.get(input.workspace_id);
      if (!policy) {
        // No ratified policy means narrowing was never enabled for this workspace: do nothing.
        return { workspace_id: input.workspace_id, policy: null, suspensions: [] };
      }
      const now = normalizeInstant(input.now ?? utcNow());
      const windowStart = formatUtc(Date.parse(now) - policy.window_seconds * 1000);
      const rejections = new Map<string, string[]>();
      const violations = new Map<string, string[]>();
      for (const event of this.events.listForWorkspace(input.workspace_id)) {
        // Normalize the event timestamp the same way the window bounds are (#120,
        // defense-in-depth): comparing two values normalized through the same helper keeps a
        // sub-second or alternate-offset timestamp from sorting wrongly against the bounds.
        // Not currently triggerable — every writer stamps second-precision utcNow.
        const eventInstant = normalizeInstant(event.timestamp);
        if (eventInstant < windowStart || eventInstant > now) {
          continue;
        }
        const rejected = this.rejectedCapabilityTarget(event);
        if (rejected) {
          appendEvidence(rejections, rejected.actor_id, rejected.capability_name, event.id);
          continue;
        }
        const violated = this.policyViolationTarget(event);
        if (violated) {
          appendEvidence(violations, violated.actor_id, violated.capability_name, event.id);
        }
      }

      const created: GrantSuspension[] = [];
      const evaluations: Array<{
        trigger: TriggerKind;
        threshold: number;
        evidenceByTarget: Map<string, string[]>;
      }> = [
        {
          trigger: "repeated_rejections",
          threshold: policy.rejection_threshold,
          evidenceByTarget: rejections,
        },
        {
          trigger: "policy_violations",
          threshold: policy.violation_threshold,
          evidenceByTarget: violations,
        },
      ];
      for (const evaluation of evaluations) {
        const targets = [...evaluation.evidenceByTarget.entries()].sort(([a], [b]) =>
          a < b ? -1 : a > b ? 1 : 0,
        );
        for (const [target, windowedEvidence] of targets) {
          const { actor_id, capability_name } = decodeTarget(target);
          // Drop evidence a human already adjudicated (#120, anti-flap): any event id carried by
          // a LIFTED suspension for this exact (actor, capability) is excluded before the
          // threshold test. Without this the lifted suspension's own evidence still sits inside
          // the window, so a single fresh failure would re-suspend at an effective threshold of
          // one and defeat the lift. Only a fresh full N of non-adjudicated evidence re-suspends.
          const adjudicated = this.adjudicatedEvidence(
            input.workspace_id,
            actor_id,
            capability_name,
          );
          const evidence =
            adjudicated.size === 0
              ? windowedEvidence
              : windowedEvidence.filter((eventId) => !adjudicated.has(eventId));
          if (evidence.length < evaluation.threshold) {
            continue;
          }
          const suspension = this.suspend({
            workspace_id: input.workspace_id,
            actor_id,
            capability_name,
            trigger: evaluation.trigger,
            threshold: evaluation.threshold,
            evidence,
            policy,
            now,
          });
          if (suspension) {
            created.push(suspension);
          }
        }
      }
      return { workspace_id: input.workspace_id, policy, suspensions: created };
    });
  }

  lift(
    suspensionId: string,
    input: { actor: string; note: string; now?: string | null },
  ): GrantSuspension {
    if (!input.actor.trim()) {
      throw new NarrowingError("lifting a grant suspension requires a non-blank operator actor");
    }
    return this.database.transaction(() => {
      const current = this.suspensions.get(suspensionId);
      if (!current) {
        throw new NarrowingError(`grant suspension not found: ${suspensionId}`);
      }
      if (current.status === "lifted") {
        return current;
      }
      const now = normalizeInstant(input.now ?? utcNow());
      if (now < current.cooldown_until) {
        throw new NarrowingError(
          `grant suspension cooldown has not elapsed (until ${current.cooldown_until}): ${suspensionId}`,
        );
      }
      const lifted = this.suspensions.lift(suspensionId, {
        lifted_by: input.actor,
        lift_note: input.note,
        lifted_at: now,
      });
      this.events.append({
        workspace_id: lifted.workspace_id,
        kind: "autonomy.grant_lifted",
        actor: input.actor,
        payload: EventPayloadSchema.parse({
          data: { grant_suspension: lifted },
          refs: [lifted.id],
        }),
        idempotency_key: `${lifted.id}:lifted`,
      });
      return lifted;
    });
  }

  list(workspaceId: string): GrantSuspension[] {
    return this.suspensions.listForWorkspace(workspaceId);
  }

  private suspend(input: {
    workspace_id: string;
    actor_id: string;
    capability_name: string;
    trigger: TriggerKind;
    threshold: number;
    evidence: string[];
    policy: NarrowingPolicy;
    now: string;
  }): GrantSuspension | null {
    if (this.suspensions.findActive(input.workspace_id, input.actor_id, input.capability_name)) {
      return null;
    }
    const id = `suspension_${stableHash([
      input.workspace_id,
      input.actor_id,
      input.capability_name,
      input.trigger,
      ...input.evidence,
    ])}`;
    if (this.suspensions.get(id)) {
      // This exact windowed evidence was already adjudicated (and lifted by a human):
      // re-suspending would flap against that ratified decision. New evidence yields a new id.
      return null;
    }
    const describedTrigger =
      input.trigger === "repeated_rejections"
        ? `capability calls were rejected ${input.evidence.length} time(s)`
        : `capability calls were policy-blocked ${input.evidence.length} time(s)`;
    const suspension = GrantSuspensionSchema.parse({
      id,
      workspace_id: input.workspace_id,
      actor_id: input.actor_id,
      capability_name: input.capability_name,
      status: "active",
      trigger: input.trigger,
      evidence_refs: input.evidence,
      reason: `Suspended grant ${input.capability_name} for ${input.actor_id}: ${describedTrigger} within ${input.policy.window_seconds}s (threshold ${input.threshold}).`,
      created_at: input.now,
      cooldown_until: formatUtc(Date.parse(input.now) + input.policy.cooldown_seconds * 1000),
    });
    this.suspensions.save(suspension);
    this.events.append({
      workspace_id: suspension.workspace_id,
      kind: "autonomy.grant_suspended",
      actor: "narrowing_service",
      payload: EventPayloadSchema.parse({
        data: { grant_suspension: suspension },
        refs: suspension.evidence_refs,
      }),
      idempotency_key: `${suspension.id}:suspended`,
    });
    return suspension;
  }

  // Trigger 1: an `approval.rejected` event whose approval targets a capability call. The
  // approval payload embeds the call the registry gated, so the (actor, capability) pair is
  // read straight from the recorded evidence.
  private rejectedCapabilityTarget(
    event: Event,
  ): { actor_id: string; capability_name: string } | null {
    if (event.kind !== "approval.rejected") {
      return null;
    }
    const approvalResult = ApprovalRequestSchema.safeParse(event.payload.data.approval_request);
    if (!approvalResult.success) {
      return null;
    }
    const approval = approvalResult.data;
    if (approval.payload.target_type !== "capability_call") {
      return null;
    }
    const callResult = CapabilityCallSchema.safeParse(approval.payload.data.capability_call);
    if (!callResult.success) {
      return null;
    }
    return {
      actor_id: callResult.data.requested_by,
      capability_name: callResult.data.capability_name,
    };
  }

  // Trigger 2: a `policy.decision` event with outcome "block" for a capability call. The
  // decision references the persisted call, which carries the requesting actor and the
  // capability name. Blocks emitted BY the suspension gate are excluded so a suspension's
  // own enforcement can never count as fresh evidence.
  private policyViolationTarget(
    event: Event,
  ): { actor_id: string; capability_name: string } | null {
    if (event.kind !== "policy.decision") {
      return null;
    }
    const decisionResult = PolicyDecisionSchema.safeParse(event.payload.data.policy_decision);
    if (!decisionResult.success) {
      return null;
    }
    const decision = decisionResult.data;
    if (
      decision.outcome !== "block" ||
      decision.action !== "capability.call" ||
      decision.target_type !== "capability_call" ||
      !decision.target_id ||
      decision.reason.startsWith(SUSPENDED_GRANT_REASON_PREFIX)
    ) {
      return null;
    }
    const call = this.calls.get(decision.target_id);
    if (!call || call.workspace_id !== decision.workspace_id) {
      return null;
    }
    return { actor_id: call.requested_by, capability_name: call.capability_name };
  }

  // The set of evidence event ids a human has already adjudicated for an (actor, capability):
  // the union of `evidence_refs` across every LIFTED suspension for that grant. The scan
  // subtracts these from a candidate evidence set so a ratified lift cannot be undone by a
  // single new failure landing while the lifted suspension's evidence is still in-window.
  private adjudicatedEvidence(
    workspaceId: string,
    actorId: string,
    capabilityName: string,
  ): Set<string> {
    const adjudicated = new Set<string>();
    for (const lifted of this.suspensions.listLifted(workspaceId, actorId, capabilityName)) {
      for (const eventId of lifted.evidence_refs) {
        adjudicated.add(eventId);
      }
    }
    return adjudicated;
  }
}

function appendEvidence(
  evidenceByTarget: Map<string, string[]>,
  actorId: string,
  capabilityName: string,
  eventId: string,
): void {
  const target = encodeTarget(actorId, capabilityName);
  const evidence = evidenceByTarget.get(target) ?? [];
  evidence.push(eventId);
  evidenceByTarget.set(target, evidence);
}

// Unambiguous (actor, capability) composite key; JSON encoding avoids delimiter collisions.
function encodeTarget(actorId: string, capabilityName: string): string {
  return JSON.stringify([actorId, capabilityName]);
}

function decodeTarget(target: string): { actor_id: string; capability_name: string } {
  const [actor_id, capability_name] = JSON.parse(target) as [string, string];
  return { actor_id, capability_name };
}

function stableHash(parts: string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);
}
