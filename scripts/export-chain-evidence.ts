#!/usr/bin/env tsx
/**
 * Exports a hash-chain-verifiable event-log slice plus its signed chain-head
 * attestation as a single self-contained JSON bundle — the evidence artifact
 * described in docs/CHAIN_EVIDENCE.md.
 *
 * The bundle carries everything a third party needs to verify WITHOUT this
 * database: the parsed events from genesis, the latest attestation row, its
 * signature row (the exact signed bytes), and the signer's public key. The
 * database is opened READ-ONLY — export is inspection, never mutation.
 *
 * Usage:
 *   tsx scripts/export-chain-evidence.ts [out-path] [--db <path>] [--workspace <id>]
 *
 * Defaults: the repo's local database, the only workspace that has
 * attestations (an error names --workspace when more than one does), and
 * stdout when no out-path is given.
 */
import { writeFileSync } from "node:fs";

import { EventSchema } from "../ts/src/contracts/index.js";
import {
  ChainHeadAttestationStore,
  chainHeadAttestationTableExists,
} from "../ts/src/persistence/chain-attestations.js";
import { Database } from "../ts/src/persistence/database.js";
import { PrincipalKeyStore, PrincipalStore } from "../ts/src/persistence/principals.js";
import { GovernanceSignatureStore } from "../ts/src/persistence/signatures.js";
import { defaultDatabasePath } from "../ts/src/runtime/local.js";

const GENESIS_HASH = "0".repeat(64);
const BUNDLE_FORMAT = "openmao-chain-evidence/v1";

function optionValue(args: string[], flag: string): string | null {
  const index = args.indexOf(flag);
  return index >= 0 ? (args[index + 1] ?? null) : null;
}

function fail(message: string): never {
  console.error(`export-chain-evidence: ${message}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const positional = args.filter(
  (arg, index) =>
    !arg.startsWith("--") && args[index - 1] !== "--db" && args[index - 1] !== "--workspace",
);
const outPath = positional[0] ?? null;
const dbPath = optionValue(args, "--db") ?? defaultDatabasePath();

const database = new Database(dbPath, { readonly: true });
try {
  if (!chainHeadAttestationTableExists(database)) {
    fail("no chain_head_attestations table — run `openmao attest` first");
  }
  const attestationStore = new ChainHeadAttestationStore(database);

  const workspaceId =
    optionValue(args, "--workspace") ??
    (() => {
      const rows = database.connection
        .prepare("SELECT DISTINCT workspace_id FROM chain_head_attestations")
        .all() as Array<{ workspace_id: string }>;
      if (rows.length === 0) {
        fail("no chain-head attestations recorded — run `openmao attest` first");
      }
      if (rows.length > 1) {
        fail(
          `more than one workspace has attestations (${rows.map((row) => row.workspace_id).join(", ")}); pass --workspace`,
        );
      }
      return rows[0]!.workspace_id;
    })();

  const attestation = attestationStore.latestForWorkspace(workspaceId);
  if (!attestation) {
    fail(`no chain-head attestation for workspace ${workspaceId} — run \`openmao attest\` first`);
  }

  const signature = new GovernanceSignatureStore(database)
    .forObject(workspaceId, "chain_attestation", attestation.id)
    .find((row) => row.id === attestation.signature_id);
  if (!signature) {
    fail(
      `attestation ${attestation.id} references signature ${attestation.signature_id}, which is missing`,
    );
  }

  const key = new PrincipalKeyStore(database).get(attestation.signer_key_id);
  if (!key) {
    fail(
      `attestation ${attestation.id} references signer key ${attestation.signer_key_id}, which is missing`,
    );
  }
  const principal = new PrincipalStore(database).get(attestation.signer_principal_id);

  // Events are exported as PARSED contract objects — the same re-parse
  // verifyChain performs before re-deriving each hash — so the digest a
  // verifier recomputes from the bundle matches the digest the runtime
  // computed. The raw payload_json bytes are deliberately not exported: they
  // are a storage detail, not the canonical event.
  const eventRows = database.connection
    .prepare("SELECT payload_json FROM events WHERE workspace_id = ? ORDER BY seq")
    .all(workspaceId) as Array<{ payload_json: string }>;
  const parsed = eventRows.map((row) => EventSchema.parse(JSON.parse(row.payload_json)));
  // The slice covers exactly the attested range: the attestation's own audit
  // event advances the live chain past the attested head, so an unfiltered
  // export would carry a head the attestation never pinned. Events after the
  // attested head are verifiable only by re-attesting and re-exporting.
  const events = parsed.filter((event) => event.seq <= attestation.head_sequence);
  const sliceHead = events[events.length - 1];
  if (!sliceHead || sliceHead.seq !== attestation.head_sequence) {
    fail(
      `the event at the attested position (seq ${attestation.head_sequence}) does not survive in the live database — the chain was rewritten after attestation`,
    );
  }

  const bundle = {
    format: BUNDLE_FORMAT,
    // Wall-clock export moment. Metadata only — it is not part of any signed
    // or hashed byte string.
    exported_at: new Date().toISOString(),
    workspace_id: workspaceId,
    genesis_hash: GENESIS_HASH,
    events,
    attestation,
    signature: {
      id: signature.id,
      object_type: signature.object_type,
      object_id: signature.object_id,
      signer_key_id: signature.signer_key_id,
      signer_principal_id: signature.signer_principal_id,
      signed_bytes: signature.signed_bytes,
      signature: signature.signature,
      domain_tag: signature.domain_tag,
      signed_at: signature.signed_at,
    },
    signer: {
      principal_id: attestation.signer_principal_id,
      key_id: attestation.signer_key_id,
      algorithm: "Ed25519",
      // Raw 32-byte public key, canonical base64url (RFC 8037 OKP `x`). A
      // third party should confirm this key against a fingerprint obtained
      // OUT OF BAND — see docs/CHAIN_EVIDENCE.md.
      public_key: key.public_key,
      trust: principal?.dev_bootstrap ? "development_bootstrap" : "standard",
    },
  };

  const json = `${JSON.stringify(bundle, null, 2)}\n`;
  if (outPath) {
    writeFileSync(outPath, json, { mode: 0o644 });
    console.error(
      `exported ${events.length} events, attestation ${attestation.id} (head seq ${attestation.head_sequence}) to ${outPath}`,
    );
  } else {
    process.stdout.write(json);
  }
} finally {
  database.close();
}
