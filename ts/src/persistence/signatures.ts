import type { Database } from "./database.js";

/**
 * Append-style store for signed governance decisions (ADR-0007 execution). One row per
 * (workspace, object_type, object_id, signer_key_id): the unique index is the at-most-once
 * analogue of the approvals CAS, so recording the same signature twice is a no-op, while a
 * second signer on the same object appends a row (quorum, #94, for free later).
 */

export type GovernanceSignature = {
  id: string;
  workspace_id: string;
  object_type: string;
  object_id: string;
  signer_key_id: string;
  signer_principal_id: string;
  signed_bytes: string;
  signature: string;
  domain_tag: string;
  signed_at: string;
};

type GovernanceSignatureRow = GovernanceSignature;

/** Same signer on the same object with DIFFERENT bytes or signature is a conflict, never a retry. */
export class GovernanceSignatureConflictError extends Error {}

export class GovernanceSignatureStore {
  constructor(private readonly database: Database) {}

  record(input: GovernanceSignature): GovernanceSignature {
    // Single atomic statement: the unique index is consulted by the INSERT itself, so two
    // connections racing the same 4-tuple can never both observe "no row" and collide on a
    // raw SQLITE_CONSTRAINT. The ON CONFLICT target is exactly the once-per-signer tuple, so
    // ONLY that conflict is suppressed — a NOT NULL, primary-key, FK, or CHECK violation
    // still raises, instead of being silently swallowed the way INSERT OR IGNORE would.
    this.database.connection
      .prepare(
        `INSERT INTO governance_signatures
           (id, workspace_id, object_type, object_id, signer_key_id, signer_principal_id,
            signed_bytes, signature, domain_tag, signed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(workspace_id, object_type, object_id, signer_key_id) DO NOTHING`,
      )
      .run(
        input.id,
        input.workspace_id,
        input.object_type,
        input.object_id,
        input.signer_key_id,
        input.signer_principal_id,
        input.signed_bytes,
        input.signature,
        input.domain_tag,
        input.signed_at,
      );
    const stored = this.database.connection
      .prepare(
        `SELECT id, workspace_id, object_type, object_id, signer_key_id, signer_principal_id,
                signed_bytes, signature, domain_tag, signed_at
         FROM governance_signatures
         WHERE workspace_id = ? AND object_type = ? AND object_id = ? AND signer_key_id = ?`,
      )
      .get(input.workspace_id, input.object_type, input.object_id, input.signer_key_id) as
      | GovernanceSignatureRow
      | undefined;
    if (!stored) {
      throw new Error("governance signature insert did not produce a readable row");
    }
    // An identical replay is a no-op returning the stored row — but "identical" means the
    // whole record, not just the signed bytes. `id` is exempt: it is the row's own surrogate
    // (the replay test's fresh id must not make a true replay a conflict), and the stored id
    // is what callers get back. The tuple columns match by construction of the lookup; any
    // difference in the remaining payload — who signed, under which domain tag, when, what
    // bytes, which signature — is a conflict, never a silent reuse of the old row.
    if (
      stored.signer_principal_id === input.signer_principal_id &&
      stored.signed_bytes === input.signed_bytes &&
      stored.signature === input.signature &&
      stored.domain_tag === input.domain_tag &&
      stored.signed_at === input.signed_at
    ) {
      return { ...stored };
    }
    throw new GovernanceSignatureConflictError(
      `conflicting governance signature for ${input.object_type}:${input.object_id} by key ${input.signer_key_id}`,
    );
  }

  forObject(workspaceId: string, objectType: string, objectId: string): GovernanceSignature[] {
    const rows = this.database.connection
      .prepare(
        `SELECT id, workspace_id, object_type, object_id, signer_key_id, signer_principal_id,
                signed_bytes, signature, domain_tag, signed_at
         FROM governance_signatures
         WHERE workspace_id = ? AND object_type = ? AND object_id = ?
         ORDER BY signed_at, id`,
      )
      .all(workspaceId, objectType, objectId) as GovernanceSignatureRow[];
    return rows.map((row) => ({ ...row }));
  }

  listByType(workspaceId: string, objectType: string): GovernanceSignature[] {
    const rows = this.database.connection
      .prepare(
        `SELECT id, workspace_id, object_type, object_id, signer_key_id, signer_principal_id,
                signed_bytes, signature, domain_tag, signed_at
         FROM governance_signatures
         WHERE workspace_id = ? AND object_type = ?
         ORDER BY signed_at, id`,
      )
      .all(workspaceId, objectType) as GovernanceSignatureRow[];
    return rows.map((row) => ({ ...row }));
  }
}
