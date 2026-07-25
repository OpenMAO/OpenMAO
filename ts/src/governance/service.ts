import { createHash } from "node:crypto";

import {
  type Capability,
  type CapabilityCall,
  CapabilityCallSchema,
  CapabilitySchema,
  EventPayloadSchema,
  newId,
  type Organization,
  type PolicyDecision,
  PolicyDecisionSchema,
  type PolicyOutcome,
} from "../contracts/index.js";
import type { OrgRegistry } from "../org/index.js";
import type { Database } from "../persistence/index.js";
import {
  EventStore,
  GrantSuspensionStore,
  OrganizationStore,
  WorkspaceStore,
} from "../persistence/index.js";
import { suspendedGrantReason } from "./narrowing.js";

type AutonomyLevel = Organization["autonomy_level"];

// The autonomy dial: how much an organization may act without a human in the loop.
// Returns a short reason if a granted, enabled call needs approval at this level, or
// null if it may proceed. `default_permission: "approval_required"` and high risk always
// gate; below that each level sets the threshold, monotonically (advisory ⊇ supervised
// ⊇ bounded in what it gates).
function approvalTrigger(
  call: CapabilityCall,
  capability: Capability,
  autonomyLevel: AutonomyLevel,
): string | null {
  if (capability.default_permission === "approval_required") {
    return "Approval-required capability call";
  }
  // Risk and side-effecting are server-authoritative: the capability's declared values
  // are the floor, so a caller (e.g. an external worker) cannot under-report to dodge the
  // dial. A call may raise the effective risk, never lower it below the declaration.
  const effectiveRisk = maxRisk(capability.risk_level, call.risk_level);
  const sideEffecting = capability.side_effecting || call.side_effecting;
  if (effectiveRisk === "high") {
    return "High-risk capability call";
  }
  if (autonomyLevel === "bounded") {
    // Trusted to act within limits: only high-risk (handled above) needs a human.
    return null;
  }
  if (sideEffecting) {
    // supervised and advisory: approve each consequential (side-effecting) action.
    return "Side-effecting capability call";
  }
  if (autonomyLevel === "advisory" && effectiveRisk !== "low") {
    // advisory has earned nothing: even non-low-risk reads need a human.
    return "Non-low-risk capability call";
  }
  return null;
}

const AUTONOMY_STRICTNESS: Record<AutonomyLevel, number> = {
  advisory: 0,
  supervised: 1,
  bounded: 2,
};

// Most restrictive of the given levels — used to fail closed when a workspace is
// ambiguous about which organization's dial applies.
function tightestAutonomy(levels: AutonomyLevel[]): AutonomyLevel {
  return levels.reduce((tightest, level) =>
    AUTONOMY_STRICTNESS[level] < AUTONOMY_STRICTNESS[tightest] ? level : tightest,
  );
}

const RISK_ORDER: Record<"low" | "medium" | "high", number> = { low: 0, medium: 1, high: 2 };

// Higher of two risk levels — used to take the capability's declared risk as a floor.
function maxRisk(
  a: "low" | "medium" | "high",
  b: "low" | "medium" | "high",
): "low" | "medium" | "high" {
  return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b;
}

export class GovernanceService {
  private readonly events: EventStore;
  private readonly suspensions: GrantSuspensionStore;

  constructor(
    private readonly database: Database,
    private readonly orgRegistry: OrgRegistry,
  ) {
    this.events = new EventStore(database);
    this.suspensions = new GrantSuspensionStore(database);
  }

  decideHandoff(input: {
    workspace_id: string;
    from_agent_id: string;
    to_agent_id: string;
    run_id?: string | null;
  }): PolicyDecision {
    const allowed = this.orgRegistry.canHandoff(input.from_agent_id, input.to_agent_id);
    return PolicyDecisionSchema.parse({
      id: newId("decision"),
      workspace_id: input.workspace_id,
      run_id: input.run_id ?? null,
      action: "handoff",
      target_type: "agent",
      target_id: input.to_agent_id,
      outcome: allowed ? "allow" : "block",
      reason: allowed
        ? "Org communication graph allows this handoff."
        : "Org communication graph does not allow this handoff.",
    });
  }

  decideCapability(callInput: CapabilityCall, capabilityInput: Capability): PolicyDecision {
    const call = CapabilityCallSchema.parse(callInput);
    const capability = CapabilitySchema.parse(capabilityInput);
    const grants = this.orgRegistry.allowedCapabilitiesForAgent(call.requested_by);
    let outcome: PolicyOutcome;
    let reason: string;

    if (capability.default_permission === "disabled") {
      outcome = "block";
      reason = `Capability is disabled: ${call.capability_name}.`;
    } else if (!grants.has(call.capability_name)) {
      outcome = "block";
      reason = `Agent role lacks capability grant: ${call.capability_name}.`;
    } else {
      // Narrowing gate (#120): right after the grant check, before any approval logic.
      const suspensionReason = this.suspendedGrantBlockReason(call);
      if (suspensionReason) {
        outcome = "block";
        reason = suspensionReason;
      } else {
        ({ outcome, reason } = this.capabilityApprovalDecision(call, capability));
      }
    }

    return PolicyDecisionSchema.parse({
      id: newId("decision"),
      workspace_id: call.workspace_id,
      run_id: call.run_id,
      action: "capability.call",
      target_type: "capability_call",
      target_id: call.id,
      outcome,
      reason,
    });
  }

  // Narrowing gate (#120): block reason when the (workspace, actor, capability) grant is
  // under an active suspension, else null. This is THE call-time read of the suspension
  // store — a fresh indexed SQLite probe on every capability decision, shared by the
  // role-grant path (decideCapability above) and the external-worker path (the registry's
  // worker decision), so neither surface can serve a stale or bind-time-cached view.
  suspendedGrantBlockReason(call: CapabilityCall): string | null {
    const suspension = this.suspensions.findActive(
      call.workspace_id,
      call.requested_by,
      call.capability_name,
    );
    return suspension ? suspendedGrantReason(suspension) : null;
  }

  // The organization's current autonomy level for a workspace. Binds policy to the
  // workspace's designated default organization; with none recorded, or an ambiguous
  // multi-org workspace with no resolvable default, it fails closed to the tightest
  // level (the charter's posture for new or unproven organizations).
  autonomyLevel(workspaceId: string): AutonomyLevel {
    const orgs = new OrganizationStore(this.database).listForWorkspace(workspaceId);
    if (orgs.length === 0) {
      return "advisory";
    }
    if (orgs.length === 1) {
      return orgs[0]?.autonomy_level ?? "advisory";
    }
    const defaultOrgId = new WorkspaceStore(this.database).get(workspaceId)?.default_org_id;
    const chosen = defaultOrgId ? orgs.find((org) => org.id === defaultOrgId) : undefined;
    return chosen ? chosen.autonomy_level : tightestAutonomy(orgs.map((org) => org.autonomy_level));
  }

  // Single source of truth for the dial-based approval decision (outcome + reason),
  // shared by the spine path and the external-worker gateway so both enforcement
  // surfaces record the same policy basis. Risk and side-effecting are taken from the
  // capability's declared values as a floor (see approvalTrigger), so a caller cannot
  // under-report. Payload-level "out-of-bounds"/scope modeling remains a follow-up.
  capabilityApprovalDecision(
    call: CapabilityCall,
    capability: Capability,
  ): { outcome: "allow" | "require_approval"; reason: string } {
    const autonomyLevel = this.autonomyLevel(call.workspace_id);
    const trigger = approvalTrigger(call, capability, autonomyLevel);
    if (trigger) {
      return {
        outcome: "require_approval",
        reason: `${trigger} requires approval at autonomy level '${autonomyLevel}' before execution: ${call.capability_name}.`,
      };
    }
    return {
      outcome: "allow",
      reason: `Capability is enabled and granted at autonomy level '${autonomyLevel}': ${call.capability_name}.`,
    };
  }

  recordDecision(decision: PolicyDecision, idempotencyKey?: string | null): PolicyDecision {
    const parsed = PolicyDecisionSchema.parse(decision);
    this.events.append({
      workspace_id: parsed.workspace_id,
      run_id: parsed.run_id,
      kind: "policy.decision",
      actor: "governance",
      payload: EventPayloadSchema.parse({ data: { policy_decision: parsed } }),
      idempotency_key: idempotencyKey ?? null,
    });
    return parsed;
  }

  getRecordedDecision(input: {
    workspace_id: string;
    idempotency_key: string;
  }): PolicyDecision | null {
    const event = this.events.getByIdempotencyKey(input.workspace_id, input.idempotency_key);
    if (!event) {
      return null;
    }
    if (event.kind !== "policy.decision") {
      throw new Error(
        `idempotency key does not reference a policy decision: ${input.idempotency_key}`,
      );
    }
    const payload = event.payload.data.policy_decision;
    return PolicyDecisionSchema.parse(payload);
  }

  checkHandoff(input: {
    workspace_id: string;
    from_agent_id: string;
    to_agent_id: string;
    run_id?: string | null;
  }): PolicyDecision {
    const idempotencyKey = this.handoffDecisionKey(input);
    const recorded = this.getRecordedDecision({
      workspace_id: input.workspace_id,
      idempotency_key: idempotencyKey,
    });
    if (recorded) {
      return recorded;
    }

    const decision = PolicyDecisionSchema.parse({
      ...this.decideHandoff(input),
      id: this.decisionIdForKey(idempotencyKey),
    });
    return this.recordDecision(decision, idempotencyKey);
  }

  private handoffDecisionKey(input: {
    run_id?: string | null;
    from_agent_id: string;
    to_agent_id: string;
  }): string {
    return `handoff:${input.run_id ?? "workspace"}:${input.from_agent_id}:${input.to_agent_id}`;
  }

  decisionIdForKey(key: string): string {
    return `decision_${createHash("sha256").update(key).digest("hex").slice(0, 32)}`;
  }

  get databaseForTesting(): Database {
    return this.database;
  }
}
