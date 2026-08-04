import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type CapabilityProvider,
  CapabilityRegistryError,
  CapabilityRegistryService,
  type EffectObservation,
  MockSideEffectProvider,
} from "../src/capabilities/index.js";
import {
  type CapabilityCall,
  CapabilityCallSchema,
  type CapabilityResult,
  CapabilityResultSchema,
  CapabilitySchema,
  newId,
  type Reconcilable,
  WorkerIdentitySchema,
} from "../src/contracts/index.js";
import { GovernanceService } from "../src/governance/index.js";
import { OrgRegistry } from "../src/org/index.js";
import { Database, EventStore, WorkerIdentityStore } from "../src/persistence/index.js";
import { SpineService, WORKSPACE_ID } from "../src/spine/index.js";
import { WorkService } from "../src/work/index.js";

// ADR-0013 gate sites. The reconciliation pass that consumes `observeEffect`/`listEffects` is
// slice 3; what is under test here is only the declaration, the lattice, and the two gates.

const CAP = "mock.side_effect.record";
const HANDLE = "cred_mock_side_effect";
const READ_CAP = "mock.read";
const WORKER_ID = "worker_55555555555555555555555555555555";

let tmpRoot: string;
let database: Database;
let work: WorkService;
let seq: number;

// A provider that declares a level it cannot actually read back — the "decorative declaration"
// the ADR treats as a mismatch.
class DeclaresWithoutObserving implements CapabilityProvider {
  readonly name = "mock.side_effect";
  readonly sideEffecting = true;
  readonly reconcilable: Reconcilable = "receipt";
  execute(): never {
    throw new Error("not executed in these cases");
  }
}

// A provider that honestly declares the weaker level and can read it back.
class DownstreamStateProvider implements CapabilityProvider {
  readonly name = "mock.side_effect";
  readonly sideEffecting = true;
  readonly reconcilable: Reconcilable = "downstream_state";
  readonly executedCallIds: string[] = [];
  async observeEffect(_call: CapabilityCall): Promise<EffectObservation> {
    return { status: "absent" };
  }
  execute(call: CapabilityCall): CapabilityResult {
    this.executedCallIds.push(call.id);
    return CapabilityResultSchema.parse({
      id: newId("capresult"),
      workspace_id: call.workspace_id,
      run_id: call.run_id,
      call_id: call.id,
      status: "ok",
      output: { provider: this.name, effect: "recorded", handle: HANDLE },
    });
  }
}

// A provider predating the field entirely: no declaration at all, which must collapse to "none".
class LegacyProvider implements CapabilityProvider {
  readonly name = "mock.side_effect";
  readonly sideEffecting = true;
  execute(): never {
    throw new Error("not executed in these cases");
  }
}

// Read-side providers for the mismatch cases. Deliberately NOT side-effecting: the mismatch
// signal is orthogonal to the approval forcing, and a read keeps the dial out of the assertion.
class ReadProvider implements CapabilityProvider {
  readonly name = "mock";
  readonly executedCallIds: string[] = [];
  constructor(readonly reconcilable: Reconcilable) {}
  async observeEffect(_call: CapabilityCall): Promise<EffectObservation> {
    return { status: "absent" };
  }
  execute(call: CapabilityCall): CapabilityResult {
    this.executedCallIds.push(call.id);
    return CapabilityResultSchema.parse({
      id: newId("capresult"),
      workspace_id: call.workspace_id,
      run_id: call.run_id,
      call_id: call.id,
      status: "ok",
      output: { findings: [] },
    });
  }
}

function readCapability(reconcilable: Reconcilable) {
  return CapabilitySchema.parse({
    name: READ_CAP,
    workspace_id: WORKSPACE_ID,
    description: "A read used to exercise the mismatch signal without the approval gate.",
    tool_name: "mock",
    canonical_input_schema: {
      type: "object",
      required: ["query"],
      properties: { query: { type: "string" } },
    },
    canonical_output_schema: {
      type: "object",
      required: ["findings"],
      properties: { findings: { type: "array" } },
    },
    providers: ["mock"],
    side_effecting: false,
    default_permission: "enabled",
    reconcilable,
  });
}

function registryWith(providers: CapabilityProvider[]): CapabilityRegistryService {
  return new CapabilityRegistryService(
    database,
    new GovernanceService(database, new OrgRegistry({ roles: [], agents: [] })),
    providers,
  );
}

function capability(reconcilable: Reconcilable) {
  return CapabilitySchema.parse({
    name: CAP,
    workspace_id: WORKSPACE_ID,
    description: "A side effect used to exercise the reconcilability gates.",
    tool_name: "mock.side_effect",
    canonical_input_schema: {
      type: "object",
      required: ["message"],
      properties: { message: { type: "string" } },
    },
    canonical_output_schema: {
      type: "object",
      required: ["provider", "effect", "handle"],
      properties: {
        provider: { type: "string" },
        effect: { type: "string" },
        handle: { type: "string" },
      },
    },
    providers: ["mock.side_effect"],
    side_effecting: true,
    credential_handle_required: true,
    credential_handle: HANDLE,
    default_permission: "enabled",
    reconcilable,
  });
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "openmao-reconcilable-"));
  database = new Database(join(tmpRoot, "openmao.sqlite3"));
  database.initialize();
  new SpineService(database).initDemoWorkspace();
  work = new WorkService(database);
  seq = 0;
  new WorkerIdentityStore(database).save(
    WorkerIdentitySchema.parse({
      id: WORKER_ID,
      workspace_id: WORKSPACE_ID,
      name: "Reconcilability Test Worker",
      runtime: "test",
      allowed_capabilities: [CAP, READ_CAP],
    }),
  );
});

afterEach(() => {
  database.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("ADR-0013 reconcilability", () => {
  it("defaults to the most restrictive level, so an omitted field cannot buy autonomy", () => {
    const parsed = CapabilitySchema.parse({
      name: "omits.the.field",
      workspace_id: WORKSPACE_ID,
      description: "Predates the field.",
      canonical_input_schema: { type: "object" },
      canonical_output_schema: { type: "object" },
    });
    expect(parsed.reconcilable).toBe("none");
  });

  describe("register() gates the declaration", () => {
    it("rejects a declaration the bound provider cannot support", () => {
      const registry = registryWith([new DownstreamStateProvider()]);
      expect(() => registry.register(capability("receipt"))).toThrow(CapabilityRegistryError);
      expect(() => registry.register(capability("receipt"))).toThrow(/at most 'downstream_state'/);
    });

    it("rejects a level above none whose bound provider implements no observeEffect", () => {
      // The declaration is otherwise satisfiable — the provider says "receipt" — but without a
      // read-back the enum is decorative and slice 3 would have nothing to query.
      const registry = registryWith([new DeclaresWithoutObserving()]);
      expect(() => registry.register(capability("receipt"))).toThrow(/no observeEffect/);
    });

    it("treats a provider that predates the field as none rather than trusting it", () => {
      const registry = registryWith([new LegacyProvider()]);
      expect(() => registry.register(capability("downstream_state"))).toThrow(/at most 'none'/);
    });

    it("accepts a declaration the bound provider does support", () => {
      const registry = registryWith([new MockSideEffectProvider({ [HANDLE]: "secret" })]);
      expect(registry.register(capability("receipt")).reconcilable).toBe("receipt");
    });

    it("records an unbound declaration provisionally instead of validating it vacuously", () => {
      // No provider bound: legitimate registration-before-binding, and the credential-free
      // default process. A min over an empty set must not silently confirm the claim — the
      // invoke-time gate is the unconditional enforcement point.
      const registry = registryWith([]);
      expect(registry.register(capability("receipt")).reconcilable).toBe("receipt");
    });
  });

  describe("invoke gates reality", () => {
    it("forces the approval gate when a weaker provider is bound after a clean registration", async () => {
      // Register against a provider that supports the declaration...
      registryWith([new MockSideEffectProvider({ [HANDLE]: "secret" })]).register(
        capability("receipt"),
      );

      // ...then serve the call from a registry whose bound provider cannot reconcile at all.
      // Late binding must not be able to widen what registered clean.
      const weakened = registryWith([new LegacyProvider()]);
      const call = await invokeCall(weakened);
      expect(call.decision.outcome).toBe("require_approval");
      expect(call.decision.reason).toMatch(/Unreconcilable side-effecting/);
    });

    it("emits capability.reconcilable_mismatch when bound reality is weaker than the record", async () => {
      // Registered clean at "receipt", then served by a provider that manages only
      // "downstream_state". Weaker than declared, so the diagnosis pass must get a signal — and
      // because this is a read, nothing forces the approval gate, so the call really does reach
      // the execute choke point where the signal is emitted.
      registryWith([new ReadProvider("receipt")]).register(readCapability("receipt"));
      const weakened = registryWith([new ReadProvider("downstream_state")]);

      const invocation = await invokeRead(weakened);
      expect(invocation.result?.status).toBe("ok");

      const mismatches = new EventStore(database)
        .listForWorkspace(WORKSPACE_ID)
        .filter((event) => event.kind === "capability.reconcilable_mismatch");
      expect(mismatches).toHaveLength(1);
      expect(mismatches[0]?.payload.data).toMatchObject({
        declared: "receipt",
        effective: "downstream_state",
        call_id: invocation.call.id,
      });
    });

    it("stays silent when bound reality still matches the declaration", async () => {
      // The event must mean "gated more strictly than the record claims" and nothing else,
      // or the diagnosis pass drowns in noise from healthy calls.
      registryWith([new ReadProvider("receipt")]).register(readCapability("receipt"));
      const healthy = registryWith([new ReadProvider("receipt")]);
      await invokeRead(healthy);

      const mismatches = new EventStore(database)
        .listForWorkspace(WORKSPACE_ID)
        .filter((event) => event.kind === "capability.reconcilable_mismatch");
      expect(mismatches).toHaveLength(0);
    });
  });
});

// A capability call needs a real run and a bounded envelope granting the capability, so that the
// gate under test is the reconcilability one and not an envelope refusal.
function seedEnvelopeFor(capabilityName: string): {
  runId: string;
  taskId: string;
  suffix: string;
} {
  seq += 1;
  const suffix = String(seq).padStart(32, "0");
  const runId = `run_${suffix}`;
  const taskId = `task_${suffix}`;
  const item = work.createWork({
    id: `work_${suffix}`,
    workspace_id: WORKSPACE_ID,
    title: "Reconcilable work",
    objective: "reconcilability gate test",
    owner: WORKER_ID,
    reviewer: "human",
    actor: "operator:test",
    idempotency_key: `work_${suffix}:created`,
  });
  work.assignWork({
    workspace_id: WORKSPACE_ID,
    work_item_id: item.id,
    owner: WORKER_ID,
    reviewer: "human",
    actor: "operator:test",
    idempotency_key: `work_${suffix}:assigned`,
  });
  work.ensureExternalRun({
    id: runId,
    workspace_id: WORKSPACE_ID,
    active_node: "reconcilable",
    actor: "operator:test",
  });
  work.createBoundedEnvelope({
    id: `envelope_${suffix}`,
    workspace_id: WORKSPACE_ID,
    work_item_id: item.id,
    run_id: runId,
    task_envelope_id: taskId,
    worker_id: WORKER_ID,
    issued_by: { actor_type: "operator", actor_id: "operator:test", display_name: null },
    allowed_capabilities: [capabilityName],
    resource_grants: {},
    idempotency_key: `envelope_${suffix}:created`,
  });
  return { runId, taskId, suffix };
}

// Invoke the read capability: not side-effecting, so no approval gate stands between the call
// and the execute choke point where the mismatch signal is emitted.
async function invokeRead(registry: CapabilityRegistryService) {
  const { runId, taskId, suffix } = seedEnvelopeFor(READ_CAP);
  return await registry.invoke(
    CapabilityCallSchema.parse({
      id: `capcall_${suffix}`,
      workspace_id: WORKSPACE_ID,
      run_id: runId,
      task_id: taskId,
      capability_name: READ_CAP,
      provider: "mock",
      input: { query: "hello" },
      requested_by: WORKER_ID,
      external_actor: { actor_type: "worker", actor_id: WORKER_ID, display_name: "Test Worker" },
      side_effecting: false,
      risk_level: "low",
      idempotency_key: `reconcilable:read:${suffix}`,
    }),
  );
}

// Invoke the side-effecting capability.
async function invokeCall(registry: CapabilityRegistryService) {
  const { runId, taskId, suffix } = seedEnvelopeFor(CAP);
  return await registry.invoke(
    CapabilityCallSchema.parse({
      id: `capcall_${suffix}`,
      workspace_id: WORKSPACE_ID,
      run_id: runId,
      task_id: taskId,
      capability_name: CAP,
      provider: "mock.side_effect",
      input: { message: "hello" },
      requested_by: WORKER_ID,
      external_actor: { actor_type: "worker", actor_id: WORKER_ID, display_name: "Test Worker" },
      credential_handle: HANDLE,
      side_effecting: true,
      risk_level: "low",
      idempotency_key: `reconcilable:call:${suffix}`,
    }),
  );
}
