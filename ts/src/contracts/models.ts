import { z } from "zod";

import { ID_PATTERN, UTC_TIMESTAMP_PATTERN } from "./ids.js";

const recordSchema = z.record(z.string(), z.unknown());

export const CanonicalIdSchema = z.string().regex(new RegExp(ID_PATTERN));
export const UtcTimestampSchema = z.string().regex(new RegExp(UTC_TIMESTAMP_PATTERN));
export const PolicyOutcomeSchema = z.enum(["allow", "block", "require_approval", "log_only"]);
export const RunStatusSchema = z.enum([
  "queued",
  "running",
  "suspended_approval",
  "completed",
  "failed",
]);

export const ExternalSourceSchema = z
  .object({
    provider: z.string().default("openmao"),
    external_id: z.string().nullable().default(null),
    external_url: z.string().nullable().default(null),
  })
  .strict();

export const ExternalActorRefSchema = z
  .object({
    actor_type: z.enum(["agent", "worker", "operator", "system", "provider"]),
    actor_id: z.string(),
    display_name: z.string().nullable().default(null),
  })
  .strict();

export const MemoryScopeSchema = z
  .object({
    read: z.array(z.string()).default([]),
    write: z.array(z.string()).default([]),
  })
  .strict();

export const ProvenanceSchema = z
  .object({
    agent_id: CanonicalIdSchema.nullable().default(null),
    role_id: CanonicalIdSchema.nullable().default(null),
    task_id: CanonicalIdSchema.nullable().default(null),
    run_id: CanonicalIdSchema.nullable().default(null),
    source_event_id: CanonicalIdSchema.nullable().default(null),
    note: z.string().nullable().default(null),
  })
  .strict();

export const CostSchema = z
  .object({
    tokens_in: z.number().int().default(0),
    tokens_out: z.number().int().default(0),
    usd: z.number().default(0),
    provider: z.string().nullable().default(null),
    model: z.string().nullable().default(null),
  })
  .strict();

export const ArtifactRefSchema = z
  .object({
    artifact_id: CanonicalIdSchema,
    content_ref: z.string().nullable().default(null),
  })
  .strict();

export const ApprovalPayloadSchema = z
  .object({
    target_type: z.string(),
    target_id: CanonicalIdSchema,
    reason: z.string(),
    data: recordSchema.default({}),
  })
  .strict();

export const EventPayloadSchema = z
  .object({
    data: recordSchema.default({}),
    refs: z.array(CanonicalIdSchema).default([]),
    // M0 causal instrumentation (all optional, default-safe). These let the M3 causal
    // graph build its three edge types directly from the event log:
    //   - sequential:      group by actor_ref.actor_id, order by seq
    //   - communication:   causal_parent_id links a receiver's action to the handoff/
    //                      message event from another actor
    //   - data-dependency: producer's produced_refs ∩ consumer's consumed_refs
    actor_ref: ExternalActorRefSchema.nullable().default(null),
    produced_refs: z.array(z.string()).default([]),
    consumed_refs: z.array(z.string()).default([]),
    causal_parent_id: CanonicalIdSchema.nullable().default(null),
  })
  .strict();

export const WorkspaceSchema = z
  .object({
    id: CanonicalIdSchema,
    name: z.string(),
    created_at: UtcTimestampSchema,
    default_org_id: CanonicalIdSchema.nullable().default(null),
  })
  .strict();

export const OrganizationSchema = z
  .object({
    id: CanonicalIdSchema,
    workspace_id: CanonicalIdSchema,
    name: z.string(),
    type: z.string().default("custom"),
    mission: z.string(),
    vision: z.string().nullable().default(null),
    values: z.array(z.string()).default([]),
    goals: z.array(z.string()).default([]),
    policies: z.array(z.string()).default([]),
    // New/unproven organizations start at the tightest level and earn wider autonomy.
    // The local demo opts into `supervised` explicitly; everything else starts advisory.
    autonomy_level: z.enum(["advisory", "supervised", "bounded"]).default("advisory"),
    config_version: z.string().default("0.1"),
  })
  .strict();

export const RoleSchema = z
  .object({
    id: CanonicalIdSchema,
    workspace_id: CanonicalIdSchema,
    name: z.string(),
    purpose: z.string(),
    responsibilities: z.array(z.string()).default([]),
    permissions: z.array(z.string()).default([]),
    capability_grants: z.array(z.string()).default([]),
    reports_to: CanonicalIdSchema.nullable().default(null),
    kpis: z.array(z.string()).default([]),
  })
  .strict();

export const AgentSchema = z
  .object({
    id: CanonicalIdSchema,
    workspace_id: CanonicalIdSchema,
    role_id: CanonicalIdSchema,
    identity: z.string(),
    memory_scope: MemoryScopeSchema.default({ read: [], write: [] }),
    model_binding: z.string().default("mock"),
    status: z.enum(["idle", "running", "blocked", "disabled"]).default("idle"),
  })
  .strict();

/** @deprecated Reserved; not wired into the runtime (`ToolStore` is exercised only by tests) — staged for removal pending founder ratification (#108). */
export const ToolSchema = z
  .object({
    name: z.string(),
    workspace_id: CanonicalIdSchema,
    kind: z.enum([
      "mock",
      "github",
      "email",
      "slack",
      "mcp",
      "http_api",
      "database",
      "browser",
      "shell",
      "filesystem",
      "internal_api",
      "other",
    ]),
    description: z.string(),
    provider: z.string(),
    allowed_scopes: z.array(z.string()).default([]),
    credential_policy: z.enum(["none", "handle_required", "external"]).default("none"),
    status: z.enum(["enabled", "disabled"]).default("enabled"),
  })
  .strict();

export const WorkerIdentitySchema = z
  .object({
    id: CanonicalIdSchema,
    workspace_id: CanonicalIdSchema,
    name: z.string(),
    runtime: z.string(),
    version: z.string().nullable().default(null),
    source: ExternalSourceSchema.default({
      provider: "openmao",
      external_id: null,
      external_url: null,
    }),
    role_id: CanonicalIdSchema.nullable().default(null),
    allowed_capabilities: z.array(z.string()).default([]),
    metadata: recordSchema.default({}),
    status: z.enum(["enabled", "disabled"]).default("enabled"),
  })
  .strict();

export const GoalSchema = z
  .object({
    id: CanonicalIdSchema,
    workspace_id: CanonicalIdSchema,
    objective: z.string(),
    owner_role: CanonicalIdSchema.nullable().default(null),
    success_metrics: z.array(z.string()).default([]),
    deadline: z.string().nullable().default(null),
    constraints: z.array(z.string()).default([]),
    status: z.enum(["proposed", "active", "blocked", "done", "cancelled"]).default("proposed"),
  })
  .strict();

export const WorkItemSchema = z
  .object({
    id: CanonicalIdSchema,
    workspace_id: CanonicalIdSchema,
    title: z.string(),
    objective: z.string(),
    owner: z.string(),
    reviewer: z.string().nullable().default(null),
    status: z
      .enum(["queued", "in_progress", "blocked", "review", "done", "failed"])
      .default("queued"),
    priority: z.enum(["low", "medium", "high", "urgent"]).default("medium"),
    success_criteria: z.array(z.string()).default([]),
    risk_level: z.enum(["low", "medium", "high"]).default("low"),
    approval_gates: z.array(z.string()).default([]),
    source: ExternalSourceSchema.default({
      provider: "openmao",
      external_id: null,
      external_url: null,
    }),
    memory_scope: MemoryScopeSchema.default({ read: [], write: [] }),
    evaluation: z.array(CanonicalIdSchema).default([]),
  })
  .strict();

export const RunSchema = z
  .object({
    id: CanonicalIdSchema,
    workspace_id: CanonicalIdSchema,
    status: RunStatusSchema.default("queued"),
    active_node: z.string().nullable().default(null),
    suspended_approval_id: CanonicalIdSchema.nullable().default(null),
    created_at: UtcTimestampSchema,
    updated_at: UtcTimestampSchema,
  })
  .strict();

// Per-capability resource scope for a bounded envelope: capability_name -> resource field -> the
// exact set of allowed values. A capability that declares `resource_fields` may only act on a
// resource whose value for each field is listed here, so granting `github.create_issue_comment`
// no longer means "any repo" — it means exactly the repos the envelope pinned.
export const ResourceGrantsSchema = z.record(z.string(), z.record(z.string(), z.array(z.string())));
export type ResourceGrants = z.infer<typeof ResourceGrantsSchema>;

export const TaskEnvelopeSchema = z
  .object({
    id: CanonicalIdSchema,
    workspace_id: CanonicalIdSchema,
    run_id: CanonicalIdSchema,
    work_item_id: CanonicalIdSchema,
    from_agent: CanonicalIdSchema.nullable().default(null),
    to_agent: CanonicalIdSchema,
    objective: z.string(),
    context_refs: z.array(z.string()).default([]),
    allowed_capabilities: z.array(z.string()).default([]),
    approval_gates: z.array(z.string()).default([]),
    resource_grants: ResourceGrantsSchema.default({}),
  })
  .strict();

export const BoundedWorkEnvelopeSchema = z
  .object({
    id: CanonicalIdSchema,
    workspace_id: CanonicalIdSchema,
    work_item_id: CanonicalIdSchema,
    run_id: CanonicalIdSchema.nullable().default(null),
    task_envelope_id: CanonicalIdSchema.nullable().default(null),
    worker_id: CanonicalIdSchema,
    issued_by: ExternalActorRefSchema,
    objective: z.string(),
    context_refs: z.array(z.string()).default([]),
    allowed_capabilities: z.array(z.string()).default([]),
    approval_gates: z.array(z.string()).default([]),
    resource_grants: ResourceGrantsSchema.default({}),
    input: recordSchema.default({}),
    created_at: UtcTimestampSchema,
    expires_at: UtcTimestampSchema.nullable().default(null),
  })
  .strict();

/** @deprecated Superseded by `WorkerOutcomeSchema`; no runtime usage — staged for removal pending founder ratification (#108). */
export const AgentOutcomeSchema = z
  .object({
    task_id: CanonicalIdSchema,
    status: z.enum(["completed", "blocked", "failed"]),
    summary: z.string(),
    artifacts: z.array(ArtifactRefSchema).default([]),
    memory_writes: z.array(CanonicalIdSchema).default([]),
    promotion_candidates: z.array(CanonicalIdSchema).default([]),
    cost: CostSchema.default({
      tokens_in: 0,
      tokens_out: 0,
      usd: 0,
      provider: null,
      model: null,
    }),
    trace_ref: CanonicalIdSchema,
  })
  .strict();

export const WorkerOutcomeSchema = z
  .object({
    id: CanonicalIdSchema,
    workspace_id: CanonicalIdSchema,
    work_item_id: CanonicalIdSchema,
    envelope_id: CanonicalIdSchema,
    worker_id: CanonicalIdSchema,
    status: z.enum(["completed", "blocked", "failed"]),
    summary: z.string(),
    artifacts: z.array(ArtifactRefSchema).default([]),
    memory_writes: z.array(CanonicalIdSchema).default([]),
    promotion_candidates: z.array(CanonicalIdSchema).default([]),
    output: recordSchema.default({}),
    idempotency_key: z.string(),
    submitted_at: UtcTimestampSchema,
  })
  .strict();

export const CapabilitySchema = z
  .object({
    name: z.string(),
    workspace_id: CanonicalIdSchema,
    description: z.string(),
    tool_name: z.string().nullable().default(null),
    canonical_input_schema: recordSchema,
    canonical_output_schema: recordSchema,
    providers: z.array(z.string()).default([]),
    side_effecting: z.boolean().default(false),
    // Authoritative baseline risk of the capability. The governance dial takes the
    // higher of this and the call's declared risk, so a caller cannot under-report.
    risk_level: z.enum(["low", "medium", "high"]).default("low"),
    credential_handle_required: z.boolean().default(false),
    // Constrained to a cred_* shape with a field-level regex so the constraint
    // is emitted into the portable canonical JSON Schema (a .refine() would be
    // runtime-only and diverge from the published schema). The persistence layer
    // additionally screens for secret-shaped material.
    credential_handle: z
      .string()
      .regex(/^cred_[A-Za-z0-9_.:-]+$/, "credential_handle must be a cred_* handle")
      .nullable()
      .default(null),
    default_permission: z
      .enum(["enabled", "approval_required", "disabled"])
      .default("approval_required"),
    // Input fields that name the RESOURCE a side effect acts on (e.g. ["owner", "repo"] for a
    // GitHub comment). When non-empty, every call must carry an envelope resource grant for each
    // field — a granted capability can no longer act on an arbitrary resource (default-deny).
    resource_fields: z.array(z.string()).default([]),
  })
  .strict();

export const CapabilityProviderRefSchema = z
  .object({
    provider: z.string(),
    tool_name: z.string(),
    capability_name: z.string(),
    credential_handle: z.string().nullable().default(null),
    side_effecting: z.boolean().default(false),
    risk_level: z.enum(["low", "medium", "high"]).default("low"),
    audit_payload_schema: recordSchema.default({}),
  })
  .strict();

export const CapabilityCallSchema = z
  .object({
    id: CanonicalIdSchema,
    workspace_id: CanonicalIdSchema,
    run_id: CanonicalIdSchema,
    capability_name: z.string(),
    provider: z.string(),
    input: recordSchema,
    requested_by: z.string(),
    external_actor: ExternalActorRefSchema.nullable().default(null),
    task_id: CanonicalIdSchema,
    credential_handle: z
      .string()
      .regex(/^cred_[A-Za-z0-9_.:-]+$/, "credential_handle must be a cred_* handle")
      .nullable()
      .default(null),
    side_effecting: z.boolean().default(false),
    audit_payload: recordSchema.default({}),
    risk_level: z.enum(["low", "medium", "high"]).default("low"),
    idempotency_key: z.string(),
  })
  .strict();

export const CapabilityResultSchema = z
  .object({
    id: CanonicalIdSchema,
    workspace_id: CanonicalIdSchema,
    run_id: CanonicalIdSchema,
    call_id: CanonicalIdSchema,
    node_effect_id: CanonicalIdSchema.nullable().default(null),
    status: z.enum(["ok", "blocked", "failed"]),
    output: recordSchema.default({}),
    artifacts: z.array(ArtifactRefSchema).default([]),
    error: z.string().nullable().default(null),
  })
  .strict();

export const MemoryEntrySchema = z
  .object({
    id: CanonicalIdSchema,
    workspace_id: CanonicalIdSchema,
    scope: z.enum(["individual", "collective"]),
    owner_id: CanonicalIdSchema.nullable().default(null),
    kind: z.enum(["episodic", "procedural", "semantic", "decision"]),
    content: z.string(),
    provenance: ProvenanceSchema,
    confidence: z.number().default(0.5),
    status: z.enum(["provisional", "confirmed", "rejected", "stale"]).default("provisional"),
    created_at: UtcTimestampSchema,
  })
  .strict();

export const PromotionCandidateSchema = z
  .object({
    id: CanonicalIdSchema,
    workspace_id: CanonicalIdSchema,
    source_memory_entry: CanonicalIdSchema,
    proposed_by: z.string(),
    proposed_content: z.string(),
    rationale: z.string(),
    corroboration_count: z.number().int().default(0),
    status: z.enum(["pending", "ratified", "rejected"]).default("pending"),
    created_at: UtcTimestampSchema,
    resolved_at: UtcTimestampSchema.nullable().default(null),
  })
  .strict();

export const CorroborationSchema = z
  .object({
    id: CanonicalIdSchema,
    workspace_id: CanonicalIdSchema,
    candidate_id: CanonicalIdSchema,
    source_memory_entry: CanonicalIdSchema,
    corroborated_by: z.string(),
    // Reserved for future confidence weighting; recorded but not yet used in scoring.
    strength: z.number().min(0).max(1).default(1),
    note: z.string().nullable().default(null),
    created_at: UtcTimestampSchema,
  })
  .strict();

export const ArtifactSchema = z
  .object({
    id: CanonicalIdSchema,
    workspace_id: CanonicalIdSchema,
    type: z.string(),
    content_ref: z.string(),
    produced_by: z.string(),
    task_id: CanonicalIdSchema,
    created_at: UtcTimestampSchema,
    content_hash: z.string().nullable().default(null),
  })
  .strict();

/** @deprecated Reserved; the `policies` table is never read or written by the runtime — staged for removal pending founder ratification (#108). */
export const PolicySchema = z
  .object({
    id: CanonicalIdSchema,
    workspace_id: CanonicalIdSchema,
    rule: z.string(),
    applies_to: z.array(z.string()).default([]),
    risk_class: z.enum(["low", "medium", "high"]),
    enforcement: PolicyOutcomeSchema,
  })
  .strict();

export const PolicyDecisionSchema = z
  .object({
    id: CanonicalIdSchema,
    workspace_id: CanonicalIdSchema,
    run_id: CanonicalIdSchema.nullable().default(null),
    action: z.string(),
    target_type: z.string().nullable().default(null),
    target_id: CanonicalIdSchema.nullable().default(null),
    outcome: PolicyOutcomeSchema,
    reason: z.string(),
    approval_id: CanonicalIdSchema.nullable().default(null),
    source: z.enum(["structural", "manual", "future_rule_engine"]).default("structural"),
  })
  .strict();

export const ApprovalRequestSchema = z
  .object({
    id: CanonicalIdSchema,
    workspace_id: CanonicalIdSchema,
    run_id: CanonicalIdSchema.nullable().default(null),
    action: z.string(),
    requested_by: z.string(),
    payload: ApprovalPayloadSchema,
    status: z.enum(["pending", "approved", "rejected"]).default("pending"),
    on_approve: z.enum(["resume_run", "apply_without_run"]).default("resume_run"),
    on_reject: z.enum(["fail_run", "skip_action", "no_op"]).default("fail_run"),
    created_at: UtcTimestampSchema,
    resolved_at: UtcTimestampSchema.nullable().default(null),
  })
  .strict();

/** @deprecated Reserved; no usage outside the contracts — staged for removal pending founder ratification (#108). */
export const EvaluationSchema = z
  .object({
    id: CanonicalIdSchema,
    workspace_id: CanonicalIdSchema,
    task_id: CanonicalIdSchema,
    rubric: z.string(),
    score: z.number(),
    passed: z.boolean(),
    notes: z.string(),
  })
  .strict();

export const EventSchema = z
  .object({
    id: CanonicalIdSchema,
    workspace_id: CanonicalIdSchema,
    run_id: CanonicalIdSchema.nullable().default(null),
    seq: z.number().int(),
    run_seq: z.number().int().nullable().default(null),
    kind: z.string(),
    actor: z.string(),
    payload: EventPayloadSchema.default({ data: {}, refs: [] }),
    timestamp: UtcTimestampSchema,
    idempotency_key: z.string().nullable().default(null),
    // Tamper-evidence: each persisted event chains its content hash onto the
    // previous event in the workspace. Nullable so historical/synthetic events
    // remain parseable; the EventStore populates both for everything it writes.
    prev_hash: z.string().nullable().default(null),
    hash: z.string().nullable().default(null),
  })
  .strict();

export const IngestionRecordSchema = z
  .object({
    id: CanonicalIdSchema,
    workspace_id: CanonicalIdSchema,
    source: ExternalSourceSchema,
    actor: ExternalActorRefSchema,
    kind: z.enum(["event", "trace", "outcome", "artifact", "memory_proposal"]),
    target_run_id: CanonicalIdSchema.nullable().default(null),
    target_work_item_id: CanonicalIdSchema.nullable().default(null),
    idempotency_key: z.string(),
    payload: recordSchema.default({}),
    occurred_at: UtcTimestampSchema,
  })
  .strict();

export const TraceSchema = z
  .object({
    id: CanonicalIdSchema,
    workspace_id: CanonicalIdSchema,
    run_id: CanonicalIdSchema,
    node: z.string(),
    inputs_ref: z.string().nullable().default(null),
    outputs_ref: z.string().nullable().default(null),
    cost: CostSchema.default({
      tokens_in: 0,
      tokens_out: 0,
      usd: 0,
      provider: null,
      model: null,
    }),
    timestamp: UtcTimestampSchema,
    event_ids: z.array(CanonicalIdSchema).default([]),
  })
  .strict();

export const NodeEffectSchema = z
  .object({
    id: CanonicalIdSchema,
    workspace_id: CanonicalIdSchema,
    run_id: CanonicalIdSchema,
    node: z.string(),
    idempotency_key: z.string(),
    effect_type: z.string(),
    effect_ref: z.string(),
    content_hash: z.string().nullable().default(null),
    created_at: UtcTimestampSchema,
  })
  .strict();

export const ModelRequestSchema = z
  .object({
    id: CanonicalIdSchema,
    workspace_id: CanonicalIdSchema,
    run_id: CanonicalIdSchema.nullable().default(null),
    requested_by: z.string(),
    purpose: z.string(),
    model_binding: z.string().default("mock"),
    input_ref: z.string().nullable().default(null),
    idempotency_key: z.string(),
  })
  .strict();

export const ModelResponseSchema = z
  .object({
    id: CanonicalIdSchema,
    workspace_id: CanonicalIdSchema,
    request_id: CanonicalIdSchema,
    status: z.enum(["ok", "failed"]),
    output_ref: z.string().nullable().default(null),
    cost: CostSchema.default({
      tokens_in: 0,
      tokens_out: 0,
      usd: 0,
      provider: null,
      model: null,
    }),
    error: z.string().nullable().default(null),
  })
  .strict();

export const OrgChangeEvidenceSchema = z
  .object({
    kind: z.enum([
      "event",
      "trace",
      "work_item",
      "approval",
      "memory_entry",
      "capability",
      "ingestion",
      "world_model",
      "external_url",
      "other",
    ]),
    ref_id: z.string(),
    summary: z.string(),
    weight: z.number().default(1),
  })
  .strict();

export const OrgChangeSourceSignalSchema = z.enum([
  "manual",
  "repeated_blocker",
  "failed_handoff",
  "approval_bottleneck",
  "missing_capability",
  "stale_memory",
  "other",
]);

export const OrgChangeProposalSchema = z
  .object({
    id: CanonicalIdSchema,
    workspace_id: CanonicalIdSchema,
    proposed_by: z.string(),
    change_type: z.enum([
      "role",
      "workflow",
      "sop",
      "policy",
      "capability",
      "capability_grant",
      "capability_change",
      "memory",
      "memory_cleanup",
      "org_graph",
      "other",
    ]),
    source_signal: OrgChangeSourceSignalSchema.default("manual"),
    rationale: z.string(),
    evidence: z.array(OrgChangeEvidenceSchema).default([]),
    patch_json: recordSchema.default({}),
    confidence: z.number().min(0).max(1).default(0.5),
    impact: z.enum(["low", "medium", "high"]).default("medium"),
    review_approval_id: CanonicalIdSchema.nullable().default(null),
    // `pending` is retained for pre-institutional-learning/manual compatibility; services create `proposed`.
    status: z
      .enum(["draft", "pending", "proposed", "approved", "rejected", "applied"])
      .default("draft"),
    created_at: UtcTimestampSchema,
    resolved_at: UtcTimestampSchema.nullable().default(null),
    applied_at: UtcTimestampSchema.nullable().default(null),
  })
  .strict();

export const CadenceKindSchema = z.enum(["learning_scan", "stale_approval_sweep", "status_digest"]);

export const CadenceSchema = z
  .object({
    id: CanonicalIdSchema,
    workspace_id: CanonicalIdSchema,
    kind: CadenceKindSchema,
    // Bounded above (~10 years) so advancing next_due_at can never overflow the
    // representable RFC3339 year range.
    interval_seconds: z.number().int().positive().max(315_360_000),
    enabled: z.boolean().default(true),
    created_at: UtcTimestampSchema,
    last_fired_at: UtcTimestampSchema.nullable().default(null),
    next_due_at: UtcTimestampSchema,
  })
  .strict();

export const NotificationSchema = z
  .object({
    id: CanonicalIdSchema,
    workspace_id: CanonicalIdSchema,
    actor: z.string().default("chief_of_staff"),
    kind: z.string(),
    severity: z.enum(["info", "attention", "urgent"]).default("info"),
    summary: z.string(),
    evidence: z.array(OrgChangeEvidenceSchema).default([]),
    refs: z.array(z.string()).default([]),
    status: z.enum(["unread", "read"]).default("unread"),
    source_event_id: CanonicalIdSchema.nullable().default(null),
    created_at: UtcTimestampSchema,
    read_at: UtcTimestampSchema.nullable().default(null),
  })
  .strict();

// M1 reversible apply. An `OrgChangeApplication` is the first-class record of an org change
// being *actually applied* (not just marked): it captures the before/after state of every
// target it touched, with content hashes, so the application can be verified after the fact
// and safely reverted. One application per ratified proposal (id derived from the proposal).
export const OrgChangeTargetStateSchema = z
  .object({
    // The entity the change touched (e.g. a memory entry id).
    ref: CanonicalIdSchema,
    before_status: z.string(),
    after_status: z.string(),
    // Content hashes of the canonical target serialization, before and after the mutation.
    // Revert compares the live target against `after_hash` to detect drift (revert-conflict).
    before_hash: z.string(),
    after_hash: z.string(),
  })
  .strict();

export const OrgChangeApplicationSchema = z
  .object({
    id: CanonicalIdSchema,
    workspace_id: CanonicalIdSchema,
    proposal_id: CanonicalIdSchema,
    change_type: z.string(),
    applied_by: z.string(),
    // `false` marks a destructive change that cannot be auto-reverted (none in M1).
    reversible: z.boolean().default(true),
    targets: z.array(OrgChangeTargetStateSchema).default([]),
    // applied → verified (post-apply check passed) → reverted (operator undid it).
    status: z.enum(["applied", "verified", "reverted"]).default("applied"),
    failure_reason: z.string().nullable().default(null),
    created_at: UtcTimestampSchema,
    verified_at: UtcTimestampSchema.nullable().default(null),
    reverted_at: UtcTimestampSchema.nullable().default(null),
  })
  .strict();

// M1 operator kill-switch. When `apply_paused` is set, the apply engine refuses to mutate org
// state (sense/report stays live). Workspace-scoped: one workspace = one self-correction loop.
export const OrgControlStateSchema = z
  .object({
    workspace_id: CanonicalIdSchema,
    apply_paused: z.boolean().default(false),
    reason: z.string().nullable().default(null),
    updated_by: z.string().nullable().default(null),
    updated_at: UtcTimestampSchema,
  })
  .strict();

export const AutonomyLevelSchema = z.enum(["advisory", "supervised", "bounded"]);

// M4 earned autonomy. An `AutonomyCase` is a human-ratified, evidence-backed request to WIDEN an
// organization's autonomy one step (advisory → supervised → bounded). The dial only ever moves via
// a ratified case — never a flag, never automatically — and only on an audited track record.
export const AutonomyCaseSchema = z
  .object({
    id: CanonicalIdSchema,
    workspace_id: CanonicalIdSchema,
    org_id: CanonicalIdSchema,
    current_level: AutonomyLevelSchema,
    proposed_level: AutonomyLevelSchema,
    // The audited track record backing the widening (e.g. verified applies, incident-free runs).
    evidence: z.array(OrgChangeEvidenceSchema).default([]),
    rationale: z.string(),
    status: z.enum(["proposed", "ratified", "rejected"]).default("proposed"),
    proposed_by: z.string(),
    ratified_by: z.string().nullable().default(null),
    created_at: UtcTimestampSchema,
    resolved_at: UtcTimestampSchema.nullable().default(null),
  })
  .strict();

export const CollectiveMemorySummarySchema = z
  .object({
    id: CanonicalIdSchema,
    kind: z.enum(["episodic", "procedural", "semantic", "decision"]),
    confidence: z.number(),
    corroboration_count: z.number().int().default(0),
  })
  .strict();

export const WorldModelSnapshotSchema = z
  .object({
    id: CanonicalIdSchema,
    workspace_id: CanonicalIdSchema,
    run_id: CanonicalIdSchema.nullable().default(null),
    active_goals: z.array(CanonicalIdSchema).default([]),
    active_work: z.array(CanonicalIdSchema).default([]),
    blockers: z.array(z.string()).default([]),
    pending_approvals: z.array(CanonicalIdSchema).default([]),
    pending_reviews: z.array(CanonicalIdSchema).default([]),
    open_org_change_proposals: z.array(CanonicalIdSchema).default([]),
    learning_signals: z.array(z.string()).default([]),
    external_workers: z.array(CanonicalIdSchema).default([]),
    recent_ingestions: z.array(CanonicalIdSchema).default([]),
    capability_gaps: z.array(z.string()).default([]),
    recent_events: z.array(CanonicalIdSchema).default([]),
    collective_memory: z.array(CollectiveMemorySummarySchema).default([]),
    latest_run_status: RunStatusSchema.nullable().default(null),
    source_workspace_seq: z.number().int().default(0),
    source_run_seq: z.number().int().nullable().default(null),
    generated_at: UtcTimestampSchema,
    cache_only: z.boolean().default(true),
  })
  .strict();

export const canonicalModelSchemas = {
  Workspace: WorkspaceSchema,
  Organization: OrganizationSchema,
  Role: RoleSchema,
  Agent: AgentSchema,
  Tool: ToolSchema,
  WorkerIdentity: WorkerIdentitySchema,
  Goal: GoalSchema,
  WorkItem: WorkItemSchema,
  Run: RunSchema,
  TaskEnvelope: TaskEnvelopeSchema,
  BoundedWorkEnvelope: BoundedWorkEnvelopeSchema,
  AgentOutcome: AgentOutcomeSchema,
  WorkerOutcome: WorkerOutcomeSchema,
  Capability: CapabilitySchema,
  CapabilityCall: CapabilityCallSchema,
  CapabilityResult: CapabilityResultSchema,
  MemoryEntry: MemoryEntrySchema,
  PromotionCandidate: PromotionCandidateSchema,
  Corroboration: CorroborationSchema,
  Artifact: ArtifactSchema,
  Policy: PolicySchema,
  PolicyDecision: PolicyDecisionSchema,
  ApprovalRequest: ApprovalRequestSchema,
  Evaluation: EvaluationSchema,
  Event: EventSchema,
  IngestionRecord: IngestionRecordSchema,
  Trace: TraceSchema,
  NodeEffect: NodeEffectSchema,
  ModelRequest: ModelRequestSchema,
  ModelResponse: ModelResponseSchema,
  OrgChangeProposal: OrgChangeProposalSchema,
  Cadence: CadenceSchema,
  Notification: NotificationSchema,
  OrgChangeApplication: OrgChangeApplicationSchema,
  OrgControlState: OrgControlStateSchema,
  AutonomyCase: AutonomyCaseSchema,
  WorldModelSnapshot: WorldModelSnapshotSchema,
} as const;

export const schemaDefinitions = {
  ExternalSource: ExternalSourceSchema,
  ExternalActorRef: ExternalActorRefSchema,
  MemoryScope: MemoryScopeSchema,
  Provenance: ProvenanceSchema,
  Cost: CostSchema,
  ArtifactRef: ArtifactRefSchema,
  ApprovalPayload: ApprovalPayloadSchema,
  EventPayload: EventPayloadSchema,
  CapabilityProviderRef: CapabilityProviderRefSchema,
  OrgChangeEvidence: OrgChangeEvidenceSchema,
  OrgChangeSourceSignal: OrgChangeSourceSignalSchema,
  CadenceKind: CadenceKindSchema,
  OrgChangeTargetState: OrgChangeTargetStateSchema,
  CollectiveMemorySummary: CollectiveMemorySummarySchema,
  ...canonicalModelSchemas,
} as const;

export type PolicyOutcome = z.infer<typeof PolicyOutcomeSchema>;
export type RunStatus = z.infer<typeof RunStatusSchema>;
export type CanonicalModelName = keyof typeof canonicalModelSchemas;
export type ExternalSource = z.infer<typeof ExternalSourceSchema>;
export type ExternalActorRef = z.infer<typeof ExternalActorRefSchema>;
export type MemoryScope = z.infer<typeof MemoryScopeSchema>;
export type Provenance = z.infer<typeof ProvenanceSchema>;
export type Cost = z.infer<typeof CostSchema>;
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;
export type ApprovalPayload = z.infer<typeof ApprovalPayloadSchema>;
export type EventPayload = z.infer<typeof EventPayloadSchema>;
export type Workspace = z.infer<typeof WorkspaceSchema>;
export type Organization = z.infer<typeof OrganizationSchema>;
export type Role = z.infer<typeof RoleSchema>;
export type Agent = z.infer<typeof AgentSchema>;
export type Tool = z.infer<typeof ToolSchema>;
export type WorkerIdentity = z.infer<typeof WorkerIdentitySchema>;
export type Goal = z.infer<typeof GoalSchema>;
export type WorkItem = z.infer<typeof WorkItemSchema>;
export type Run = z.infer<typeof RunSchema>;
export type TaskEnvelope = z.infer<typeof TaskEnvelopeSchema>;
export type BoundedWorkEnvelope = z.infer<typeof BoundedWorkEnvelopeSchema>;
export type AgentOutcome = z.infer<typeof AgentOutcomeSchema>;
export type WorkerOutcome = z.infer<typeof WorkerOutcomeSchema>;
export type Capability = z.infer<typeof CapabilitySchema>;
export type CapabilityProviderRef = z.infer<typeof CapabilityProviderRefSchema>;
export type CapabilityCall = z.infer<typeof CapabilityCallSchema>;
export type CapabilityResult = z.infer<typeof CapabilityResultSchema>;
export type MemoryEntry = z.infer<typeof MemoryEntrySchema>;
export type PromotionCandidate = z.infer<typeof PromotionCandidateSchema>;
export type Corroboration = z.infer<typeof CorroborationSchema>;
export type Artifact = z.infer<typeof ArtifactSchema>;
export type Policy = z.infer<typeof PolicySchema>;
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;
export type Evaluation = z.infer<typeof EvaluationSchema>;
export type Event = z.infer<typeof EventSchema>;
export type IngestionRecord = z.infer<typeof IngestionRecordSchema>;
export type Trace = z.infer<typeof TraceSchema>;
export type NodeEffect = z.infer<typeof NodeEffectSchema>;
export type ModelRequest = z.infer<typeof ModelRequestSchema>;
export type ModelResponse = z.infer<typeof ModelResponseSchema>;
export type OrgChangeEvidence = z.infer<typeof OrgChangeEvidenceSchema>;
export type OrgChangeSourceSignal = z.infer<typeof OrgChangeSourceSignalSchema>;
export type CollectiveMemorySummary = z.infer<typeof CollectiveMemorySummarySchema>;
export type OrgChangeProposal = z.infer<typeof OrgChangeProposalSchema>;
export type CadenceKind = z.infer<typeof CadenceKindSchema>;
export type Cadence = z.infer<typeof CadenceSchema>;
export type Notification = z.infer<typeof NotificationSchema>;
export type OrgChangeTargetState = z.infer<typeof OrgChangeTargetStateSchema>;
export type OrgChangeApplication = z.infer<typeof OrgChangeApplicationSchema>;
export type OrgControlState = z.infer<typeof OrgControlStateSchema>;
export type AutonomyLevel = z.infer<typeof AutonomyLevelSchema>;
export type AutonomyCase = z.infer<typeof AutonomyCaseSchema>;
export type WorldModelSnapshot = z.infer<typeof WorldModelSnapshotSchema>;
