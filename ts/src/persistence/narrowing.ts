import {
  type GrantSuspension,
  GrantSuspensionSchema,
  type NarrowingPolicy,
  NarrowingPolicySchema,
} from "../contracts/index.js";
import type { Database } from "./database.js";
import { dumpJson, jsonEqual } from "./serialization.js";

type PayloadRow = { payload_json: string };

export class GrantSuspensionConflictError extends Error {}

/**
 * Persists the per-workspace operator-ratified narrowing policy (#120). Absence of a row means
 * narrowing is OFF: the scan refuses to act on thresholds no human ratified. Each ratification
 * is an explicit operator action and replaces the previous row.
 */
export class NarrowingPolicyStore {
  constructor(private readonly database: Database) {}

  get(workspaceId: string): NarrowingPolicy | null {
    const row = this.database.connection
      .prepare("SELECT payload_json FROM narrowing_policies WHERE workspace_id = ?")
      .get(workspaceId) as PayloadRow | undefined;
    return row ? NarrowingPolicySchema.parse(JSON.parse(row.payload_json)) : null;
  }

  save(policy: NarrowingPolicy): NarrowingPolicy {
    const parsed = NarrowingPolicySchema.parse(policy);
    return this.database.transaction(() => {
      this.database.connection
        .prepare(
          `INSERT INTO narrowing_policies (workspace_id, payload_json) VALUES (?, ?)
           ON CONFLICT(workspace_id) DO UPDATE SET payload_json = excluded.payload_json`,
        )
        .run(parsed.workspace_id, dumpJson(parsed));
      return parsed;
    });
  }
}

/**
 * Persists `GrantSuspension` records — evidence-triggered suspensions of a single capability
 * grant for a single actor (#120). New suspensions are always `active`; `lift` drives the
 * one-way active → lifted transition (a lifted suspension can never be re-activated). The
 * partial unique index guarantees at most one active suspension per (workspace, actor,
 * capability), and `findActive` is the call-time gateway lookup — always a fresh indexed
 * query, never cached.
 */
export class GrantSuspensionStore {
  constructor(private readonly database: Database) {}

  save(suspension: GrantSuspension): GrantSuspension {
    const parsed = GrantSuspensionSchema.parse(suspension);
    if (parsed.status !== "active") {
      throw new GrantSuspensionConflictError("new grant suspensions must be saved as active");
    }
    return this.database.transaction(() => {
      const existing = this.get(parsed.id);
      if (existing) {
        if (jsonEqual(existing, parsed)) {
          return existing;
        }
        throw new GrantSuspensionConflictError(`grant suspension already exists: ${parsed.id}`);
      }
      const activeDuplicate = this.findActive(
        parsed.workspace_id,
        parsed.actor_id,
        parsed.capability_name,
      );
      if (activeDuplicate) {
        throw new GrantSuspensionConflictError(
          `an active grant suspension already exists for ${parsed.actor_id}/${parsed.capability_name}: ${activeDuplicate.id}`,
        );
      }
      this.database.connection
        .prepare(
          `INSERT INTO grant_suspensions (
            id, workspace_id, actor_id, capability_name, status, payload_json
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          parsed.id,
          parsed.workspace_id,
          parsed.actor_id,
          parsed.capability_name,
          parsed.status,
          dumpJson(parsed),
        );
      return parsed;
    });
  }

  get(suspensionId: string): GrantSuspension | null {
    const row = this.database.connection
      .prepare("SELECT payload_json FROM grant_suspensions WHERE id = ?")
      .get(suspensionId) as PayloadRow | undefined;
    return row ? GrantSuspensionSchema.parse(JSON.parse(row.payload_json)) : null;
  }

  findActive(workspaceId: string, actorId: string, capabilityName: string): GrantSuspension | null {
    const row = this.database.connection
      .prepare(
        `SELECT payload_json FROM grant_suspensions
         WHERE workspace_id = ? AND actor_id = ? AND capability_name = ? AND status = 'active'`,
      )
      .get(workspaceId, actorId, capabilityName) as PayloadRow | undefined;
    return row ? GrantSuspensionSchema.parse(JSON.parse(row.payload_json)) : null;
  }

  // Lifted suspensions for a single (workspace, actor, capability). The narrowing scan reads
  // these to drop already-adjudicated evidence (#120): once a human lifts a suspension, the
  // events that justified it can never re-suspend the same grant, so a single new failure
  // cannot immediately undo the lift.
  listLifted(workspaceId: string, actorId: string, capabilityName: string): GrantSuspension[] {
    const rows = this.database.connection
      .prepare(
        `SELECT payload_json FROM grant_suspensions
         WHERE workspace_id = ? AND actor_id = ? AND capability_name = ? AND status = 'lifted'
         ORDER BY id`,
      )
      .all(workspaceId, actorId, capabilityName) as PayloadRow[];
    return rows.map((row) => GrantSuspensionSchema.parse(JSON.parse(row.payload_json)));
  }

  listForWorkspace(workspaceId: string): GrantSuspension[] {
    const rows = this.database.connection
      .prepare("SELECT payload_json FROM grant_suspensions WHERE workspace_id = ? ORDER BY id")
      .all(workspaceId) as PayloadRow[];
    return rows.map((row) => GrantSuspensionSchema.parse(JSON.parse(row.payload_json)));
  }

  lift(
    suspensionId: string,
    options: { lifted_by: string; lift_note: string | null; lifted_at: string },
  ): GrantSuspension {
    return this.database.transaction(() => {
      const current = this.get(suspensionId);
      if (!current) {
        throw new GrantSuspensionConflictError(`grant suspension not found: ${suspensionId}`);
      }
      if (current.status === "lifted") {
        return current;
      }
      const updated = GrantSuspensionSchema.parse({
        ...current,
        status: "lifted",
        lifted_at: options.lifted_at,
        lifted_by: options.lifted_by,
        lift_note: options.lift_note,
      });
      this.database.connection
        .prepare("UPDATE grant_suspensions SET status = ?, payload_json = ? WHERE id = ?")
        .run(updated.status, dumpJson(updated), updated.id);
      return updated;
    });
  }
}
