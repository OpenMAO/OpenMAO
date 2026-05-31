#!/usr/bin/env node
import { ChiefOfStaffService } from "./chief_of_staff/index.js";
import { utcNow } from "./contracts/index.js";
import { DiagnosisService } from "./diagnosis/index.js";
import { ApprovalService } from "./governance/index.js";
import { ConsoleTransport, HeartbeatService } from "./heartbeat/index.js";
import { IngestionService } from "./ingestion/index.js";
import { LearningService } from "./learning/index.js";
import { MemoryRetrievalService, PromotionService } from "./memory/index.js";
import { AutonomyService, OrgChangeService, OrgControlService } from "./org/index.js";
import {
  AutonomyCaseStore,
  BoundedWorkEnvelopeStore,
  type Database,
  EventStore,
  IngestionRecordStore,
  MemoryEntryStore,
  OrganizationStore,
  OrgChangeApplicationStore,
  OrgChangeProposalStore,
  PromotionCandidateStore,
  RunStore,
  WorkerIdentityStore,
  WorkerOutcomeStore,
  WorkItemStore,
} from "./persistence/index.js";
import { createApprovalServiceWithApplications } from "./runtime/approvals.js";
import {
  createConfiguredCapabilityRegistry,
  materializeRejectedCapabilityApproval,
} from "./runtime/capabilities.js";
import { openLocalDatabase } from "./runtime/local.js";
import { PROMOTION_APPROVAL_ID, RUN_ID, SpineService, WORKSPACE_ID } from "./spine/index.js";
import { WorkService } from "./work/index.js";
import {
  approveReferenceWorkerDemo,
  REFERENCE_RUN_ID,
  runHermesDogfoodDemo,
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
    "--rationale",
    "--evidence",
    "--to",
    "--actor",
    "--org",
    "--min-confidence",
    "--limit",
    "--by",
    "--strength",
    "--note",
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

function requireWorkItemInWorkspace(database: Database, workspaceId: string, workId: string): void {
  const work = new WorkItemStore(database).get(workId);
  if (!work || work.workspace_id !== workspaceId) {
    throw new Error(`work item not found in workspace: ${workId}`);
  }
}

export async function runCli(args: string[], options: CliOptions = {}): Promise<number> {
  const write = options.write ?? console.log;
  const database = openLocalDatabase(options.dbPath);
  try {
    const spine = new SpineService(database);
    const positions = positionalArgs(args);
    const command = positions[0] ?? "help";
    const subcommand = positions[1] ?? "";
    const selectedWorkspace = optionValue(args, "--workspace") ?? WORKSPACE_ID;

    if (command === "help" || command === "--help" || command === "-h") {
      write(
        "openmao demo | demo-approve | init | run demo|resume | worker demo|demo-approve | work list|show|create|assign|status|envelope|outcome|review | workers list|register | ingest list|record | learning scan|proposals|show|apply|revert | cos init|tick|run|inbox|read <id> [--unread] [--at ts] [--beats n] [--interval s] [--daemon] | cadence list|add --kind <kind> --interval <seconds> | org pause|resume|control | autonomy status|propose|ratify|reject|narrow [--rationale t] [--evidence ref] [--to level] [--actor a] | memory search|list|corroborate | approvals list|approve|reject <id> [--workspace workspace_id] | events [run_id]|--workspace [workspace_id] | world [--run run_id] [--workspace workspace_id] | diagnose <failure_event_id> | hermes-demo | console",
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
      printJson(write, spine.resumeDemo(positions[1] ?? PROMOTION_APPROVAL_ID));
      return 0;
    }
    if (command === "run" && subcommand === "resume") {
      requireDefaultWorkspace(selectedWorkspace);
      const runId = positions[2] ?? RUN_ID;
      printJson(write, await spine.resumeRun(runId));
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
      printJson(write, await runReferenceWorkerDemo(database));
      return 0;
    }
    if (command === "worker" && subcommand === "demo-approve") {
      requireDefaultWorkspace(selectedWorkspace);
      printJson(write, await approveReferenceWorkerDemo(database));
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
          actor: "cli_operator",
        }),
      );
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
          actor: "cli_operator",
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
          actor: "cli_operator",
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
          actor: "cli_operator",
        }),
      );
      return 0;
    }
    if (command === "work" && subcommand === "outcome") {
      const workId = positions[2];
      if (!workId) {
        throw new Error("work id is required");
      }
      printJson(
        write,
        new WorkService(database).submitWorkerOutcome({
          id: optionValue(args, "--id"),
          workspace_id: selectedWorkspace,
          envelope_id: requireOption(args, "--envelope"),
          worker_id: requireOption(args, "--worker"),
          status: (optionValue(args, "--status") ?? "completed") as never,
          summary: requireOption(args, "--summary"),
          output: jsonOption(optionValue(args, "--output") ?? optionValue(args, "--input")),
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
          actor: "cli_operator",
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
          issued_by: { actor_type: "operator", actor_id: "cli_operator", display_name: null },
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
          actor: "cli_operator",
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
        throw new Error(`no applied change found for proposal: ${proposalId}`);
      }
      printJson(
        write,
        new OrgChangeService(database).revertApplication(application.id, {
          workspace_id: selectedWorkspace,
          actor: "cli_operator",
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
        new MemoryRetrievalService(database).search(selectedWorkspace, query, {
          ...(scope ? { scope: scope as never } : {}),
          ...(kind ? { kind: kind as never } : {}),
          ...(minConfidence !== null ? { min_confidence: Number(minConfidence) } : {}),
          ...(owner ? { owner_id: owner } : {}),
          ...(limit !== null ? { limit: Number(limit) } : {}),
        }),
      );
      return 0;
    }
    if (command === "memory" && (subcommand === "list" || subcommand === "")) {
      printJson(write, new MemoryEntryStore(database).listForWorkspace(selectedWorkspace));
      return 0;
    }
    if (command === "memory" && subcommand === "corroborate") {
      const candidateId = positions[2];
      const sourceMemoryId = positions[3];
      if (!candidateId || !sourceMemoryId) {
        throw new Error(
          "usage: memory corroborate <candidate_id> <source_memory_id> --by <actor_id>",
        );
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
          corroborated_by: requireOption(args, "--by"),
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
          actor: "cli_operator",
          reason: positions[2] ?? null,
        }),
      );
      return 0;
    }
    if (command === "org" && subcommand === "resume") {
      printJson(
        write,
        new OrgControlService(database).resumeApply(selectedWorkspace, {
          actor: "cli_operator",
        }),
      );
      return 0;
    }
    if (command === "org" && subcommand === "control") {
      printJson(write, new OrgControlService(database).get(selectedWorkspace));
      return 0;
    }
    if (command === "autonomy") {
      const autonomy = new AutonomyService(database);
      const orgId =
        optionValue(args, "--org") ??
        new OrganizationStore(database).listForWorkspace(selectedWorkspace)[0]?.id;
      if (!orgId) {
        throw new Error(`no organization found in workspace: ${selectedWorkspace}`);
      }
      const actor = optionValue(args, "--actor") ?? "cli_operator";
      if (subcommand === "status" || subcommand === "") {
        const trackRecord = new OrgChangeApplicationStore(database)
          .listForWorkspace(selectedWorkspace)
          .filter((application) => application.status === "verified").length;
        printJson(write, {
          org_id: orgId,
          autonomy_level: new OrganizationStore(database).get(orgId)?.autonomy_level ?? null,
          verified_track_record: trackRecord,
          cases: new AutonomyCaseStore(database).listForWorkspace(selectedWorkspace),
        });
        return 0;
      }
      if (subcommand === "propose") {
        const rationale = optionValue(args, "--rationale");
        if (!rationale) {
          throw new Error("autonomy propose requires --rationale");
        }
        const evidenceRef = optionValue(args, "--evidence");
        printJson(
          write,
          autonomy.proposeWidening({
            workspace_id: selectedWorkspace,
            org_id: orgId,
            proposed_by: actor,
            rationale,
            evidence: evidenceRef
              ? [{ kind: "event", ref_id: evidenceRef, summary: rationale, weight: 1 }]
              : [],
          }),
        );
        return 0;
      }
      if (subcommand === "ratify") {
        const caseId = positions[2];
        if (!caseId) {
          throw new Error("autonomy ratify requires a case id");
        }
        printJson(
          write,
          autonomy.ratifyWidening(caseId, { workspace_id: selectedWorkspace, actor }),
        );
        return 0;
      }
      if (subcommand === "reject") {
        const caseId = positions[2];
        if (!caseId) {
          throw new Error("autonomy reject requires a case id");
        }
        printJson(
          write,
          autonomy.rejectWidening(caseId, { workspace_id: selectedWorkspace, actor }),
        );
        return 0;
      }
      if (subcommand === "narrow") {
        const toLevel = optionValue(args, "--to");
        if (toLevel !== "advisory" && toLevel !== "supervised" && toLevel !== "bounded") {
          throw new Error("autonomy narrow requires --to advisory|supervised|bounded");
        }
        printJson(
          write,
          autonomy.narrow({
            workspace_id: selectedWorkspace,
            org_id: orgId,
            to_level: toLevel,
            actor,
          }),
        );
        return 0;
      }
      throw new Error(`unknown autonomy subcommand: ${subcommand}`);
    }
    if (command === "hermes-demo") {
      const result = await runHermesDogfoodDemo(database, (line) =>
        write(line.replace(/\n+$/, "")),
      );
      printJson(write, result);
      return 0;
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
          await spine.resumeApprovedCapability(approvalId, { workspace_id: selectedWorkspace }),
        );
      } else if (
        approval?.payload.target_type === "capability_call" &&
        approval.run_id === REFERENCE_RUN_ID
      ) {
        printJson(write, await approveReferenceWorkerDemo(database));
      } else if (approval?.payload.target_type === "capability_call") {
        new ApprovalService(database).approve(approvalId, {
          workspace_id: selectedWorkspace,
          actor: "cli_operator",
        });
        printJson(
          write,
          await createConfiguredCapabilityRegistry(database).resumeApprovedCall(approvalId, {
            workspace_id: selectedWorkspace,
          }),
        );
      } else if (approvalId === PROMOTION_APPROVAL_ID) {
        requireDefaultWorkspace(selectedWorkspace);
        printJson(write, spine.resumeDemo(approvalId));
      } else {
        printJson(
          write,
          createApprovalServiceWithApplications(database).approve(approvalId, {
            workspace_id: selectedWorkspace,
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

    throw new Error(`unknown command: ${args.join(" ")}`);
  } finally {
    database.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
