#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { ChiefOfStaffService } from "./chief_of_staff/index.js";
import { utcNow, WorkspaceSchema } from "./contracts/index.js";
import { DiagnosisService } from "./diagnosis/index.js";
import { ApprovalService, type DecisionSigner, NarrowingService } from "./governance/index.js";
import { ConsoleTransport, HeartbeatService } from "./heartbeat/index.js";
import { IngestionService } from "./ingestion/index.js";
import { LearningService } from "./learning/index.js";
import {
  MemoryRetrievalService,
  type MemoryReviewOptions,
  PromotionService,
} from "./memory/index.js";
import { OrgChangeService, OrgControlService } from "./org/index.js";
import {
  BoundedWorkEnvelopeStore,
  Database,
  EventStore,
  GrantSuspensionStore,
  IngestionRecordStore,
  MemoryEntryStore,
  OrgChangeApplicationStore,
  OrgChangeProposalStore,
  PromotionCandidateStore,
  RunStore,
  verifyAllChains,
  WorkerIdentityStore,
  WorkerOutcomeStore,
  WorkItemStore,
  WorkspaceStore,
} from "./persistence/index.js";
import { createApprovalServiceWithApplications } from "./runtime/approvals.js";
import {
  createConfiguredCapabilityRegistry,
  materializeRejectedCapabilityApproval,
} from "./runtime/capabilities.js";
import { defaultDatabasePath, openLocalDatabase } from "./runtime/local.js";
import {
  type AuthenticatedPrincipal,
  authenticateFromProfile,
  resolveCliPrincipal,
} from "./security/authenticated-principal.js";
import { resolveCustody, workspaceCustodyDir } from "./security/key-custody.js";
import {
  attestPrincipalKey,
  revokePrincipalKey,
  rotatePrincipalCredential,
} from "./security/principal-authority.js";
import { ensureRootOperator, rotateProfileToken } from "./security/principal-bootstrap.js";
import { WorkerAuthService } from "./security/worker-auth.js";
import { PROMOTION_APPROVAL_ID, RUN_ID, SpineService, WORKSPACE_ID } from "./spine/index.js";
import { WorkService } from "./work/index.js";
import {
  approveReferenceWorkerDemo,
  REFERENCE_RUN_ID,
  runReferenceWorkerDemo,
} from "./workers/index.js";
import { WorldModelService } from "./world/index.js";

type CliOptions = {
  dbPath?: string;
  write?: (message: string) => void;
};

function printJson(write: (message: string) => void, value: unknown): void {
  write(JSON.stringify(value, null, 2));
}

function optionValue(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index < 0) {
    return null;
  }
  return args[index + 1] ?? null;
}

function positionalArgs(args: string[]): string[] {
  const flagsWithValues = new Set([
    "--workspace",
    "--run",
    "--id",
    "--title",
    "--objective",
    "--owner",
    "--reviewer",
    "--priority",
    "--risk",
    "--criteria",
    "--name",
    "--runtime",
    "--version",
    "--role",
    "--capabilities",
    "--worker",
    "--worker-token",
    "--input",
    "--output",
    "--status",
    "--summary",
    "--envelope",
    "--decision",
    "--kind",
    "--source-provider",
    "--source-id",
    "--source-url",
    "--actor-type",
    "--actor-id",
    "--payload",
    "--work",
    "--idempotency-key",
    "--interval",
    "--at",
    "--scope",
    "--min-confidence",
    "--limit",
    "--strength",
    "--note",
    "--subject-key",
    "--reason",
    "--rejections",
    "--violations",
    "--window",
    "--cooldown",
  ]);
  const positions: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (flagsWithValues.has(arg ?? "")) {
      index += 1;
      continue;
    }
    if (arg !== undefined) {
      positions.push(arg);
    }
  }
  return positions;
}

function requireOption(args: string[], name: string): string {
  const value = optionValue(args, name);
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

/**
 * Review path of the provenance invariant (#113): untrusted memory is only
 * shown when explicitly requested, and the requesting actor must be named so
 * the review can be put on the record.
 */
function memoryReviewOption(
  args: string[],
  reviewedBy: () => string,
): MemoryReviewOptions | undefined {
  if (!args.includes("--include-untrusted")) {
    return undefined;
  }
  // The review goes on the record under the AUTHENTICATED principal — never a
  // typed-in name.
  return { include_untrusted: true, reviewed_by: reviewedBy() };
}

function commaList(value: string | null): string[] {
  return value
    ? value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

function jsonOption(value: string | null): Record<string, unknown> {
  if (!value) {
    return {};
  }
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("JSON option must be an object");
  }
  return parsed as Record<string, unknown>;
}

function requireDefaultWorkspace(workspaceId: string): void {
  if (workspaceId !== WORKSPACE_ID) {
    throw new Error(`demo run does not belong to workspace: ${workspaceId}`);
  }
}

/**
 * The custody root for this database. Per-workspace key directories are
 * DERIVED from it (workspaceCustodyDir): no caller ever pairs a directory
 * with a workspace id independently, so a cross-workspace (directory of A,
 * id of B) confusion cannot be expressed.
 */
function cliKeysRoot(database: Database): string {
  return process.env.OPENMAO_KEYS_DIR ?? join(dirname(database.path), "keys");
}

/**
 * Where signing keys, the fingerprint, and the operator profile live for this
 * database and workspace. Custody is namespaced per workspace: two workspaces
 * never share a key file, and one workspace's key can never be resolved as
 * another's custody.
 */
function cliKeysDir(database: Database, workspaceId: string): string {
  return workspaceCustodyDir(cliKeysRoot(database), workspaceId);
}

/** The principals tables FK to workspaces, so the ceremony needs the row to exist. */
function ensureWorkspaceExists(database: Database, workspaceId: string): void {
  const store = new WorkspaceStore(database);
  if (store.get(workspaceId)) {
    return;
  }
  store.save(WorkspaceSchema.parse({ id: workspaceId, name: workspaceId, created_at: utcNow() }));
}

/** Second-invocation authentication: the local operator profile, or a refusal. */
function requireProfilePrincipal(
  database: Database,
  keysDir: string,
  workspaceId: string,
): AuthenticatedPrincipal & { key_id: string } {
  const principal = authenticateFromProfile(database, keysDir);
  if (!principal || principal.workspace_id !== workspaceId) {
    throw new Error(
      "no authenticated operator profile for this workspace; run `principals init` first",
    );
  }
  if (!principal.can_sign || principal.key_id === null) {
    throw new Error("operator profile has no active signing key");
  }
  return principal as AuthenticatedPrincipal & { key_id: string };
}

function requireWorkItemInWorkspace(database: Database, workspaceId: string, workId: string): void {
  const work = new WorkItemStore(database).get(workId);
  if (!work || work.workspace_id !== workspaceId) {
    throw new Error(`work item not found in workspace: ${workId}`);
  }
}

export async function runCli(args: string[], options: CliOptions = {}): Promise<number> {
  const write = options.write ?? console.log;
  const positions = positionalArgs(args);
  const command = positions[0] ?? "help";
  const subcommand = positions[1] ?? "";
  const selectedWorkspace = optionValue(args, "--workspace") ?? WORKSPACE_ID;

  // Self-asserted identity is gone: the actor every command records comes from
  // the authenticated operator profile. A present --by is not ignored — it is
  // the spoof this boundary exists to close, so it is a hard error naming the
  // replacement.
  if (args.includes("--by")) {
    throw new Error(
      "--by is no longer accepted: identity comes from the authenticated operator profile (`principals init`, then the command records the profile's principal)",
    );
  }

  // Read-only commands never provision: no parent directory, no SQLite file,
  // no WAL, no schema. A missing database is reported and exits non-zero.
  if (command === "verify-chain") {
    const dbPath = options.dbPath ?? defaultDatabasePath();
    if (!existsSync(dbPath)) {
      write(JSON.stringify({ ok: false, error: `database does not exist: ${dbPath}` }, null, 2));
      return 1;
    }
    // Opened READ-ONLY: verification is inspection, so it must not flip the
    // file's journal mode or create WAL/SHM sidecars as a side effect.
    const database = new Database(dbPath, { readonly: true });
    try {
      const report = verifyAllChains(database);
      printJson(write, report);
      return report.ok ? 0 : 1;
    } finally {
      database.close();
    }
  }

  const database = openLocalDatabase(options.dbPath);
  try {
    const spine = new SpineService(database);
    // The single identity resolver every actor call site goes through, resolved
    // LAZILY: commands that never record an actor (reads, help) never touch the
    // profile, and `workers mint-token` refuses through requireProfilePrincipal
    // without auto-bootstrapping. Commands that do record an actor authenticate
    // from the operator profile, running the M3 root-of-trust ceremony when no
    // usable profile exists (refused under production signals).
    let cachedPrincipal: AuthenticatedPrincipal | null = null;
    const cliPrincipal = (): AuthenticatedPrincipal => {
      if (!cachedPrincipal) {
        cachedPrincipal = resolveCliPrincipal(
          database,
          selectedWorkspace,
          cliKeysDir(database, selectedWorkspace),
        );
      }
      return cachedPrincipal;
    };
    // The signing counterpart of cliPrincipal: authority-moving decisions (approvals,
    // org-change apply/revert) need the operator's signing custody, not just identity.
    // Resolved lazily so read-only commands never touch the key store.
    let cachedSigner: DecisionSigner | null = null;
    const cliSigner = (): DecisionSigner => {
      if (!cachedSigner) {
        // Identity FIRST: resolving the principal runs the root-of-trust
        // ceremony when no usable profile exists, and the ceremony is what
        // writes the custody key file the signer then resolves.
        const principal = cliPrincipal();
        const custody = resolveCustody({
          env: process.env,
          keysRoot: cliKeysRoot(database),
          database,
          workspaceId: selectedWorkspace,
        });
        if (!custody.broker) {
          throw new Error("no signing key custody available for the operator key");
        }
        cachedSigner = {
          principal,
          broker: custody.broker,
          handle: custody.handle,
        };
      }
      return cachedSigner;
    };

    if (command === "help" || command === "--help" || command === "-h") {
      write(
        "openmao demo | demo-approve | demo-deny | init | run demo|resume | worker demo|demo-approve | work list|show|create|assign|status|envelope|outcome|review | workers list|register | ingest list|record | learning scan|proposals|show|apply|revert|withdraw | cos init|tick|run|inbox|read <id> [--unread] [--at ts] [--beats n] [--interval s] [--daemon] | cadence list|add --kind <kind> --interval <seconds> | org pause|resume|control | autonomy narrow ratify --rejections <n> --violations <m> --window <seconds> --cooldown <seconds> | autonomy narrow scan|list | autonomy narrow lift <id> --note <text> | memory search|list [--include-untrusted]|attest <entry_id>|corroborate | approvals list|approve|reject <id> [--workspace workspace_id] | events [run_id]|--workspace [workspace_id] | verify-chain | world [--run run_id] [--workspace workspace_id] | diagnose <failure_event_id> | console | principals init|mint-token|attest --subject-key <key_id>|revoke-key <key_id> [--reason <code>]",
      );
      return 0;
    }
    if (command === "init") {
      printJson(write, { workspace_id: spine.initDemoWorkspace() });
      return 0;
    }
    if (command === "demo" || (command === "run" && subcommand === "demo")) {
      requireDefaultWorkspace(selectedWorkspace);
      printJson(write, await spine.startDemo());
      return 0;
    }
    if (command === "demo-approve") {
      requireDefaultWorkspace(selectedWorkspace);
      printJson(
        write,
        spine.resumeDemo(positions[1] ?? PROMOTION_APPROVAL_ID, {
          signer: cliSigner(),
        }),
      );
      return 0;
    }
    if (command === "demo-deny") {
      requireDefaultWorkspace(selectedWorkspace);
      printJson(write, await spine.denyDemo({ signer: cliSigner() }));
      return 0;
    }
    if (command === "run" && subcommand === "resume") {
      requireDefaultWorkspace(selectedWorkspace);
      const runId = positions[2] ?? RUN_ID;
      printJson(write, await spine.resumeRun(runId, { signer: cliSigner() }));
      return 0;
    }
    if (command === "approvals" && subcommand === "list") {
      spine.initDemoWorkspace();
      printJson(write, new ApprovalService(database).approvals.listPending(selectedWorkspace));
      return 0;
    }
    if (command === "workers" && subcommand === "list") {
      printJson(write, new WorkerIdentityStore(database).listForWorkspace(selectedWorkspace));
      return 0;
    }
    if (command === "worker" && subcommand === "demo") {
      requireDefaultWorkspace(selectedWorkspace);
      // Seed BEFORE resolving the principal: the resolver plants a bare
      // workspace row when none exists, and the demo seeder refuses to adopt
      // one (workspace already exists) — it must come up through the seeder.
      spine.initDemoWorkspace();
      printJson(write, await runReferenceWorkerDemo(database, cliPrincipal()));
      return 0;
    }
    if (command === "worker" && subcommand === "demo-approve") {
      requireDefaultWorkspace(selectedWorkspace);
      spine.initDemoWorkspace();
      printJson(write, await approveReferenceWorkerDemo(database, cliSigner()));
      return 0;
    }
    if (command === "workers" && subcommand === "register") {
      const service = new WorkService(database);
      printJson(
        write,
        service.registerWorker({
          id: optionValue(args, "--id"),
          workspace_id: selectedWorkspace,
          name: requireOption(args, "--name"),
          runtime: requireOption(args, "--runtime"),
          version: optionValue(args, "--version"),
          role_id: optionValue(args, "--role"),
          allowed_capabilities: commaList(optionValue(args, "--capabilities")),
          actor: cliPrincipal().actor,
        }),
      );
      return 0;
    }
    if (command === "workers" && subcommand === "mint-token") {
      // Minting a worker credential is an authority act: it requires an
      // authenticated operator profile with signing standing, and it never
      // auto-bootstraps one.
      requireProfilePrincipal(database, cliKeysDir(database, selectedWorkspace), selectedWorkspace);
      const workerId = positions[2] ?? optionValue(args, "--worker");
      if (!workerId) {
        throw new Error("workers mint-token requires a worker id");
      }
      const minted = new WorkerAuthService(database).mint({
        workspace_id: selectedWorkspace,
        worker_id: workerId,
      });
      printJson(write, {
        credential_id: minted.credential_id,
        worker_id: minted.worker_id,
        token: minted.token,
        note: "Store this token securely — it is shown only once. Hand it to the worker process.",
      });
      return 0;
    }
    if (command === "work" && subcommand === "list") {
      printJson(write, new WorkItemStore(database).listForWorkspace(selectedWorkspace));
      return 0;
    }
    if (command === "work" && subcommand === "show") {
      const workId = positions[2];
      if (!workId) {
        throw new Error("work id is required");
      }
      const work = new WorkItemStore(database).get(workId);
      if (!work || work.workspace_id !== selectedWorkspace) {
        throw new Error(`work item not found: ${workId}`);
      }
      printJson(write, work);
      return 0;
    }
    if (command === "work" && subcommand === "create") {
      const service = new WorkService(database);
      printJson(
        write,
        service.createWork({
          id: optionValue(args, "--id"),
          workspace_id: selectedWorkspace,
          title: requireOption(args, "--title"),
          objective: requireOption(args, "--objective"),
          owner: requireOption(args, "--owner"),
          reviewer: optionValue(args, "--reviewer"),
          priority: (optionValue(args, "--priority") ?? "medium") as never,
          risk_level: (optionValue(args, "--risk") ?? "low") as never,
          success_criteria: commaList(optionValue(args, "--criteria")),
          actor: cliPrincipal().actor,
        }),
      );
      return 0;
    }
    if (command === "work" && subcommand === "assign") {
      const workId = positions[2];
      if (!workId) {
        throw new Error("work id is required");
      }
      printJson(
        write,
        new WorkService(database).assignWork({
          workspace_id: selectedWorkspace,
          work_item_id: workId,
          owner: requireOption(args, "--owner"),
          reviewer: optionValue(args, "--reviewer"),
          actor: cliPrincipal().actor,
        }),
      );
      return 0;
    }
    if (command === "work" && subcommand === "status") {
      const workId = positions[2];
      const status = positions[3] ?? optionValue(args, "--status");
      if (!workId || !status) {
        throw new Error("work id and status are required");
      }
      printJson(
        write,
        new WorkService(database).setStatus({
          workspace_id: selectedWorkspace,
          work_item_id: workId,
          status: status as never,
          actor: cliPrincipal().actor,
        }),
      );
      return 0;
    }
    if (command === "work" && subcommand === "outcome") {
      const workId = positions[2];
      if (!workId) {
        throw new Error("work id is required");
      }
      // A worker's outcome is a worker's act: it authenticates with the
      // worker's own credential (`workers mint-token`), and BOTH the recorded
      // worker_id and the event actor are forced from that credential. The
      // --worker flag can no longer name an identity — it may only agree with
      // the credential, so a mismatch is a hard error, never a spoof.
      const workerToken = optionValue(args, "--worker-token");
      if (!workerToken) {
        throw new Error(
          "--worker-token is required: an outcome is recorded against the authenticated worker credential (`workers mint-token <worker_id>`)",
        );
      }
      const worker = new WorkerAuthService(database).resolve(workerToken);
      if (!worker || worker.workspace_id !== selectedWorkspace) {
        throw new Error(
          "worker credential does not resolve to an enabled worker in this workspace",
        );
      }
      const namedWorker = requireOption(args, "--worker");
      if (namedWorker !== worker.worker_id) {
        throw new Error(
          `--worker ${namedWorker} does not match the authenticated worker credential (${worker.worker_id})`,
        );
      }
      printJson(
        write,
        new WorkService(database).submitWorkerOutcome({
          id: optionValue(args, "--id"),
          workspace_id: selectedWorkspace,
          envelope_id: requireOption(args, "--envelope"),
          worker_id: worker.worker_id,
          status: (optionValue(args, "--status") ?? "completed") as never,
          summary: requireOption(args, "--summary"),
          output: jsonOption(optionValue(args, "--output") ?? optionValue(args, "--input")),
          actor: worker.worker_id,
          idempotency_key: `work:${workId}:outcome:${requireOption(args, "--envelope")}`,
        }),
      );
      return 0;
    }
    if (command === "work" && subcommand === "outcomes") {
      const workId = positions[2];
      if (!workId) {
        throw new Error("work id is required");
      }
      requireWorkItemInWorkspace(database, selectedWorkspace, workId);
      printJson(write, new WorkerOutcomeStore(database).listForWorkItem(selectedWorkspace, workId));
      return 0;
    }
    if (command === "work" && subcommand === "review") {
      const workId = positions[2];
      const decision = positions[3] ?? optionValue(args, "--decision");
      if (!workId || !decision) {
        throw new Error("work id and review decision are required");
      }
      printJson(
        write,
        new WorkService(database).reviewWork({
          workspace_id: selectedWorkspace,
          work_item_id: workId,
          decision: decision as never,
          actor: cliPrincipal().actor,
        }),
      );
      return 0;
    }
    if (command === "work" && subcommand === "envelope") {
      const workId = positions[2];
      if (!workId) {
        throw new Error("work id is required");
      }
      printJson(
        write,
        new WorkService(database).createBoundedEnvelope({
          id: optionValue(args, "--id"),
          workspace_id: selectedWorkspace,
          work_item_id: workId,
          worker_id: requireOption(args, "--worker"),
          issued_by: { actor_type: "operator", actor_id: cliPrincipal().actor, display_name: null },
          run_id: optionValue(args, "--run"),
          allowed_capabilities: commaList(optionValue(args, "--capabilities")),
          input: jsonOption(optionValue(args, "--input")),
        }),
      );
      return 0;
    }
    if (command === "work" && subcommand === "envelopes") {
      const workId = positions[2];
      if (!workId) {
        throw new Error("work id is required");
      }
      requireWorkItemInWorkspace(database, selectedWorkspace, workId);
      printJson(
        write,
        new BoundedWorkEnvelopeStore(database).listForWorkItem(selectedWorkspace, workId),
      );
      return 0;
    }
    if (command === "ingest" && (subcommand === "list" || subcommand === "")) {
      printJson(write, new IngestionRecordStore(database).listForWorkspace(selectedWorkspace));
      return 0;
    }
    if (command === "ingest" && subcommand === "record") {
      const sourceId = optionValue(args, "--source-id");
      const sourceUrl = optionValue(args, "--source-url");
      if (!sourceId && !sourceUrl) {
        throw new Error("--source-id or --source-url is required");
      }
      printJson(
        write,
        new IngestionService(database).record({
          id: optionValue(args, "--id"),
          workspace_id: selectedWorkspace,
          source: {
            provider: requireOption(args, "--source-provider"),
            external_id: sourceId,
            external_url: sourceUrl,
          },
          actor: {
            actor_type: (optionValue(args, "--actor-type") ?? "worker") as never,
            actor_id: requireOption(args, "--actor-id"),
            display_name: null,
          },
          kind: (optionValue(args, "--kind") ?? "event") as never,
          target_run_id: optionValue(args, "--run"),
          target_work_item_id: optionValue(args, "--work"),
          payload: jsonOption(optionValue(args, "--payload")),
          idempotency_key: requireOption(args, "--idempotency-key"),
          recorded_by: cliPrincipal().actor,
        }),
      );
      return 0;
    }
    if (command === "learning" && subcommand === "scan") {
      printJson(write, new LearningService(database).scan(selectedWorkspace));
      return 0;
    }
    if (command === "learning" && (subcommand === "proposals" || subcommand === "list")) {
      printJson(write, new OrgChangeProposalStore(database).listForWorkspace(selectedWorkspace));
      return 0;
    }
    if (command === "learning" && subcommand === "show") {
      const proposalId = positions[2];
      if (!proposalId) {
        throw new Error("proposal id is required");
      }
      const proposal = new OrgChangeProposalStore(database).get(proposalId);
      if (!proposal || proposal.workspace_id !== selectedWorkspace) {
        throw new Error(`org change proposal not found: ${proposalId}`);
      }
      printJson(write, proposal);
      return 0;
    }
    if (command === "learning" && subcommand === "apply") {
      const proposalId = positions[2];
      if (!proposalId) {
        throw new Error("proposal id is required");
      }
      printJson(
        write,
        new OrgChangeService(database).markApplied(proposalId, {
          workspace_id: selectedWorkspace,
          signer: cliSigner(),
        }),
      );
      return 0;
    }
    if (command === "learning" && subcommand === "revert") {
      // Revert by the same proposal id used to apply; the application is resolved internally so the
      // operator never needs the derived application id.
      const proposalId = positions[2];
      if (!proposalId) {
        throw new Error("proposal id is required");
      }
      const application = new OrgChangeApplicationStore(database).getForProposal(
        selectedWorkspace,
        proposalId,
      );
      if (!application) {
        // Truth-in-status (#105): an `acknowledged` record was never applied, so there is
        // nothing to reverse — its defined revert semantics are withdrawal, a separate explicit
        // operation.
        const proposal = new OrgChangeProposalStore(database).get(proposalId);
        if (proposal?.workspace_id === selectedWorkspace && proposal.status === "acknowledged") {
          throw new Error(
            `org change ${proposalId} is acknowledged (recorded only — nothing was applied), so there is nothing to revert; use \`learning withdraw ${proposalId}\` to withdraw it`,
          );
        }
        throw new Error(`no applied change found for proposal: ${proposalId}`);
      }
      printJson(
        write,
        new OrgChangeService(database).revertApplication(application.id, {
          workspace_id: selectedWorkspace,
          signer: cliSigner(),
        }),
      );
      return 0;
    }
    if (command === "learning" && subcommand === "withdraw") {
      // Withdraw an acknowledged (applier-less) org change record — valid only from
      // `acknowledged`, idempotent, and audited as `org_change.withdrawn` (#105).
      const proposalId = positions[2];
      if (!proposalId) {
        throw new Error("proposal id is required");
      }
      printJson(
        write,
        new OrgChangeService(database).withdraw(proposalId, {
          workspace_id: selectedWorkspace,
          actor: cliPrincipal().actor,
        }),
      );
      return 0;
    }
    if (command === "memory" && subcommand === "search") {
      const query = positions[2] ?? "";
      const scope = optionValue(args, "--scope");
      const kind = optionValue(args, "--kind");
      const owner = optionValue(args, "--owner");
      const minConfidence = optionValue(args, "--min-confidence");
      const limit = optionValue(args, "--limit");
      printJson(
        write,
        new MemoryRetrievalService(database).search(
          selectedWorkspace,
          query,
          {
            ...(scope ? { scope: scope as never } : {}),
            ...(kind ? { kind: kind as never } : {}),
            ...(minConfidence !== null ? { min_confidence: Number(minConfidence) } : {}),
            ...(owner ? { owner_id: owner } : {}),
            ...(limit !== null ? { limit: Number(limit) } : {}),
          },
          memoryReviewOption(args, () => cliPrincipal().actor),
        ),
      );
      return 0;
    }
    if (command === "memory" && (subcommand === "list" || subcommand === "")) {
      printJson(
        write,
        new MemoryRetrievalService(database).list(
          selectedWorkspace,
          {},
          memoryReviewOption(args, () => cliPrincipal().actor),
        ),
      );
      return 0;
    }
    if (command === "memory" && subcommand === "attest") {
      // Operator path of the provenance invariant (#113): an operator puts an
      // attestation on the record so the entry derives guidance-eligible. The
      // bare `attested_by` on the entry confers nothing without this event.
      const entryId = positions[2];
      if (!entryId) {
        throw new Error("usage: memory attest <entry_id>");
      }
      const attestEntry = new MemoryEntryStore(database).get(entryId);
      if (!attestEntry || attestEntry.workspace_id !== selectedWorkspace) {
        throw new Error(`memory entry not found in workspace: ${entryId}`);
      }
      printJson(
        write,
        new PromotionService(database).attestMemory(entryId, {
          attested_by: cliPrincipal().actor,
        }),
      );
      return 0;
    }
    if (command === "memory" && subcommand === "corroborate") {
      const candidateId = positions[2];
      const sourceMemoryId = positions[3];
      if (!candidateId || !sourceMemoryId) {
        throw new Error("usage: memory corroborate <candidate_id> <source_memory_id>");
      }
      const corroborateCandidate = new PromotionCandidateStore(database).get(candidateId);
      if (!corroborateCandidate || corroborateCandidate.workspace_id !== selectedWorkspace) {
        throw new Error(`promotion candidate not found in workspace: ${candidateId}`);
      }
      const strength = optionValue(args, "--strength");
      printJson(
        write,
        new PromotionService(database).recordCorroboration(candidateId, {
          source_memory_entry: sourceMemoryId,
          corroborated_by: cliPrincipal().actor,
          run_id: optionValue(args, "--run"),
          note: optionValue(args, "--note"),
          corroboration_id: optionValue(args, "--id"),
          ...(strength !== null ? { strength: Number(strength) } : {}),
        }),
      );
      return 0;
    }
    if (command === "org" && subcommand === "pause") {
      printJson(
        write,
        new OrgControlService(database).pauseApply(selectedWorkspace, {
          actor: cliPrincipal().actor,
          reason: positions[2] ?? null,
        }),
      );
      return 0;
    }
    if (command === "org" && subcommand === "resume") {
      printJson(
        write,
        new OrgControlService(database).resumeApply(selectedWorkspace, {
          actor: cliPrincipal().actor,
        }),
      );
      return 0;
    }
    if (command === "org" && subcommand === "control") {
      printJson(write, new OrgControlService(database).get(selectedWorkspace));
      return 0;
    }
    if (command === "autonomy" && subcommand === "narrow") {
      const action = positions[2] ?? "";
      const narrowing = new NarrowingService(database);
      if (action === "ratify") {
        const intOption = (name: string, minimum: number): number => {
          const value = Number.parseInt(requireOption(args, name), 10);
          if (!Number.isInteger(value) || value < minimum) {
            throw new Error(`${name} must be an integer >= ${minimum}`);
          }
          return value;
        };
        printJson(
          write,
          narrowing.ratifyPolicy({
            workspace_id: selectedWorkspace,
            ratified_by: cliPrincipal().actor,
            rejection_threshold: intOption("--rejections", 1),
            violation_threshold: intOption("--violations", 1),
            window_seconds: intOption("--window", 1),
            cooldown_seconds: intOption("--cooldown", 0),
          }),
        );
        return 0;
      }
      if (action === "scan") {
        printJson(write, narrowing.scan({ workspace_id: selectedWorkspace }));
        return 0;
      }
      if (action === "list") {
        printJson(write, narrowing.list(selectedWorkspace));
        return 0;
      }
      if (action === "lift") {
        const suspensionId = positions[3];
        if (!suspensionId) {
          throw new Error("suspension id is required");
        }
        const suspension = new GrantSuspensionStore(database).get(suspensionId);
        if (!suspension || suspension.workspace_id !== selectedWorkspace) {
          throw new Error(`grant suspension not found in workspace: ${suspensionId}`);
        }
        printJson(
          write,
          narrowing.lift(suspensionId, {
            actor: cliPrincipal().actor,
            note: requireOption(args, "--note"),
          }),
        );
        return 0;
      }
    }
    if (command === "approvals" && subcommand === "approve") {
      const approvalId = positions[2];
      if (!approvalId) {
        throw new Error("approval id is required");
      }
      const approval = new ApprovalService(database).approvals.get(approvalId);
      if (approval && approval.workspace_id !== selectedWorkspace) {
        throw new Error(`approval does not belong to workspace: ${approvalId}`);
      }
      if (approval?.payload.target_type === "capability_call" && approval.run_id === RUN_ID) {
        printJson(
          write,
          await spine.resumeApprovedCapability(approvalId, {
            signer: cliSigner(),
            workspace_id: selectedWorkspace,
          }),
        );
      } else if (
        approval?.payload.target_type === "capability_call" &&
        approval.run_id === REFERENCE_RUN_ID
      ) {
        printJson(write, await approveReferenceWorkerDemo(database, cliSigner()));
      } else if (approval?.payload.target_type === "capability_call") {
        new ApprovalService(database).approve(approvalId, {
          workspace_id: selectedWorkspace,
          signer: cliSigner(),
        });
        printJson(
          write,
          await createConfiguredCapabilityRegistry(database).resumeApprovedCall(approvalId, {
            workspace_id: selectedWorkspace,
          }),
        );
      } else if (approvalId === PROMOTION_APPROVAL_ID) {
        requireDefaultWorkspace(selectedWorkspace);
        printJson(write, spine.resumeDemo(approvalId, { signer: cliSigner() }));
      } else {
        printJson(
          write,
          createApprovalServiceWithApplications(database).approve(approvalId, {
            workspace_id: selectedWorkspace,
            signer: cliSigner(),
          }),
        );
      }
      return 0;
    }
    if (command === "approvals" && subcommand === "reject") {
      const approvalId = positions[2];
      if (!approvalId) {
        throw new Error("approval id is required");
      }
      const approvalService = new ApprovalService(database);
      const approval = approvalService.approvals.get(approvalId);
      if (approval && approval.workspace_id !== selectedWorkspace) {
        throw new Error(`approval does not belong to workspace: ${approvalId}`);
      }
      const rejected = approvalService.reject(approvalId, {
        workspace_id: selectedWorkspace,
        signer: cliSigner(),
      });
      printJson(
        write,
        rejected.payload.target_type === "capability_call"
          ? await materializeRejectedCapabilityApproval(database, rejected)
          : rejected,
      );
      return 0;
    }
    if (command === "events") {
      const runId = subcommand || null;
      printJson(
        write,
        runId
          ? new EventStore(database).listForRun(selectedWorkspace, runId)
          : new EventStore(database).listForWorkspace(selectedWorkspace),
      );
      return 0;
    }
    if (command === "console") {
      write("OpenMAO console is served by `make console` at http://127.0.0.1:8000/console.");
      return 0;
    }
    if (command === "world") {
      const runId = optionValue(args, "--run") ?? (subcommand || null);
      const defaultRun = new RunStore(database).get(RUN_ID);
      const fallbackRunId =
        selectedWorkspace === WORKSPACE_ID && defaultRun?.workspace_id === selectedWorkspace
          ? RUN_ID
          : null;
      printJson(
        write,
        new WorldModelService(database).rebuild(selectedWorkspace, runId ?? fallbackRunId),
      );
      return 0;
    }
    if (command === "diagnose") {
      // Advisory causal diagnosis of a failure event (M3): backward-trace + counterfactual screen.
      // Gates nothing — a hint for a human, not a proposal.
      const failureEventId = positions[1];
      if (!failureEventId) {
        throw new Error("failure event id is required");
      }
      printJson(
        write,
        new DiagnosisService(database).diagnose({
          workspace_id: selectedWorkspace,
          failure_event_id: failureEventId,
        }),
      );
      return 0;
    }

    if (command === "cos" && subcommand === "init") {
      if (selectedWorkspace === WORKSPACE_ID) {
        spine.initDemoWorkspace();
      }
      printJson(
        write,
        new ChiefOfStaffService(database).ensureDefaultCadences(
          selectedWorkspace,
          optionValue(args, "--at") ?? utcNow(),
        ),
      );
      return 0;
    }
    if (command === "cos" && subcommand === "tick") {
      if (selectedWorkspace === WORKSPACE_ID) {
        spine.initDemoWorkspace();
      }
      printJson(
        write,
        new ChiefOfStaffService(database).tick({
          workspace_id: selectedWorkspace,
          at: optionValue(args, "--at") ?? utcNow(),
        }),
      );
      return 0;
    }
    if (command === "cos" && subcommand === "run") {
      if (selectedWorkspace === WORKSPACE_ID) {
        spine.initDemoWorkspace();
      }
      // The heartbeat daemon: beat on a cadence and deliver digests. Bounded by default (one beat,
      // safe for scripts); `--daemon` runs until the process is stopped, `--beats n` runs n beats.
      const intervalSeconds = Number(optionValue(args, "--interval") ?? 3600);
      if (!Number.isInteger(intervalSeconds) || intervalSeconds <= 0) {
        throw new Error("--interval must be a positive integer number of seconds");
      }
      const daemon = args.includes("--daemon");
      let limit = Number.POSITIVE_INFINITY;
      if (!daemon) {
        limit = Number(optionValue(args, "--beats") ?? 1);
        if (!Number.isInteger(limit) || limit <= 0) {
          throw new Error("--beats must be a positive integer");
        }
      }
      // Graceful shutdown: a daemon stops at the next beat boundary on SIGINT/SIGTERM, letting the
      // in-flight beat's transaction finish before the database is closed.
      let stopped = false;
      const stop = (): void => {
        stopped = true;
      };
      if (daemon) {
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      }
      let count = 0;
      try {
        const beats = await new HeartbeatService(database, {
          transport: new ConsoleTransport((line) => write(`${line}\n`)),
        }).run({
          workspace_id: selectedWorkspace,
          interval_seconds: intervalSeconds,
          clock: () => utcNow(),
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          shouldStop: () => stopped || count >= limit,
          onBeat: () => {
            count += 1;
          },
          onError: (error) => {
            write(
              `heartbeat beat failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          },
        });
        printJson(write, { workspace_id: selectedWorkspace, beats });
      } finally {
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
      }
      return 0;
    }
    if (command === "cos" && subcommand === "inbox") {
      printJson(
        write,
        new ChiefOfStaffService(database).listNotifications(selectedWorkspace, {
          unreadOnly: args.includes("--unread"),
        }),
      );
      return 0;
    }
    if (command === "cos" && subcommand === "read") {
      const notificationId = positions[2];
      if (!notificationId) {
        throw new Error("notification id is required");
      }
      printJson(
        write,
        new ChiefOfStaffService(database).markRead({
          workspace_id: selectedWorkspace,
          notification_id: notificationId,
          at: optionValue(args, "--at") ?? utcNow(),
        }),
      );
      return 0;
    }
    if (command === "cadence" && (subcommand === "list" || subcommand === "")) {
      printJson(write, new ChiefOfStaffService(database).listCadences(selectedWorkspace));
      return 0;
    }
    if (command === "cadence" && subcommand === "add") {
      if (selectedWorkspace === WORKSPACE_ID) {
        spine.initDemoWorkspace();
      }
      const interval = Number.parseInt(requireOption(args, "--interval"), 10);
      if (!Number.isInteger(interval) || interval <= 0) {
        throw new Error("--interval must be a positive integer number of seconds");
      }
      printJson(
        write,
        new ChiefOfStaffService(database).addCadence({
          workspace_id: selectedWorkspace,
          kind: requireOption(args, "--kind") as never,
          interval_seconds: interval,
          at: optionValue(args, "--at") ?? utcNow(),
          id: optionValue(args, "--id"),
        }),
      );
      return 0;
    }

    if (command === "principals" && subcommand === "init") {
      // The root-of-trust ceremony: valid on an empty registry, idempotent on
      // its own prior state, refused under production-ish signals. The token
      // prints ONCE; afterwards it lives only in the 0600 profile file.
      const keysDir = cliKeysDir(database, selectedWorkspace);
      ensureWorkspaceExists(database, selectedWorkspace);
      const result = ensureRootOperator({ database, workspaceId: selectedWorkspace, keysDir });
      printJson(write, {
        mode: result.mode,
        already_bootstrapped: result.already_bootstrapped,
        workspace_id: result.workspace_id,
        principal_id: result.principal_id,
        key_id: result.key_id,
        public_key: result.public_key,
        fingerprint: result.fingerprint,
        key_path: result.key_path,
        fingerprint_path: result.fingerprint_path,
        profile_path: result.profile_path,
        predicates: result.predicates,
        ...(result.already_bootstrapped
          ? { note: "Root operator already bootstrapped; nothing was changed." }
          : {
              // The plaintext token is never printed: it lives only in the
              // mode-0600 profile file, so it cannot land in shell history or
              // CI logs.
              note: "The operator token is held only in the mode-0600 profile file; it is never printed.",
            }),
      });
      return 0;
    }
    if (command === "principals" && subcommand === "mint-token") {
      // Rotates the operator credential: the new token is written to the 0600
      // profile BEFORE the prior credential is revoked, so a failed profile
      // write can never strand the operator with no usable token. The
      // revocation and the mint event then commit in one transaction — an
      // authority change is an audited act. The plaintext never prints.
      const keysDir = cliKeysDir(database, selectedWorkspace);
      const principal = requireProfilePrincipal(database, keysDir, selectedWorkspace);
      const minted = rotatePrincipalCredential({
        database,
        workspaceId: selectedWorkspace,
        principalId: principal.principal_id,
        persistToken: (token) => {
          rotateProfileToken(keysDir, token);
        },
      });
      printJson(write, {
        credential_id: minted.credential_id,
        principal_id: minted.principal_id,
        note: "The credential was rotated; the new token is held only in the mode-0600 profile file and is never printed.",
      });
      return 0;
    }
    if (command === "principals" && subcommand === "attest") {
      // The operator key attests another enrolled key through the authority
      // service: predicates are EVALUATED, the attestation is signed through
      // custody, and the row plus its event commit in one transaction.
      const subjectKeyId = requireOption(args, "--subject-key");
      const keysDir = cliKeysDir(database, selectedWorkspace);
      const attester = requireProfilePrincipal(database, keysDir, selectedWorkspace);
      const custody = resolveCustody({
        env: process.env,
        keysRoot: cliKeysRoot(database),
        database,
        workspaceId: selectedWorkspace,
      });
      if (!custody.broker) {
        throw new Error("no signing key custody available for the operator key");
      }
      printJson(
        write,
        await attestPrincipalKey({
          database,
          workspaceId: selectedWorkspace,
          attester: {
            principal_id: attester.principal_id,
            key_id: attester.key_id,
          },
          subjectKeyId,
          broker: custody.broker,
          handle: custody.handle,
        }),
      );
      return 0;
    }
    if (command === "principals" && subcommand === "revoke-key") {
      // Signed revocation through the authority service: the audit row, the
      // key's standing flip, and the revocation event commit in one
      // transaction.
      const keyId = positions[2];
      if (!keyId) {
        throw new Error("usage: principals revoke-key <key_id> [--reason <code>]");
      }
      const keysDir = cliKeysDir(database, selectedWorkspace);
      const revoker = requireProfilePrincipal(database, keysDir, selectedWorkspace);
      const custody = resolveCustody({
        env: process.env,
        keysRoot: cliKeysRoot(database),
        database,
        workspaceId: selectedWorkspace,
      });
      if (!custody.broker) {
        throw new Error("no signing key custody available for the operator key");
      }
      printJson(
        write,
        await revokePrincipalKey({
          database,
          workspaceId: selectedWorkspace,
          revoker: {
            principal_id: revoker.principal_id,
            key_id: revoker.key_id,
          },
          keyId,
          reasonCode: optionValue(args, "--reason") ?? "operator_initiated",
          broker: custody.broker,
          handle: custody.handle,
        }),
      );
      return 0;
    }

    throw new Error(`unknown command: ${args.join(" ")}`);
  } finally {
    database.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
