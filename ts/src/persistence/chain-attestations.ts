import type { Database } from "./database.js";

/**
 * Signed chain-head attestations (M6): the anchor outside the reconstructed
 * event log that `EventStore.verifyChain`'s own comment names as the missing
 * half of truncation detection. verifyChain recomputes hashes from the events
 * it can see, so deleting the newest N events leaves a chain that is perfectly
 * self-consistent and silently shorter. An attestation pins (head_sequence,
 * head_hash, event_count) under an operator signature, so a later verification
 * can compare the surviving chain head against a value that is NOT recomputed
 * from the surviving events.
 *
 * NAMING: this module and its table are deliberately named
 * "chain head attestations" end to end. `checkpoints.ts` (table `checkpoints`,
 * `CheckpointStore`) already exists and holds run/node/state resumption
 * checkpoints — a different concept with a different lifecycle (mutable
 * resumption state vs append-only signed anchors). The two never share a name
 * fragment, a table, or a type, so neither imports the other by mistake.
 *
 * HONEST SCOPE (truth-in-status): an attestation stored in the SAME database
 * as the events does not make truncation impossible. An attacker who can
 * delete events directly in the file can delete attestation rows too — the
 * append-only triggers guard the code path, not the file. This mechanism
 * detects truncation ONLY relative to an attestation that survives or was
 * exported elsewhere. Tests and CLI output must never claim more.
 */

export type ChainHeadAttestation = {
  id: string;
  workspace_id: string;
  head_sequence: number;
  head_hash: string;
  event_count: number;
  /** Self-chain: the prior attestation for this workspace, null for the first. */
  previous_attestation_id: string | null;
  signer_key_id: string;
  signer_principal_id: string;
  /** Reference to the governance_signatures row carrying the exact signed bytes. */
  signature_id: string;
  /**
   * NOT the wall-clock moment of attesting: the stored timestamp of the head
   * event this attestation covers. Every field of the signed body is derived
   * from stored state so a replay at the same head is byte-identical — a
   * caller-influenced clock never enters the signed bytes.
   */
  attested_at: string;
};

type ChainHeadAttestationRow = ChainHeadAttestation;

/** Same position attested with DIFFERENT content is a conflict, never a retry. */
export class ChainHeadAttestationConflictError extends Error {}

export class ChainHeadAttestationStore {
  constructor(private readonly database: Database) {}

  record(input: ChainHeadAttestation): ChainHeadAttestation {
    // Single atomic statement in the GovernanceSignatureStore style: the
    // unique index on (workspace_id, head_sequence) is consulted by the INSERT
    // itself, so two writers racing the same position can never both observe
    // "no row". ONLY that conflict is suppressed — a NOT NULL, primary-key,
    // FK, or CHECK violation still raises.
    this.database.connection
      .prepare(
        `INSERT INTO chain_head_attestations
           (id, workspace_id, head_sequence, head_hash, event_count,
            previous_attestation_id, signer_key_id, signer_principal_id,
            signature_id, attested_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(workspace_id, head_sequence) DO NOTHING`,
      )
      .run(
        input.id,
        input.workspace_id,
        input.head_sequence,
        input.head_hash,
        input.event_count,
        input.previous_attestation_id,
        input.signer_key_id,
        input.signer_principal_id,
        input.signature_id,
        input.attested_at,
      );
    const stored = this.atSequence(input.workspace_id, input.head_sequence);
    if (!stored) {
      throw new Error("chain head attestation insert did not produce a readable row");
    }
    // An identical replay is a no-op returning the stored row — but
    // "identical" means the whole record except the surrogate id (the same
    // position re-attested in a retry gets a fresh id). Any difference in the
    // attested facts — head hash, event count, self-chain link, signer,
    // signature, or the stored head time — is a conflict, never a silent
    // reuse of the old row.
    if (
      stored.head_hash === input.head_hash &&
      stored.event_count === input.event_count &&
      stored.previous_attestation_id === input.previous_attestation_id &&
      stored.signer_key_id === input.signer_key_id &&
      stored.signer_principal_id === input.signer_principal_id &&
      stored.signature_id === input.signature_id &&
      stored.attested_at === input.attested_at
    ) {
      return { ...stored };
    }
    throw new ChainHeadAttestationConflictError(
      `conflicting chain head attestation for workspace ${input.workspace_id} at sequence ${input.head_sequence}`,
    );
  }

  /** The newest surviving attestation, or null when none (or the table is absent — see below). */
  latestForWorkspace(workspaceId: string): ChainHeadAttestation | null {
    if (!chainHeadAttestationTableExists(this.database)) {
      return null;
    }
    const row = this.database.connection
      .prepare(
        `SELECT id, workspace_id, head_sequence, head_hash, event_count,
                previous_attestation_id, signer_key_id, signer_principal_id,
                signature_id, attested_at
         FROM chain_head_attestations
         WHERE workspace_id = ?
         ORDER BY head_sequence DESC
         LIMIT 1`,
      )
      .get(workspaceId) as ChainHeadAttestationRow | undefined;
    return row ? { ...row } : null;
  }

  atSequence(workspaceId: string, headSequence: number): ChainHeadAttestation | null {
    const row = this.database.connection
      .prepare(
        `SELECT id, workspace_id, head_sequence, head_hash, event_count,
                previous_attestation_id, signer_key_id, signer_principal_id,
                signature_id, attested_at
         FROM chain_head_attestations
         WHERE workspace_id = ? AND head_sequence = ?`,
      )
      .get(workspaceId, headSequence) as ChainHeadAttestationRow | undefined;
    return row ? { ...row } : null;
  }

  listForWorkspace(workspaceId: string): ChainHeadAttestation[] {
    const rows = this.database.connection
      .prepare(
        `SELECT id, workspace_id, head_sequence, head_hash, event_count,
                previous_attestation_id, signer_key_id, signer_principal_id,
                signature_id, attested_at
         FROM chain_head_attestations
         WHERE workspace_id = ?
         ORDER BY head_sequence, id`,
      )
      .all(workspaceId) as ChainHeadAttestationRow[];
    return rows.map((row) => ({ ...row }));
  }
}

/**
 * A pre-M6 database opened READ-ONLY (the `verify-chain` path never runs DDL)
 * has no chain_head_attestations table. The truncation arm treats its absence
 * as "no attestations survive" — the arm is inapplicable, not a failure — so
 * verifying a legacy database stays a pure read.
 */
export function chainHeadAttestationTableExists(database: Database): boolean {
  const row = database.connection
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name = 'chain_head_attestations'`,
    )
    .get() as { name: string } | undefined;
  return row !== undefined;
}
