import { CapabilityCallSchema, CapabilitySchema, type Event } from "../contracts/index.js";
import { DiagnosisService } from "../diagnosis/index.js";
import { ApprovalService } from "../governance/index.js";
import type { Database } from "../persistence/index.js";
import { EventStore } from "../persistence/index.js";
import { createLocalCapabilityRegistry } from "../runtime/capabilities.js";
import { SpineService, WORKSPACE_ID } from "../spine/index.js";
import { WorkService } from "../work/index.js";

const WORKER_ID = "worker_77777777777777777777777777777777";
const RUN_ID = "run_77777777777777777777777777777777";
const TASK_ID = "task_77777777777777777777777777777777";
const WORK_ID = "work_77777777777777777777777777777777";
const ENVELOPE_ID = "envelope_77777777777777777777777777777777";
const CAP = "github.create_issue_comment";
const HANDLE = "cred_mock_side_effect";

export type HermesDogfoodDemoResult = {
  granted_call: { outcome: string; executed: boolean };
  out_of_scope_call: { outcome: string };
  diagnosis_traces_to_creation: boolean;
  event_kinds: string[];
};

/**
 * A narrated, deterministic walk through the external-worker dogfood: OpenMAO "hires" a worker,
 * issues it a bounded envelope scoped to ONE repo, governs a side effect (suspend → approve →
 * execute once), then blocks an out-of-scope attempt and diagnoses the resulting failure.
 *
 * It runs in-process for determinism (no credentials, no network). The SAME flow runs out of
 * process over the loopback HTTP API via `ExternalWorkerClient` — see the
 * `external_worker_client_e2e` test for the on-the-wire proof. Swap the mock provider for the real
 * `GitHubProvider` (OPENMAO_GITHUB_ENABLED=1) and the governed side effect becomes a real comment.
 */
export async function runHermesDogfoodDemo(
  database: Database,
  write: (line: string) => void = () => {},
): Promise<HermesDogfoodDemoResult> {
  const spine = new SpineService(database);
  spine.initDemoWorkspace();
  const work = new WorkService(database);
  const registry = createLocalCapabilityRegistry(database);
  const approvals = new ApprovalService(database);
  const events = new EventStore(database);

  write("OpenMAO hires an external worker and governs one real side effect.\n");

  // A side-effecting capability scoped by resource fields (owner, repo).
  registry.register(
    CapabilitySchema.parse({
      name: CAP,
      workspace_id: WORKSPACE_ID,
      description: "Post a comment on a GitHub issue (mock provider in the demo).",
      tool_name: "mock.side_effect",
      canonical_input_schema: {
        type: "object",
        required: [],
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          body: { type: "string" },
        },
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
      default_permission: "approval_required",
      resource_fields: ["owner", "repo"],
    }),
  );

  work.registerWorker({
    id: WORKER_ID,
    workspace_id: WORKSPACE_ID,
    name: "Hermes",
    runtime: "hermes.agent",
    allowed_capabilities: [CAP],
    actor: "operator:local",
    idempotency_key: "hermes-demo:worker",
  });
  const item = work.createWork({
    id: WORK_ID,
    workspace_id: WORKSPACE_ID,
    title: "Reply to a maintainer thread",
    objective: "Post one governed comment on the project's own repo.",
    owner: WORKER_ID,
    reviewer: "human",
    risk_level: "high",
    actor: "operator:local",
    idempotency_key: "hermes-demo:work",
  });
  work.assignWork({
    workspace_id: WORKSPACE_ID,
    work_item_id: item.id,
    owner: WORKER_ID,
    reviewer: "human",
    actor: "operator:local",
    idempotency_key: "hermes-demo:assign",
  });
  work.ensureExternalRun({
    id: RUN_ID,
    workspace_id: WORKSPACE_ID,
    active_node: "hermes_demo",
    actor: "operator:local",
  });
  // The bounded envelope pins the capability to EXACTLY one repo — the worker can comment on
  // aeonbilal/OpenMAO and nowhere else.
  work.createBoundedEnvelope({
    id: ENVELOPE_ID,
    workspace_id: WORKSPACE_ID,
    work_item_id: item.id,
    run_id: RUN_ID,
    task_envelope_id: TASK_ID,
    worker_id: WORKER_ID,
    issued_by: { actor_type: "operator", actor_id: "operator:local", display_name: null },
    allowed_capabilities: [CAP],
    resource_grants: { [CAP]: { owner: ["aeonbilal"], repo: ["OpenMAO"] } },
    idempotency_key: "hermes-demo:envelope",
  });
  write(`  Issued a bounded envelope: ${CAP} on aeonbilal/OpenMAO only.\n`);

  function buildCall(id: string, input: Record<string, unknown>, key: string) {
    return CapabilityCallSchema.parse({
      id,
      workspace_id: WORKSPACE_ID,
      run_id: RUN_ID,
      capability_name: CAP,
      provider: "mock.side_effect",
      input,
      requested_by: WORKER_ID,
      external_actor: { actor_type: "worker", actor_id: WORKER_ID, display_name: "Hermes" },
      task_id: TASK_ID,
      credential_handle: HANDLE,
      side_effecting: true,
      risk_level: "high",
      idempotency_key: key,
    });
  }

  // 1. In-scope request → suspends for human approval (governed; nothing executed yet).
  const grantedInput = {
    owner: "aeonbilal",
    repo: "OpenMAO",
    body: "Thanks — governed by OpenMAO.",
  };
  const suspended = await registry.invoke(
    buildCall("capcall_77777777777777777777777777777777", grantedInput, "hermes-demo:call:granted"),
  );
  write(
    `  Worker requests the comment → ${suspended.decision.outcome} (suspended for approval).\n`,
  );

  // 2. Operator approves → the side effect executes exactly once.
  let executed = false;
  if (suspended.approval_id) {
    approvals.approve(suspended.approval_id, { workspace_id: WORKSPACE_ID, actor: "human" });
    const resumed = await registry.resumeApprovedCall(suspended.approval_id, {
      workspace_id: WORKSPACE_ID,
    });
    executed = resumed.result?.status === "ok";
    write(`  Human approves → side effect executes once (result: ${resumed.result?.status}).\n`);
  }
  work.submitWorkerOutcome({
    workspace_id: WORKSPACE_ID,
    envelope_id: ENVELOPE_ID,
    worker_id: WORKER_ID,
    status: "completed",
    summary: "Posted the governed comment.",
    idempotency_key: "hermes-demo:outcome:done",
  });

  // 3. Out-of-scope attempt → blocked by the resource grant (cannot touch another repo).
  const outOfScope = await registry.invoke(
    buildCall(
      "capcall_88888888888888888888888888888888",
      { owner: "aeonbilal", repo: "some-other-repo", body: "nope" },
      "hermes-demo:call:out-of-scope",
    ),
  );
  write(`  Worker tries another repo → ${outOfScope.decision.outcome} (outside its grant).\n`);

  // 4. The worker reports the blocker as a failed outcome, which OpenMAO can diagnose.
  const failure = work.submitWorkerOutcome({
    workspace_id: WORKSPACE_ID,
    envelope_id: ENVELOPE_ID,
    worker_id: WORKER_ID,
    status: "failed",
    summary: "Blocked from acting outside the bounded repo grant.",
    idempotency_key: "hermes-demo:outcome:failed",
  });
  const failureEvent = events
    .listForWorkspace(WORKSPACE_ID)
    .find(
      (event: Event) =>
        event.kind === "work.outcome_submitted" &&
        (event.payload.data.worker_outcome as { id?: string } | undefined)?.id === failure.id,
    );
  let tracesToCreation = false;
  if (failureEvent) {
    const diagnosis = new DiagnosisService(database).diagnose({
      workspace_id: WORKSPACE_ID,
      failure_event_id: failureEvent.id,
    });
    const created = events
      .listForWorkspace(WORKSPACE_ID)
      .find((event: Event) => event.kind === "work.created");
    tracesToCreation =
      created !== undefined &&
      diagnosis.candidates.some((candidate) => candidate.event_id === created.id);
    write(`  Diagnose the failure → traces back to the work's creation: ${tracesToCreation}.\n`);
  }

  const eventKinds = events.listForWorkspace(WORKSPACE_ID).map((event: Event) => event.kind);
  write(`  Full audit trail recorded: ${eventKinds.length} events.\n`);

  return {
    granted_call: { outcome: suspended.decision.outcome, executed },
    out_of_scope_call: { outcome: outOfScope.decision.outcome },
    diagnosis_traces_to_creation: tracesToCreation,
    event_kinds: eventKinds,
  };
}
