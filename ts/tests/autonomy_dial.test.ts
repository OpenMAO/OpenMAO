import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  CapabilityCallSchema,
  CapabilitySchema,
  OrganizationSchema,
  type PolicyOutcome,
  WorkspaceSchema,
} from "../src/contracts/index.js";
import { GovernanceService } from "../src/governance/index.js";
import { OrgRegistry } from "../src/org/index.js";
import { Database, OrganizationStore, WorkspaceStore } from "../src/persistence/index.js";

const fixturePath = new URL("../../tests/fixtures/canonical_v0.json", import.meta.url);

async function loadFixture(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(fixturePath, "utf8")) as Record<string, unknown>;
}

// Decide a single granted, enabled capability call at a given autonomy level
// (or `null` to record no organization at all, exercising the safe default).
// Each call runs in its own isolated in-memory database.
async function outcomeFor(
  level: "advisory" | "supervised" | "bounded" | null,
  callOverrides: Record<string, unknown> = {},
  permission: "enabled" | "approval_required" | "disabled" = "enabled",
  capabilityRisk: "low" | "medium" | "high" = "low",
  // ADR-0013: these cases exercise the AUTONOMY DIAL, so they declare a reconcilable
  // capability by default. Leaving this at the schema default ("none") would make every
  // side-effecting case below gate on the unreconcilable-forcing rule instead of on the
  // dial, and the dial would stop being what is under test. The forcing rule has its own
  // cases at the bottom of this file.
  reconcilable: "receipt" | "downstream_state" | "none" = "receipt",
): Promise<PolicyOutcome> {
  const database = new Database(":memory:");
  database.initialize();
  try {
    const fixture = await loadFixture();
    const workspace = WorkspaceSchema.parse(fixture.workspace);
    new WorkspaceStore(database).save(workspace);
    if (level) {
      new OrganizationStore(database).save(
        OrganizationSchema.parse({
          id: "org_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          workspace_id: workspace.id,
          name: "Dial Test Org",
          mission: "Exercise the autonomy dial.",
          autonomy_level: level,
        }),
      );
    }
    const registry = new OrgRegistry({
      roles: fixture.roles as unknown[],
      agents: fixture.agents as unknown[],
    });
    const governance = new GovernanceService(database, registry);
    const capability = CapabilitySchema.parse({
      ...(fixture.capability as Record<string, unknown>),
      default_permission: permission,
      risk_level: capabilityRisk,
      reconcilable,
    });
    const call = CapabilityCallSchema.parse({
      ...(fixture.capability_call as Record<string, unknown>),
      workspace_id: workspace.id,
      ...callOverrides,
    });
    return governance.decideCapability(call, capability).outcome;
  } finally {
    database.close();
  }
}

describe("autonomy dial", () => {
  it("advisory gates any side effect or non-low-risk call, but allows low-risk reads", async () => {
    expect(await outcomeFor("advisory", { side_effecting: true, risk_level: "low" })).toBe(
      "require_approval",
    );
    expect(await outcomeFor("advisory", { risk_level: "medium" })).toBe("require_approval");
    expect(await outcomeFor("advisory", {})).toBe("allow"); // fixture call: non-side-effecting, low risk
  });

  it("supervised gates side effects and high risk, but allows medium-risk reads", async () => {
    expect(await outcomeFor("supervised", { side_effecting: true, risk_level: "low" })).toBe(
      "require_approval",
    );
    expect(await outcomeFor("supervised", { risk_level: "high" })).toBe("require_approval");
    expect(await outcomeFor("supervised", { risk_level: "medium" })).toBe("allow");
    expect(await outcomeFor("supervised", {})).toBe("allow");
  });

  it("bounded allows side effects and medium risk, gating only high risk", async () => {
    expect(await outcomeFor("bounded", { side_effecting: true, risk_level: "low" })).toBe("allow");
    expect(await outcomeFor("bounded", { risk_level: "medium" })).toBe("allow");
    expect(await outcomeFor("bounded", { risk_level: "high" })).toBe("require_approval");
  });

  it("widens what the organization may do as autonomy is earned (same side-effecting call)", async () => {
    const sideEffecting = { side_effecting: true, risk_level: "low" };
    expect(await outcomeFor("advisory", sideEffecting)).toBe("require_approval");
    expect(await outcomeFor("supervised", sideEffecting)).toBe("require_approval");
    expect(await outcomeFor("bounded", sideEffecting)).toBe("allow");
  });

  // ADR-0013 §5: an unreconcilable SIDE EFFECT is gated hardest, and the autonomy dial
  // cannot widen it. This is the one rule that sits above the `bounded` early return.
  it("forces the gate on an unreconcilable side effect even at bounded — the dial cannot widen it", async () => {
    const sideEffecting = { side_effecting: true, risk_level: "low" };
    expect(await outcomeFor("bounded", sideEffecting, "enabled", "low", "none")).toBe(
      "require_approval",
    );
    // Same call, same level, only the declared reconcilability differs: with evidence we can
    // reconcile against, bounded still allows it. This is the pair that proves the new rule
    // is doing the work rather than the dial having quietly tightened.
    expect(await outcomeFor("bounded", sideEffecting, "enabled", "low", "downstream_state")).toBe(
      "allow",
    );
    expect(await outcomeFor("bounded", sideEffecting, "enabled", "low", "receipt")).toBe("allow");
  });

  it("does not force the gate on an unreconcilable READ — the omission threat is side effects", async () => {
    // Scoped deliberately: forcing synchronous approval on every unreconcilable lookup would
    // make the default local mode unusable, and a read is not the omission this ADR closes.
    expect(await outcomeFor("bounded", { risk_level: "low" }, "enabled", "low", "none")).toBe(
      "allow",
    );
  });

  it("an explicit approval_required capability stays gated even at the loosest level", async () => {
    expect(await outcomeFor("bounded", {}, "approval_required")).toBe("require_approval");
  });

  it("treats the capability's declared risk as authoritative — a caller cannot under-report to dodge the dial", async () => {
    // The capability is declared high-risk; the call under-reports as low. Effective risk
    // is high, so it is gated even at the most permissive (bounded) level.
    expect(await outcomeFor("bounded", { risk_level: "low" }, "enabled", "high")).toBe(
      "require_approval",
    );
  });

  it("defaults a new organization to advisory — the charter's posture for unproven orgs", () => {
    const org = OrganizationSchema.parse({
      id: "org_cccccccccccccccccccccccccccccccc",
      workspace_id: "ws_cccccccccccccccccccccccccccccccc",
      name: "Unspecified",
      mission: "No explicit autonomy level set.",
    });
    expect(org.autonomy_level).toBe("advisory");
  });

  it("falls back to advisory (fail closed) when no organization is recorded", async () => {
    expect(await outcomeFor(null, { side_effecting: true, risk_level: "low" })).toBe(
      "require_approval",
    );
    expect(await outcomeFor(null, { risk_level: "medium" })).toBe("require_approval");
    expect(await outcomeFor(null, {})).toBe("allow"); // a low-risk read is still allowed
  });

  it("binds to the workspace's default organization when several exist", async () => {
    // The default org is advisory; a looser bounded org sorts first by id. Advisory must
    // win — policy binds to the workspace's designated default, not the id-first pick.
    expect(
      await multiOrgOutcome({
        orgs: [
          { id: "org_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", level: "bounded" },
          { id: "org_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", level: "advisory" },
        ],
        defaultOrgId: "org_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      }),
    ).toBe("require_approval");
  });

  it("fails closed to the tightest level when several orgs exist with no resolvable default", async () => {
    // bounded would allow the side-effecting call; supervised (the tightest here) gates it.
    expect(
      await multiOrgOutcome({
        orgs: [
          { id: "org_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", level: "bounded" },
          { id: "org_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", level: "supervised" },
        ],
        defaultOrgId: null,
      }),
    ).toBe("require_approval");
  });
});

// Resolve the dial for a workspace that has several organizations, exercising the
// default-org binding and the fail-closed tightest-level fallback.
async function multiOrgOutcome(opts: {
  orgs: Array<{ id: string; level: "advisory" | "supervised" | "bounded" }>;
  defaultOrgId: string | null;
}): Promise<PolicyOutcome> {
  const database = new Database(":memory:");
  database.initialize();
  try {
    const fixture = await loadFixture();
    const base = WorkspaceSchema.parse(fixture.workspace);
    new WorkspaceStore(database).save(
      WorkspaceSchema.parse({ ...base, default_org_id: opts.defaultOrgId }),
    );
    const orgStore = new OrganizationStore(database);
    for (const org of opts.orgs) {
      orgStore.save(
        OrganizationSchema.parse({
          id: org.id,
          workspace_id: base.id,
          name: `Org ${org.id.slice(4, 8)}`,
          mission: "Exercise multi-org dial resolution.",
          autonomy_level: org.level,
        }),
      );
    }
    const governance = new GovernanceService(
      database,
      new OrgRegistry({ roles: fixture.roles as unknown[], agents: fixture.agents as unknown[] }),
    );
    const capability = CapabilitySchema.parse({
      ...(fixture.capability as Record<string, unknown>),
      default_permission: "enabled",
    });
    const call = CapabilityCallSchema.parse({
      ...(fixture.capability_call as Record<string, unknown>),
      workspace_id: base.id,
      side_effecting: true,
      risk_level: "low",
    });
    return governance.decideCapability(call, capability).outcome;
  } finally {
    database.close();
  }
}
