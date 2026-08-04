import {
  type CapabilityCall,
  type CapabilityResult,
  CapabilityResultSchema,
  newId,
  type Reconcilable,
  utcNow,
} from "../contracts/index.js";
import {
  type CredentialBroker,
  isCredentialBroker,
  StaticCredentialBroker,
} from "../security/credential-broker.js";

// ADR-0013: one externally-observable effect found by the discovery direction.
export type ObservedEffect = {
  // The gateway-minted correlation marker recovered from the effect, when the provider can
  // recover one. Null means the effect carries no marker we can match a claim against — which
  // is what an effect-without-claim looks like before it is classified.
  marker: string | null;
  observed_at: string;
  detail?: Record<string, unknown>;
};

// Bounded window for the discovery direction, with cursor/watermark semantics.
export type EffectWindow = {
  workspace_id: string;
  since: string;
  until?: string;
  cursor?: string | null;
};

// ADR-0013: tri-state, never a bare null. Conflating "the provider was down" with "the effect
// does not exist" would let an outage manufacture false liveness-gap violations, and conflating
// single with multiple observations would hide a planted or duplicated effect carrying a copied
// marker — so `observed` carries its multiplicity.
export type EffectObservation =
  | { status: "observed"; effects: ObservedEffect[] }
  | { status: "absent" }
  | { status: "unobservable"; reason: string };

export type CapabilityProvider = {
  name: string;
  // Providers that perform real external side effects declare this so the
  // gateway can require the side-effect/approval gate even if a capability is
  // misregistered as non-side-effecting.
  sideEffecting?: boolean;
  // ADR-0013. Absent collapses to "none": a provider predating the field is automatically
  // most-restricted, never silently trusted — the same rule as the intrinsic `sideEffecting`
  // declaration.
  reconcilable?: Reconcilable;
  // Outcome direction (claim -> effect): evidence for one known call. Detects
  // intent-without-outcome. REQUIRED for any declared level above "none" — a declaration
  // without it is decorative, and registration treats it as a mismatch.
  observeEffect?(call: CapabilityCall): Promise<EffectObservation>;
  // Discovery direction (effect -> claim): enumerate effects in a bounded window so the
  // reconciliation pass can find effects no gateway record explains. This is the ONLY operation
  // that can detect effect-without-claim, the breach class. Optional per provider, but its
  // absence makes the capability discovery-blind and must be reported as a named coverage gap
  // rather than silently read as "no breaches". The pass that consumes it is slice 3.
  listEffects?(window: EffectWindow): Promise<ObservedEffect[]>;
  execute(call: CapabilityCall): CapabilityResult | Promise<CapabilityResult>;
};

export class MockProvider implements CapabilityProvider {
  readonly name = "mock";
  readonly executedCallIds: string[] = [];

  constructor(private readonly seededFindings: Record<string, string[]> = {}) {}

  execute(call: CapabilityCall): CapabilityResult {
    this.executedCallIds.push(call.id);
    const query = String(call.input.query ?? "").toLowerCase();
    const findings = this.seededFindings[query] ?? [
      "Use explicit assumptions.",
      "Prefer short, reliable artifacts.",
    ];

    return CapabilityResultSchema.parse({
      id: newId("capresult"),
      workspace_id: call.workspace_id,
      run_id: call.run_id,
      call_id: call.id,
      status: "ok",
      output: { findings },
    });
  }
}

export class MockSideEffectProvider implements CapabilityProvider {
  readonly name = "mock.side_effect";
  readonly sideEffecting = true;
  // ADR-0013: this mock records the gateway-minted call id of every effect it produces, so it
  // can answer the outcome direction exactly — which is what `receipt` means. The declaration
  // is backed by a real `observeEffect` below rather than being decorative.
  readonly reconcilable = "receipt" as const;
  readonly executedCallIds: string[] = [];
  private readonly broker: CredentialBroker;

  constructor(credentials: CredentialBroker | Record<string, string> = {}) {
    this.broker = isCredentialBroker(credentials)
      ? credentials
      : new StaticCredentialBroker(credentials);
  }

  async execute(call: CapabilityCall): Promise<CapabilityResult> {
    const handle = call.credential_handle;
    if (!handle) {
      throw new Error("mock side-effect requires a credential handle");
    }
    // Resolve the secret through the broker to prove the credential is
    // available, but never emit it: only the non-secret handle leaves here.
    const secret = await this.broker.resolve(handle);
    if (!secret) {
      throw new Error("mock side-effect credential handle is not available");
    }

    this.executedCallIds.push(call.id);
    return CapabilityResultSchema.parse({
      id: newId("capresult"),
      workspace_id: call.workspace_id,
      run_id: call.run_id,
      call_id: call.id,
      status: "ok",
      output: {
        provider: this.name,
        effect: "recorded",
        handle,
      },
    });
  }

  // Outcome direction: was there an effect for THIS call? Multiplicity is reported honestly
  // rather than collapsed, so a duplicated effect is visible instead of reading as one.
  async observeEffect(call: CapabilityCall): Promise<EffectObservation> {
    const matches = this.executedCallIds.filter((id) => id === call.id);
    if (matches.length === 0) {
      return { status: "absent" };
    }
    return {
      status: "observed",
      effects: matches.map(() => ({
        marker: `omao:${call.workspace_id}:${call.id}`,
        observed_at: utcNow(),
        detail: { provider: this.name },
      })),
    };
  }
}

export class MCPProvider implements CapabilityProvider {
  readonly name = "mcp";

  execute(_call: CapabilityCall): CapabilityResult {
    throw new Error("real MCP provider execution is deferred beyond v0");
  }
}
