import { createHash } from "node:crypto";

import {
  ApprovalPayloadSchema,
  type Capability,
  type CapabilityCall,
  CapabilityCallSchema,
  type CapabilityResult,
  CapabilityResultSchema,
  EventPayloadSchema,
  NodeEffectSchema,
  newId,
  type PolicyDecision,
  PolicyDecisionSchema,
  utcNow,
} from "../contracts/index.js";
import { ApprovalService, type GovernanceService } from "../governance/index.js";
import {
  CapabilityCallStore,
  CapabilityResultStore,
  CapabilityStore,
  type Database,
  EventStore,
  NodeEffectStore,
  RunStore,
  TaskEnvelopeStore,
  WorkerIdentityStore,
} from "../persistence/index.js";
import {
  assertNoSensitiveMaterial,
  assertNoSensitiveString,
  safeErrorMessage,
  validateCredentialHandle,
} from "../security/sensitive-material.js";
import type { CapabilityProvider } from "./providers.js";

export type CapabilityInvocation = {
  call: CapabilityCall;
  decision: PolicyDecision;
  result?: CapabilityResult | null;
  approval_id?: string | null;
};

type ExecutableCapability = {
  call: CapabilityCall;
  capability: Capability;
  decision: PolicyDecision;
  approvalId: string | null;
};

type InvokeTransactionResult =
  | { mode: "pending"; invocation: CapabilityInvocation }
  | { mode: "execute"; executable: ExecutableCapability };

/**
 * In-process registry of capability executions currently awaiting their async
 * provider, keyed by `${database.path}:${workspace_id}:${call.id}`. A concurrent
 * duplicate invocation of the same call (for example a retried HTTP request)
 * joins the original execution and returns its result instead of recording a
 * spurious failure against the still-running provider call. The key includes the
 * durable database path so concurrent invocations against the same backing file
 * join even through different `Database` handles, while distinct database files
 * that reuse the deterministic demo/test IDs never share in-flight state. The
 * map is only consulted when the durable node-effect guard reports the effect
 * already exists, so two separate in-memory databases (which never share
 * effects) cannot cross-contaminate. A cross-process retry has no in-flight
 * entry and still falls back to the durable "refuse to re-execute" guard.
 */
const INFLIGHT_PROVIDER_EXECUTIONS = new Map<string, Promise<CapabilityResult>>();

export class CapabilityRegistryError extends Error {}

export class CapabilityRegistryService {
  private readonly approvals: ApprovalService;
  private readonly capabilities: CapabilityStore;
  private readonly calls: CapabilityCallStore;
  private readonly results: CapabilityResultStore;
  private readonly effects: NodeEffectStore;
  private readonly events: EventStore;
  private readonly runs: RunStore;
  private readonly tasks: TaskEnvelopeStore;
  private readonly workers: WorkerIdentityStore;
  private readonly providers: Map<string, CapabilityProvider>;

  constructor(
    private readonly database: Database,
    private readonly governance: GovernanceService,
    providers: CapabilityProvider[],
  ) {
    this.approvals = new ApprovalService(database);
    this.capabilities = new CapabilityStore(database);
    this.calls = new CapabilityCallStore(database);
    this.results = new CapabilityResultStore(database);
    this.effects = new NodeEffectStore(database);
    this.events = new EventStore(database);
    this.runs = new RunStore(database);
    this.tasks = new TaskEnvelopeStore(database);
    this.workers = new WorkerIdentityStore(database);
    this.providers = new Map(providers.map((provider) => [provider.name, provider]));
  }

  register(capability: Capability): Capability {
    return this.database.transaction(() => {
      // The bound handle is persisted and emitted in the registration event, so
      // it must be a non-secret cred_* handle — never a raw token.
      if (capability.credential_handle) {
        validateCredentialHandle(capability.credential_handle);
      }
      const registered = this.capabilities.save(capability);
      this.events.append({
        workspace_id: registered.workspace_id,
        kind: "capability.registered",
        actor: "capability_registry",
        payload: EventPayloadSchema.parse({ data: { capability: registered } }),
        idempotency_key: `${registered.workspace_id}:${registered.name}:registered`,
      });
      return registered;
    });
  }

  async invoke(callInput: CapabilityCall): Promise<CapabilityInvocation> {
    const transactionResult = this.database.transaction<InvokeTransactionResult>(() => {
      const call = CapabilityCallSchema.parse(callInput);
      const capability = this.capabilities.get(call.workspace_id, call.capability_name);
      if (!capability) {
        throw new CapabilityRegistryError(`capability not registered: ${call.capability_name}`);
      }

      this.validatePayload(call.input, capability.canonical_input_schema, "input");
      this.validateSafeCallMaterial(call);
      const existingCall = this.calls.getByIdempotencyKey(call.workspace_id, call.idempotency_key);
      if (!existingCall) {
        this.requireProviderExecutableRun(call);
      }
      const recordedCall = this.calls.record(call);
      this.emitCallPersisted(recordedCall);
      this.events.append({
        workspace_id: recordedCall.workspace_id,
        run_id: recordedCall.run_id,
        kind: "capability.requested",
        actor: "capability_registry",
        payload: EventPayloadSchema.parse({ data: { capability_call: recordedCall } }),
        idempotency_key: `${recordedCall.id}:requested`,
      });

      const existingResult = this.results.getForCall(recordedCall.workspace_id, recordedCall.id);
      if (existingResult) {
        return {
          mode: "pending",
          invocation: {
            call: recordedCall,
            decision: this.requireRecordedCapabilityDecision(recordedCall),
            result: existingResult,
          },
        };
      }

      const existingApproval = this.approvals.approvals.findForTarget({
        workspace_id: recordedCall.workspace_id,
        target_type: "capability_call",
        target_id: recordedCall.id,
        statuses: new Set(["pending", "approved", "rejected"]),
      });
      if (existingApproval) {
        const decision = this.requireRecordedCapabilityDecision(recordedCall);
        if (existingApproval.status === "approved") {
          return {
            mode: "execute",
            executable: {
              call: recordedCall,
              capability,
              decision,
              approvalId: existingApproval.id,
            },
          };
        }
        if (existingApproval.status === "rejected") {
          return {
            mode: "pending",
            invocation: {
              call: recordedCall,
              decision,
              approval_id: existingApproval.id,
              result: this.recordBlockedResult(recordedCall, "capability approval was rejected"),
            },
          };
        }
        return {
          mode: "pending",
          invocation: {
            call: recordedCall,
            decision,
            approval_id: existingApproval.id,
          },
        };
      }

      const recordedDecision = this.getRecordedCapabilityDecision(recordedCall);
      if (recordedDecision) {
        if (recordedDecision.outcome === "block") {
          return {
            mode: "pending",
            invocation: {
              call: recordedCall,
              decision: recordedDecision,
              result: this.recordBlockedResult(recordedCall, recordedDecision.reason),
            },
          };
        }
        return {
          mode: "execute",
          executable: {
            call: recordedCall,
            capability,
            decision: recordedDecision,
            approvalId: null,
          },
        };
      }

      let decision = this.decideCall(recordedCall, capability);
      if (decision.outcome === "require_approval") {
        const approvalId = this.approvalIdForCall(recordedCall);
        decision = PolicyDecisionSchema.parse({ ...decision, approval_id: approvalId });
        decision = this.recordCapabilityDecision(decision, recordedCall);
        const approval = this.approvals.request({
          approval_id: approvalId,
          workspace_id: recordedCall.workspace_id,
          run_id: recordedCall.run_id,
          action: "capability.call",
          requested_by: recordedCall.requested_by,
          payload: ApprovalPayloadSchema.parse({
            target_type: "capability_call",
            target_id: recordedCall.id,
            reason: decision.reason,
            data: { capability_call: recordedCall },
          }),
          on_approve: "resume_run",
          on_reject: "fail_run",
        });
        return {
          mode: "pending",
          invocation: { call: recordedCall, decision, approval_id: approval.id },
        };
      }

      decision = this.recordCapabilityDecision(decision, recordedCall);
      if (decision.outcome === "block") {
        return {
          mode: "pending",
          invocation: {
            call: recordedCall,
            decision,
            result: this.recordBlockedResult(recordedCall, decision.reason),
          },
        };
      }

      return {
        mode: "execute",
        executable: { call: recordedCall, capability, decision, approvalId: null },
      };
    });

    if (transactionResult.mode === "pending") {
      return transactionResult.invocation;
    }

    const executable = transactionResult.executable;
    const result = await this.executeProvider(executable.call, executable.capability);
    return {
      call: executable.call,
      decision: executable.decision,
      result,
      approval_id: executable.approvalId,
    };
  }

  async resumeApprovedCall(
    approvalId: string,
    input: { workspace_id: string },
  ): Promise<CapabilityInvocation> {
    const approval = this.approvals.approvals.get(approvalId);
    if (!approval) {
      throw new CapabilityRegistryError(`approval request not found: ${approvalId}`);
    }
    if (approval.workspace_id !== input.workspace_id) {
      throw new CapabilityRegistryError(
        `approval request does not belong to workspace: ${approvalId}`,
      );
    }
    if (approval.status !== "approved") {
      throw new CapabilityRegistryError(`approval request is not approved: ${approvalId}`);
    }
    if (approval.payload.target_type !== "capability_call") {
      throw new CapabilityRegistryError(
        `approval does not target a capability call: ${approvalId}`,
      );
    }
    const call = this.calls.get(approval.payload.target_id);
    if (!call) {
      throw new CapabilityRegistryError(`capability call not found: ${approval.payload.target_id}`);
    }
    return await this.invoke(call);
  }

  private decideCall(call: CapabilityCall, capability: Capability): PolicyDecision {
    const taskBoundaryBlockReason = this.taskBoundaryBlockReason(call);
    if (taskBoundaryBlockReason) {
      return this.policyBlock(call, taskBoundaryBlockReason);
    }

    const gatewayBlockReason = this.gatewayBlockReason(call, capability);
    if (gatewayBlockReason) {
      return this.policyBlock(call, gatewayBlockReason);
    }
    const resourceScopeBlockReason = this.resourceScopeBlockReason(call, capability);
    if (resourceScopeBlockReason) {
      return this.policyBlock(call, resourceScopeBlockReason);
    }
    if (call.external_actor?.actor_type === "worker") {
      return this.decideWorkerCapability(call, capability);
    }
    return this.governance.decideCapability(call, capability);
  }

  private gatewayBlockReason(call: CapabilityCall, capability: Capability): string | null {
    if (!capability.providers.includes(call.provider)) {
      return `Capability provider is not declared: ${call.provider}.`;
    }
    if (!this.providers.has(call.provider)) {
      return `Capability provider is not available: ${call.provider}.`;
    }
    if (capability.credential_handle_required && !call.credential_handle) {
      return `Capability requires a credential handle: ${call.capability_name}.`;
    }
    // Bind the credential to the capability, not the caller. A capability that
    // brokers a credential must declare the handle it is bound to, and any call
    // that carries a credential handle must use exactly that declared handle —
    // otherwise a worker could steer broker resolution to any other configured
    // credential by naming it in the call. Gating the match on the *call*'s
    // handle (not the capability's) means a side-effecting capability that
    // forgot to declare a binding still cannot resolve a worker-named handle.
    if (capability.credential_handle_required && !capability.credential_handle) {
      return `Capability requires a declared credential handle binding: ${call.capability_name}.`;
    }
    if (call.credential_handle && call.credential_handle !== capability.credential_handle) {
      return `Capability call credential handle does not match the capability's bound handle: ${call.capability_name}.`;
    }
    if (capability.side_effecting && !call.side_effecting) {
      return `Capability call must be marked side-effecting: ${call.capability_name}.`;
    }
    // An intrinsically side-effecting provider must run through the side-effect /
    // approval gate even if the capability was misregistered as non-side-effecting.
    if (
      this.providers.get(call.provider)?.sideEffecting &&
      (!capability.side_effecting || !call.side_effecting)
    ) {
      return `Provider is side-effecting; capability and call must be marked side-effecting: ${call.capability_name}.`;
    }
    return null;
  }

  private decideWorkerCapability(call: CapabilityCall, capability: Capability): PolicyDecision {
    const actorId = call.external_actor?.actor_id;
    if (actorId !== call.requested_by) {
      return this.policyBlock(call, "External worker actor does not match capability caller.");
    }

    const worker = this.workers.get(actorId);
    if (!worker || worker.workspace_id !== call.workspace_id) {
      return this.policyBlock(call, `Worker identity not found in workspace: ${actorId}.`);
    }
    if (worker.status !== "enabled") {
      return this.policyBlock(call, `Worker identity is disabled: ${worker.id}.`);
    }
    if (capability.default_permission === "disabled") {
      return this.policyBlock(call, `Capability is disabled: ${call.capability_name}.`);
    }
    if (!worker.allowed_capabilities.includes(call.capability_name)) {
      return this.policyBlock(
        call,
        `Worker identity lacks capability grant: ${call.capability_name}.`,
      );
    }

    const decision = this.governance.capabilityApprovalDecision(call, capability);

    return PolicyDecisionSchema.parse({
      id: newId("decision"),
      workspace_id: call.workspace_id,
      run_id: call.run_id,
      action: "capability.call",
      target_type: "capability_call",
      target_id: call.id,
      outcome: decision.outcome,
      reason: decision.reason,
    });
  }

  private taskBoundaryBlockReason(call: CapabilityCall): string | null {
    const task = this.tasks.get(call.task_id);
    if (!task) {
      return `Task envelope not found for capability call: ${call.task_id}.`;
    }
    if (task.workspace_id !== call.workspace_id) {
      return "Capability call workspace does not match task envelope.";
    }
    if (task.run_id !== call.run_id) {
      return "Capability call run does not match task envelope.";
    }
    if (task.to_agent !== call.requested_by) {
      return "Capability caller is not the task envelope assignee.";
    }
    if (!task.allowed_capabilities.includes(call.capability_name)) {
      return `Capability is not allowed by the task envelope: ${call.capability_name}.`;
    }
    return null;
  }

  // Enforce per-resource scope: a capability that declares `resource_fields` may act only on a
  // resource the bounded envelope explicitly granted. Default-deny — a declared resource field with
  // no grant, or a value outside the grant, is blocked before execution. Capabilities with no
  // declared resource fields (e.g. the mock providers) are unaffected. The resource value is never
  // echoed in the block reason.
  private resourceScopeBlockReason(call: CapabilityCall, capability: Capability): string | null {
    if (capability.resource_fields.length === 0) {
      return null;
    }
    const task = this.tasks.get(call.task_id);
    const grants = task?.resource_grants[call.capability_name] ?? {};
    for (const field of capability.resource_fields) {
      const allowed = grants[field];
      if (!allowed || allowed.length === 0) {
        return `Capability '${call.capability_name}' requires a bounded resource grant for '${field}'.`;
      }
      // Strict string match — never coerce. A non-string resource value (array, object with a
      // crafted toString, number) is blocked, so e.g. `repo: ["OpenMAO"]` cannot stringify to a
      // granted value while the provider reads the array differently. Resource grants are
      // string-valued by design.
      const value = call.input[field];
      if (typeof value !== "string" || !allowed.includes(value)) {
        return `Capability call resource '${field}' is outside the bounded envelope's grant.`;
      }
    }
    return null;
  }

  private policyBlock(call: CapabilityCall, reason: string): PolicyDecision {
    return PolicyDecisionSchema.parse({
      id: newId("decision"),
      workspace_id: call.workspace_id,
      run_id: call.run_id,
      action: "capability.call",
      target_type: "capability_call",
      target_id: call.id,
      outcome: "block",
      reason,
    });
  }

  private recordCapabilityDecision(decision: PolicyDecision, call: CapabilityCall): PolicyDecision {
    const stableDecision = PolicyDecisionSchema.parse({
      ...decision,
      id: this.decisionIdForCall(call),
    });
    return this.governance.recordDecision(stableDecision, `${call.id}:policy_decision`);
  }

  private requireRecordedCapabilityDecision(call: CapabilityCall): PolicyDecision {
    const decision = this.getRecordedCapabilityDecision(call);
    if (!decision) {
      throw new CapabilityRegistryError(
        `recorded capability policy decision not found: ${call.id}`,
      );
    }
    return decision;
  }

  private getRecordedCapabilityDecision(call: CapabilityCall): PolicyDecision | null {
    return this.governance.getRecordedDecision({
      workspace_id: call.workspace_id,
      idempotency_key: `${call.id}:policy_decision`,
    });
  }

  private async executeProvider(
    call: CapabilityCall,
    capability: Capability,
  ): Promise<CapabilityResult> {
    this.requireProviderExecutableRun(call);
    const existing = this.results.getForCall(call.workspace_id, call.id);
    if (existing) {
      return existing;
    }

    const provider = this.providers.get(call.provider);
    if (!provider) {
      return this.recordFailedResult(
        call,
        null,
        `Capability provider is not available: ${call.provider}.`,
      );
    }

    const node = `capability:${call.capability_name}`;
    const effectKey = `${call.id}:provider`;
    const inflightKey = `${this.database.path}:${call.workspace_id}:${call.id}`;
    const { effect, created } = this.ensureProviderEffect(call, node, effectKey);
    if (!created) {
      const inflight = INFLIGHT_PROVIDER_EXECUTIONS.get(inflightKey);
      if (inflight) {
        // A concurrent invocation of the same call is mid-flight against this
        // backing database: join it rather than poisoning the in-flight side
        // effect (the durable node effect is shared across handles to one file).
        return await inflight;
      }
      return this.recordFailedResult(
        call,
        effect.id,
        "capability provider execution was already started without a persisted result; refusing to re-execute",
      );
    }

    const execution = this.runProviderExecution(call, capability, provider, effect.id);
    INFLIGHT_PROVIDER_EXECUTIONS.set(inflightKey, execution);
    try {
      return await execution;
    } finally {
      INFLIGHT_PROVIDER_EXECUTIONS.delete(inflightKey);
    }
  }

  private async runProviderExecution(
    call: CapabilityCall,
    capability: Capability,
    provider: CapabilityProvider,
    nodeEffectId: string,
  ): Promise<CapabilityResult> {
    try {
      const providerResult = await provider.execute(call);
      const result = CapabilityResultSchema.parse({
        ...providerResult,
        id: newId("capresult"),
        workspace_id: call.workspace_id,
        run_id: call.run_id,
        call_id: call.id,
        node_effect_id: nodeEffectId,
      });
      assertNoSensitiveMaterial(result.output, "capability_result.output");
      assertNoSensitiveMaterial(result.artifacts, "capability_result.artifacts");
      if (result.status === "ok") {
        this.validatePayload(result.output, capability.canonical_output_schema, "output");
      }
      if (result.error) {
        assertNoSensitiveString(result.error, "capability_result.error");
      }
      return this.recordResultEvent(result, `${call.id}:completed`);
    } catch (error) {
      return this.recordResultEvent(
        CapabilityResultSchema.parse({
          id: newId("capresult"),
          workspace_id: call.workspace_id,
          run_id: call.run_id,
          call_id: call.id,
          node_effect_id: nodeEffectId,
          status: "failed",
          error:
            error instanceof Error ? safeErrorMessage(error.message) : "capability provider failed",
        }),
        `${call.id}:completed`,
      );
    }
  }

  private ensureProviderEffect(
    call: CapabilityCall,
    node: string,
    idempotencyKey: string,
  ): { effect: ReturnType<NodeEffectStore["record"]>; created: boolean } {
    return this.database.transaction(() => {
      const existing = this.effects.getByKey(call.run_id, node, idempotencyKey);
      if (existing) {
        return { effect: existing, created: false };
      }
      const effect = this.effects.record(
        NodeEffectSchema.parse({
          id: newId("effect"),
          workspace_id: call.workspace_id,
          run_id: call.run_id,
          node,
          idempotency_key: idempotencyKey,
          effect_type: "capability.execute",
          effect_ref: call.id,
          created_at: utcNow(),
        }),
      );
      return { effect, created: true };
    });
  }

  private requireProviderExecutableRun(call: CapabilityCall): void {
    const run = this.runs.get(call.run_id);
    if (!run) {
      throw new CapabilityRegistryError(`capability call run not found: ${call.run_id}`);
    }
    if (run.workspace_id !== call.workspace_id) {
      throw new CapabilityRegistryError(`capability call workspace does not match run: ${call.id}`);
    }
    if (run.status !== "running") {
      throw new CapabilityRegistryError(
        `capability provider execution requires a running run: ${run.id}`,
      );
    }
  }

  private recordBlockedResult(call: CapabilityCall, reason: string): CapabilityResult {
    const existing = this.results.getForCall(call.workspace_id, call.id);
    if (existing) {
      return existing;
    }
    return this.recordResultEvent(
      CapabilityResultSchema.parse({
        id: newId("capresult"),
        workspace_id: call.workspace_id,
        run_id: call.run_id,
        call_id: call.id,
        status: "blocked",
        error: reason,
      }),
      `${call.id}:blocked`,
    );
  }

  private recordFailedResult(
    call: CapabilityCall,
    nodeEffectId: string | null,
    reason: string,
  ): CapabilityResult {
    const existing = this.results.getForCall(call.workspace_id, call.id);
    if (existing) {
      return existing;
    }
    return this.recordResultEvent(
      CapabilityResultSchema.parse({
        id: newId("capresult"),
        workspace_id: call.workspace_id,
        run_id: call.run_id,
        call_id: call.id,
        node_effect_id: nodeEffectId,
        status: "failed",
        error: reason,
      }),
      `${call.id}:completed`,
    );
  }

  private recordResultEvent(result: CapabilityResult, idempotencyKey: string): CapabilityResult {
    return this.database.transaction(() => {
      const recorded = this.results.record(result);
      this.events.append({
        workspace_id: recorded.workspace_id,
        run_id: recorded.run_id,
        kind: recorded.status === "ok" ? "capability.completed" : "capability.failed",
        actor: "capability_registry",
        payload: EventPayloadSchema.parse({ data: { capability_result: recorded } }),
        idempotency_key: idempotencyKey,
      });
      return recorded;
    });
  }

  private emitCallPersisted(call: CapabilityCall): void {
    this.events.append({
      workspace_id: call.workspace_id,
      run_id: call.run_id,
      kind: "capability_call.persisted",
      actor: "capability_registry",
      payload: EventPayloadSchema.parse({ data: { capability_call: call } }),
      idempotency_key: `${call.id}:persisted`,
    });
  }

  private validatePayload(
    payload: Record<string, unknown>,
    schema: Record<string, unknown>,
    name: string,
  ): void {
    validateSchemaValue(payload, schema, name);
  }

  private validateSafeCallMaterial(call: CapabilityCall): void {
    if (call.credential_handle) {
      validateCredentialHandle(call.credential_handle);
    }
    assertNoSensitiveMaterial(call.input, "input");
    assertNoSensitiveMaterial(call.audit_payload, "audit_payload");
    assertNoSensitiveString(call.idempotency_key, "idempotency_key");
    // Body-controlled actor strings are persisted and emitted in capability events, so they must
    // pass the same sensitive-material perimeter as the rest of the call.
    if (call.external_actor) {
      assertNoSensitiveString(call.external_actor.actor_id, "external_actor.actor_id");
      if (call.external_actor.display_name) {
        assertNoSensitiveString(call.external_actor.display_name, "external_actor.display_name");
      }
    }
  }

  private approvalIdForCall(call: CapabilityCall): string {
    return `approval_${this.idSuffix(call.id)}`;
  }

  private decisionIdForCall(call: CapabilityCall): string {
    return `decision_${this.idSuffix(call.id)}`;
  }

  private idSuffix(identifier: string): string {
    const parts = identifier.split("_", 2);
    return parts[1] ?? createHash("sha256").update(identifier).digest("hex").slice(0, 32);
  }
}

function validateSchemaValue(value: unknown, schema: Record<string, unknown>, path: string): void {
  const schemaType = schema.type;
  if (schemaType === "string") {
    if (typeof value !== "string") {
      throw new CapabilityRegistryError(`capability ${path} must be a string`);
    }
    return;
  }
  if (schemaType === "boolean") {
    if (typeof value !== "boolean") {
      throw new CapabilityRegistryError(`capability ${path} must be a boolean`);
    }
    return;
  }
  if (schemaType === "integer") {
    if (!Number.isInteger(value)) {
      throw new CapabilityRegistryError(`capability ${path} must be an integer`);
    }
    return;
  }
  if (schemaType === "number") {
    if (typeof value !== "number") {
      throw new CapabilityRegistryError(`capability ${path} must be a number`);
    }
    return;
  }
  if (schemaType === "array") {
    if (!Array.isArray(value)) {
      throw new CapabilityRegistryError(`capability ${path} must be an array`);
    }
    const itemSchema = schema.items;
    if (itemSchema && typeof itemSchema === "object" && !Array.isArray(itemSchema)) {
      for (const [index, item] of value.entries()) {
        validateSchemaValue(item, itemSchema as Record<string, unknown>, `${path}[${index}]`);
      }
    }
    return;
  }
  if (schemaType === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new CapabilityRegistryError(`capability ${path} must be an object`);
    }
    const objectValue = value as Record<string, unknown>;
    const required = schema.required;
    if (!Array.isArray(required)) {
      throw new CapabilityRegistryError(`capability ${path} schema required must be a list`);
    }
    const missing = required.filter(
      (field) => typeof field === "string" && !(field in objectValue),
    );
    if (missing.length > 0) {
      throw new CapabilityRegistryError(
        `capability ${path} missing required fields: ${missing.join(", ")}`,
      );
    }
    const properties = schema.properties;
    if (properties && (typeof properties !== "object" || Array.isArray(properties))) {
      throw new CapabilityRegistryError(`capability ${path} schema properties must be an object`);
    }
    const propertyMap = properties as Record<string, unknown> | undefined;
    const additionalProperties = schema.additionalProperties;
    for (const [key, item] of Object.entries(objectValue)) {
      const propertySchema = propertyMap?.[key];
      if (propertySchema && typeof propertySchema === "object" && !Array.isArray(propertySchema)) {
        validateSchemaValue(item, propertySchema as Record<string, unknown>, `${path}.${key}`);
      } else if (propertySchema === undefined && additionalProperties !== true) {
        if (
          additionalProperties &&
          typeof additionalProperties === "object" &&
          !Array.isArray(additionalProperties)
        ) {
          validateSchemaValue(
            item,
            additionalProperties as Record<string, unknown>,
            `${path}.${key}`,
          );
        } else {
          throw new CapabilityRegistryError(`capability ${path} has unknown field: ${key}`);
        }
      }
    }
    return;
  }
  throw new CapabilityRegistryError(`capability ${path} schema type is unsupported`);
}
