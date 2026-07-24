import { randomBytes } from "node:crypto";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

import { ChiefOfStaffService } from "../chief_of_staff/index.js";
import { utcNow } from "../contracts/index.js";
import { ApprovalService } from "../governance/index.js";
import { IngestionService } from "../ingestion/index.js";
import { LearningService } from "../learning/index.js";
import { MemoryRetrievalService, PromotionService } from "../memory/index.js";
import { OrgChangeService } from "../org/index.js";
import {
  AgentStore,
  BoundedWorkEnvelopeStore,
  CapabilityCallStore,
  CapabilityResultStore,
  CapabilityStore,
  type Database,
  EventStore,
  IngestionRecordStore,
  MemoryEntryStore,
  OrganizationStore,
  OrgChangeProposalStore,
  PromotionCandidateStore,
  RoleStore,
  RunStore,
  TraceStore,
  WorkerIdentityStore,
  WorkerOutcomeStore,
  WorkItemStore,
  WorkspaceStore,
} from "../persistence/index.js";
import { createApprovalServiceWithApplications } from "../runtime/approvals.js";
import {
  createConfiguredCapabilityRegistry,
  materializeRejectedCapabilityApproval,
} from "../runtime/capabilities.js";
import { openLocalDatabase } from "../runtime/local.js";
import {
  COORDINATOR_AGENT_ID,
  PROMOTION_APPROVAL_ID,
  RUN_ID,
  SpineService,
  WORKSPACE_ID,
} from "../spine/index.js";
import { WorkService } from "../work/index.js";
import {
  approveReferenceWorkerDemo,
  REFERENCE_RUN_ID,
  runReferenceWorkerDemo,
} from "../workers/index.js";
import { WorldModelService } from "../world/index.js";

type ServerOptions = {
  dbPath?: string;
  operatorToken?: string;
  workspaceId?: string;
};

const DEFAULT_HTTP_HOST = "127.0.0.1";
const TOKEN_HEADER = "x-openmao-operator-token";
const ACTOR_HEADER = "x-openmao-actor";
const WORKSPACE_HEADER = "x-openmao-workspace";
const LEGACY_WORKSPACE_HEADER = "x-openmao-workspace-id";
const CONSOLE_ACTOR = "local_operator";

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value, null, 2));
}

function sendHtml(response: ServerResponse, html: string): void {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(html);
}

function sendNotFound(response: ServerResponse): void {
  sendJson(response, 404, { error: "not_found" });
}

function routePattern(pathname: string): {
  approvalId: string | undefined;
  cosNotificationReadId: string | undefined;
  individualMemoryAgentId: string | undefined;
  learningProposalApplyId: string | undefined;
  learningProposalId: string | undefined;
  promotionCorroborateId: string | undefined;
  runEventsId: string | undefined;
  runId: string | undefined;
  runResumeId: string | undefined;
  runTracesId: string | undefined;
  workEnvelopeId: string | undefined;
  workId: string | undefined;
  workOutcomeId: string | undefined;
  workspaceEventsId: string | undefined;
} {
  const approvalMatch = /^\/approvals\/([^/]+)\/(?:approve|reject)$/.exec(pathname);
  const cosNotificationReadMatch = /^\/cos\/notifications\/([^/]+)\/read$/.exec(pathname);
  const runEventsMatch = /^\/runs\/([^/]+)\/events$/.exec(pathname);
  const runResumeMatch = /^\/runs\/([^/]+)\/resume$/.exec(pathname);
  const runTracesMatch = /^\/runs\/([^/]+)\/traces$/.exec(pathname);
  const runMatch = /^\/runs\/([^/]+)$/.exec(pathname);
  const workEnvelopeMatch = /^\/work\/([^/]+)\/envelopes$/.exec(pathname);
  const workOutcomeMatch = /^\/work\/([^/]+)\/outcomes$/.exec(pathname);
  const workMatch = /^\/work\/([^/]+)(?:\/(?:assign|status|review))?$/.exec(pathname);
  const workspaceEventsMatch = /^\/workspaces\/([^/]+)\/events$/.exec(pathname);
  const individualMemoryMatch = /^\/memory\/individual\/([^/]+)$/.exec(pathname);
  const learningProposalApplyMatch = /^\/learning\/proposals\/([^/]+)\/apply$/.exec(pathname);
  const learningProposalMatch = /^\/learning\/proposals\/([^/]+)$/.exec(pathname);
  const promotionCorroborateMatch = /^\/memory\/promotions\/([^/]+)\/corroborate$/.exec(pathname);
  return {
    approvalId: approvalMatch?.[1],
    cosNotificationReadId: cosNotificationReadMatch?.[1],
    individualMemoryAgentId: individualMemoryMatch?.[1],
    learningProposalApplyId: learningProposalApplyMatch?.[1],
    learningProposalId: learningProposalMatch?.[1],
    promotionCorroborateId: promotionCorroborateMatch?.[1],
    runEventsId: runEventsMatch?.[1],
    runId: runMatch?.[1],
    runResumeId: runResumeMatch?.[1],
    runTracesId: runTracesMatch?.[1],
    workEnvelopeId: workEnvelopeMatch?.[1],
    workId: workMatch?.[1],
    workOutcomeId: workOutcomeMatch?.[1],
    workspaceEventsId: workspaceEventsMatch?.[1],
  };
}

function isLoopbackAddress(address: string | undefined): boolean {
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1" ||
    address?.startsWith("127.") === true
  );
}

function headerValue(request: IncomingMessage, name: string): string | null {
  const raw = request.headers[name];
  if (Array.isArray(raw)) {
    return raw[0] ?? null;
  }
  return raw ?? null;
}

function requestContext(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  options: Required<Pick<ServerOptions, "operatorToken" | "workspaceId">>,
): { actor: string; explicitWorkspace: boolean; workspaceId: string } | null {
  if (headerValue(request, TOKEN_HEADER) !== options.operatorToken) {
    sendJson(response, 403, { error: "forbidden" });
    return null;
  }

  const actor = headerValue(request, ACTOR_HEADER);
  if (!actor) {
    sendJson(response, 400, { error: "missing_actor" });
    return null;
  }

  const selectedWorkspace =
    headerValue(request, WORKSPACE_HEADER) ??
    headerValue(request, LEGACY_WORKSPACE_HEADER) ??
    url.searchParams.get("workspace_id");
  return {
    actor,
    workspaceId: selectedWorkspace ?? options.workspaceId,
    explicitWorkspace: selectedWorkspace !== null,
  };
}

function requireDemoWorkspace(
  response: ServerResponse,
  workspaceId: string,
): workspaceId is typeof WORKSPACE_ID {
  if (workspaceId === WORKSPACE_ID) {
    return true;
  }
  sendJson(response, 400, { error: "unsupported_demo_workspace", workspace_id: workspaceId });
  return false;
}

function ensureDefaultWorkspace(
  spine: SpineService,
  database: Database,
  workspaceId: string,
): void {
  if (workspaceId === WORKSPACE_ID && !new WorkspaceStore(database).get(WORKSPACE_ID)) {
    spine.initDemoWorkspace();
  }
}

function runForContext(database: Database, runId: string, workspaceId: string) {
  const run = new RunStore(database).get(runId);
  return run?.workspace_id === workspaceId ? run : null;
}

function approvalForContext(database: Database, approvalId: string, workspaceId: string) {
  const approval = new ApprovalService(database).approvals.get(approvalId);
  return approval?.workspace_id === workspaceId ? approval : null;
}

function workForContext(database: Database, workId: string, workspaceId: string) {
  const work = new WorkItemStore(database).get(workId);
  return work?.workspace_id === workspaceId ? work : null;
}

function requireUnambiguousWriteWorkspace(
  response: ServerResponse,
  database: Database,
  context: { explicitWorkspace: boolean },
): boolean {
  if (!context.explicitWorkspace && new WorkspaceStore(database).listAll().length > 1) {
    sendJson(response, 400, { error: "workspace_required" });
    return false;
  }
  return true;
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return {};
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function createServer(options: ServerOptions = {}) {
  const resolvedOptions = {
    operatorToken:
      options.operatorToken ??
      process.env.OPENMAO_OPERATOR_TOKEN ??
      randomBytes(16).toString("hex"),
    workspaceId: options.workspaceId ?? WORKSPACE_ID,
  };

  return createHttpServer(async (request: IncomingMessage, response: ServerResponse) => {
    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      sendJson(response, 403, { error: "loopback_only" });
      return;
    }

    const database = openLocalDatabase(options.dbPath);
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      const spine = new SpineService(database);
      const approvalRoute = routePattern(url.pathname);

      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, { ok: true });
        return;
      }
      if (request.method === "GET" && url.pathname === "/console") {
        sendHtml(response, consoleHtml());
        return;
      }

      const context = requestContext(request, response, url, resolvedOptions);
      if (!context) {
        return;
      }

      if (request.method === "POST" && url.pathname === "/runs/demo") {
        if (!requireUnambiguousWriteWorkspace(response, database, context)) {
          return;
        }
        if (!requireDemoWorkspace(response, context.workspaceId)) {
          return;
        }
        sendJson(response, 200, await spine.startDemo());
        return;
      }
      if (request.method === "POST" && url.pathname === "/runs/demo/approve") {
        if (!requireUnambiguousWriteWorkspace(response, database, context)) {
          return;
        }
        if (!requireDemoWorkspace(response, context.workspaceId)) {
          return;
        }
        sendJson(response, 200, spine.resumeDemo(PROMOTION_APPROVAL_ID, { actor: context.actor }));
        return;
      }
      if (request.method === "GET" && url.pathname === "/workspaces") {
        ensureDefaultWorkspace(spine, database, context.workspaceId);
        sendJson(response, 200, new WorkspaceStore(database).listAll());
        return;
      }
      if (request.method === "GET" && url.pathname === "/workspaces/current") {
        ensureDefaultWorkspace(spine, database, context.workspaceId);
        sendJson(response, 200, new WorkspaceStore(database).get(context.workspaceId));
        return;
      }
      if (request.method === "GET" && url.pathname === "/org") {
        ensureDefaultWorkspace(spine, database, context.workspaceId);
        sendJson(response, 200, {
          organizations: new OrganizationStore(database).listForWorkspace(context.workspaceId),
          roles: new RoleStore(database).listForWorkspace(context.workspaceId),
          agents: new AgentStore(database).listForWorkspace(context.workspaceId),
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/agents") {
        ensureDefaultWorkspace(spine, database, context.workspaceId);
        sendJson(response, 200, new AgentStore(database).listForWorkspace(context.workspaceId));
        return;
      }
      if (request.method === "GET" && url.pathname === "/capabilities") {
        ensureDefaultWorkspace(spine, database, context.workspaceId);
        sendJson(
          response,
          200,
          new CapabilityStore(database).listForWorkspace(context.workspaceId),
        );
        return;
      }
      if (request.method === "GET" && url.pathname === "/capability-calls") {
        sendJson(
          response,
          200,
          new CapabilityCallStore(database).listForWorkspace(context.workspaceId),
        );
        return;
      }
      if (request.method === "GET" && url.pathname === "/capability-results") {
        sendJson(
          response,
          200,
          new CapabilityResultStore(database).listForWorkspace(context.workspaceId),
        );
        return;
      }
      if (request.method === "GET" && url.pathname === "/workers") {
        sendJson(
          response,
          200,
          new WorkerIdentityStore(database).listForWorkspace(context.workspaceId),
        );
        return;
      }
      if (request.method === "POST" && url.pathname === "/workers") {
        if (!requireUnambiguousWriteWorkspace(response, database, context)) {
          return;
        }
        const body = await readJsonBody(request);
        sendJson(
          response,
          201,
          new WorkService(database).registerWorker({
            id: typeof body.id === "string" ? body.id : null,
            workspace_id: context.workspaceId,
            name: String(body.name ?? ""),
            runtime: String(body.runtime ?? ""),
            version: typeof body.version === "string" ? body.version : null,
            role_id: typeof body.role_id === "string" ? body.role_id : null,
            allowed_capabilities: stringArray(body.allowed_capabilities),
            actor: context.actor,
            idempotency_key: typeof body.idempotency_key === "string" ? body.idempotency_key : null,
          }),
        );
        return;
      }
      if (request.method === "POST" && url.pathname === "/workers/reference-demo") {
        if (!requireUnambiguousWriteWorkspace(response, database, context)) {
          return;
        }
        if (!requireDemoWorkspace(response, context.workspaceId)) {
          return;
        }
        sendJson(response, 200, await runReferenceWorkerDemo(database));
        return;
      }
      if (request.method === "POST" && url.pathname === "/workers/reference-demo/approve") {
        if (!requireUnambiguousWriteWorkspace(response, database, context)) {
          return;
        }
        if (!requireDemoWorkspace(response, context.workspaceId)) {
          return;
        }
        sendJson(response, 200, await approveReferenceWorkerDemo(database));
        return;
      }
      if (request.method === "GET" && url.pathname === "/ingestion") {
        sendJson(
          response,
          200,
          new IngestionRecordStore(database).listForWorkspace(context.workspaceId),
        );
        return;
      }
      if (request.method === "POST" && url.pathname === "/ingestion") {
        if (!requireUnambiguousWriteWorkspace(response, database, context)) {
          return;
        }
        const body = await readJsonBody(request);
        const source = body.source && typeof body.source === "object" ? body.source : {};
        const actor = body.actor && typeof body.actor === "object" ? body.actor : {};
        const payload = body.payload;
        const sourceProvider = stringField((source as { provider?: unknown }).provider);
        const sourceId = stringField((source as { external_id?: unknown }).external_id);
        const sourceUrl = stringField((source as { external_url?: unknown }).external_url);
        const actorType = stringField((actor as { actor_type?: unknown }).actor_type);
        const actorId = stringField((actor as { actor_id?: unknown }).actor_id);
        const idempotencyKey = stringField(body.idempotency_key);
        if (!sourceProvider) {
          sendJson(response, 400, { error: "missing_source_provider" });
          return;
        }
        if (!sourceId && !sourceUrl) {
          sendJson(response, 400, { error: "missing_source_identity" });
          return;
        }
        if (!actorType || !actorId) {
          sendJson(response, 400, { error: "missing_actor_identity" });
          return;
        }
        if (!idempotencyKey) {
          sendJson(response, 400, { error: "missing_idempotency_key" });
          return;
        }
        sendJson(
          response,
          201,
          new IngestionService(database).record({
            id: typeof body.id === "string" ? body.id : null,
            workspace_id: context.workspaceId,
            source: {
              provider: sourceProvider,
              external_id: sourceId,
              external_url: sourceUrl,
            },
            actor: {
              actor_type: actorType as never,
              actor_id: actorId,
              display_name:
                typeof (actor as { display_name?: unknown }).display_name === "string"
                  ? (actor as { display_name: string }).display_name
                  : null,
            },
            kind: String(body.kind ?? "event") as never,
            target_run_id: typeof body.target_run_id === "string" ? body.target_run_id : null,
            target_work_item_id:
              typeof body.target_work_item_id === "string" ? body.target_work_item_id : null,
            payload:
              payload && typeof payload === "object" && !Array.isArray(payload)
                ? (payload as Record<string, unknown>)
                : {},
            idempotency_key: idempotencyKey,
          }),
        );
        return;
      }
      if (request.method === "GET" && url.pathname === "/runs") {
        ensureDefaultWorkspace(spine, database, context.workspaceId);
        sendJson(response, 200, new RunStore(database).listForWorkspace(context.workspaceId));
        return;
      }
      if (request.method === "GET" && approvalRoute.runId) {
        const run = runForContext(database, approvalRoute.runId, context.workspaceId);
        if (!run) {
          sendNotFound(response);
          return;
        }
        sendJson(response, 200, run);
        return;
      }
      if (request.method === "POST" && approvalRoute.runResumeId) {
        if (!requireUnambiguousWriteWorkspace(response, database, context)) {
          return;
        }
        if (!runForContext(database, approvalRoute.runResumeId, context.workspaceId)) {
          sendNotFound(response);
          return;
        }
        sendJson(
          response,
          200,
          await spine.resumeRun(approvalRoute.runResumeId, { actor: context.actor }),
        );
        return;
      }
      if (request.method === "GET" && approvalRoute.runEventsId) {
        sendJson(
          response,
          200,
          new EventStore(database).listForRun(context.workspaceId, approvalRoute.runEventsId),
        );
        return;
      }
      if (request.method === "GET" && approvalRoute.runTracesId) {
        const run = runForContext(database, approvalRoute.runTracesId, context.workspaceId);
        if (!run) {
          sendNotFound(response);
          return;
        }
        sendJson(response, 200, new TraceStore(database).listForRun(approvalRoute.runTracesId));
        return;
      }
      if (request.method === "GET" && approvalRoute.workspaceEventsId) {
        if (approvalRoute.workspaceEventsId !== context.workspaceId) {
          sendNotFound(response);
          return;
        }
        sendJson(
          response,
          200,
          new EventStore(database).listForWorkspace(approvalRoute.workspaceEventsId),
        );
        return;
      }
      if (request.method === "GET" && url.pathname === "/work") {
        ensureDefaultWorkspace(spine, database, context.workspaceId);
        sendJson(response, 200, new WorkItemStore(database).listForWorkspace(context.workspaceId));
        return;
      }
      if (request.method === "POST" && url.pathname === "/work") {
        if (!requireUnambiguousWriteWorkspace(response, database, context)) {
          return;
        }
        const body = await readJsonBody(request);
        sendJson(
          response,
          201,
          new WorkService(database).createWork({
            id: typeof body.id === "string" ? body.id : null,
            workspace_id: context.workspaceId,
            title: String(body.title ?? ""),
            objective: String(body.objective ?? ""),
            owner: String(body.owner ?? ""),
            reviewer: typeof body.reviewer === "string" ? body.reviewer : null,
            priority: (body.priority ?? "medium") as never,
            risk_level: (body.risk_level ?? "low") as never,
            success_criteria: stringArray(body.success_criteria),
            actor: context.actor,
            idempotency_key: typeof body.idempotency_key === "string" ? body.idempotency_key : null,
          }),
        );
        return;
      }
      if (request.method === "GET" && approvalRoute.workId) {
        const work = new WorkItemStore(database).get(approvalRoute.workId);
        if (!work || work.workspace_id !== context.workspaceId) {
          sendNotFound(response);
          return;
        }
        sendJson(response, 200, work);
        return;
      }
      if (request.method === "POST" && approvalRoute.workId && url.pathname.endsWith("/assign")) {
        if (!requireUnambiguousWriteWorkspace(response, database, context)) {
          return;
        }
        const body = await readJsonBody(request);
        sendJson(
          response,
          200,
          new WorkService(database).assignWork({
            workspace_id: context.workspaceId,
            work_item_id: approvalRoute.workId,
            owner: String(body.owner ?? ""),
            reviewer: typeof body.reviewer === "string" ? body.reviewer : null,
            actor: context.actor,
            idempotency_key: typeof body.idempotency_key === "string" ? body.idempotency_key : null,
          }),
        );
        return;
      }
      if (request.method === "POST" && approvalRoute.workId && url.pathname.endsWith("/status")) {
        if (!requireUnambiguousWriteWorkspace(response, database, context)) {
          return;
        }
        const body = await readJsonBody(request);
        sendJson(
          response,
          200,
          new WorkService(database).setStatus({
            workspace_id: context.workspaceId,
            work_item_id: approvalRoute.workId,
            status: String(body.status ?? "") as never,
            reason: typeof body.reason === "string" ? body.reason : null,
            actor: context.actor,
            idempotency_key: typeof body.idempotency_key === "string" ? body.idempotency_key : null,
          }),
        );
        return;
      }
      if (request.method === "POST" && approvalRoute.workId && url.pathname.endsWith("/review")) {
        if (!requireUnambiguousWriteWorkspace(response, database, context)) {
          return;
        }
        const body = await readJsonBody(request);
        sendJson(
          response,
          200,
          new WorkService(database).reviewWork({
            workspace_id: context.workspaceId,
            work_item_id: approvalRoute.workId,
            decision: String(body.decision ?? "") as never,
            notes: typeof body.notes === "string" ? body.notes : null,
            actor: context.actor,
            idempotency_key: typeof body.idempotency_key === "string" ? body.idempotency_key : null,
          }),
        );
        return;
      }
      if (request.method === "GET" && approvalRoute.workOutcomeId) {
        if (!workForContext(database, approvalRoute.workOutcomeId, context.workspaceId)) {
          sendNotFound(response);
          return;
        }
        sendJson(
          response,
          200,
          new WorkerOutcomeStore(database).listForWorkItem(
            context.workspaceId,
            approvalRoute.workOutcomeId,
          ),
        );
        return;
      }
      if (request.method === "POST" && approvalRoute.workOutcomeId) {
        if (!requireUnambiguousWriteWorkspace(response, database, context)) {
          return;
        }
        const body = await readJsonBody(request);
        const output = body.output;
        sendJson(
          response,
          201,
          new WorkService(database).submitWorkerOutcome({
            id: typeof body.id === "string" ? body.id : null,
            workspace_id: context.workspaceId,
            envelope_id: String(body.envelope_id ?? ""),
            worker_id: String(body.worker_id ?? ""),
            status: String(body.status ?? "completed") as never,
            summary: String(body.summary ?? ""),
            output:
              output && typeof output === "object" && !Array.isArray(output)
                ? (output as Record<string, unknown>)
                : {},
            actor: context.actor,
            idempotency_key:
              typeof body.idempotency_key === "string"
                ? body.idempotency_key
                : `work:${approvalRoute.workOutcomeId}:outcome:${String(body.envelope_id ?? "")}`,
          }),
        );
        return;
      }
      if (request.method === "GET" && approvalRoute.workEnvelopeId) {
        if (!workForContext(database, approvalRoute.workEnvelopeId, context.workspaceId)) {
          sendNotFound(response);
          return;
        }
        sendJson(
          response,
          200,
          new BoundedWorkEnvelopeStore(database).listForWorkItem(
            context.workspaceId,
            approvalRoute.workEnvelopeId,
          ),
        );
        return;
      }
      if (request.method === "POST" && approvalRoute.workEnvelopeId) {
        if (!requireUnambiguousWriteWorkspace(response, database, context)) {
          return;
        }
        const body = await readJsonBody(request);
        const input = body.input;
        sendJson(
          response,
          201,
          new WorkService(database).createBoundedEnvelope({
            id: typeof body.id === "string" ? body.id : null,
            workspace_id: context.workspaceId,
            work_item_id: approvalRoute.workEnvelopeId,
            run_id: typeof body.run_id === "string" ? body.run_id : null,
            worker_id: String(body.worker_id ?? ""),
            issued_by: { actor_type: "operator", actor_id: context.actor, display_name: null },
            allowed_capabilities: stringArray(body.allowed_capabilities),
            input:
              input && typeof input === "object" && !Array.isArray(input)
                ? (input as Record<string, unknown>)
                : {},
            idempotency_key: typeof body.idempotency_key === "string" ? body.idempotency_key : null,
          }),
        );
        return;
      }
      if (request.method === "GET" && approvalRoute.individualMemoryAgentId) {
        sendJson(
          response,
          200,
          new MemoryEntryStore(database)
            .listForWorkspace(context.workspaceId)
            .filter(
              (entry) =>
                entry.scope === "individual" &&
                entry.owner_id === approvalRoute.individualMemoryAgentId,
            ),
        );
        return;
      }
      if (request.method === "GET" && url.pathname === "/memory/collective") {
        sendJson(
          response,
          200,
          new MemoryEntryStore(database)
            .listForWorkspace(context.workspaceId)
            .filter((entry) => entry.scope === "collective"),
        );
        return;
      }
      if (request.method === "GET" && url.pathname === "/memory/promotions") {
        sendJson(
          response,
          200,
          new PromotionCandidateStore(database).listForWorkspace(context.workspaceId),
        );
        return;
      }
      if (request.method === "GET" && url.pathname === "/memory/search") {
        const scope = url.searchParams.get("scope");
        const kind = url.searchParams.get("kind");
        const owner = url.searchParams.get("owner_id");
        const minConfidence = url.searchParams.get("min_confidence");
        const limit = url.searchParams.get("limit");
        sendJson(
          response,
          200,
          new MemoryRetrievalService(database).search(
            context.workspaceId,
            url.searchParams.get("q") ?? url.searchParams.get("query") ?? "",
            {
              ...(scope ? { scope: scope as never } : {}),
              ...(kind ? { kind: kind as never } : {}),
              ...(minConfidence !== null ? { min_confidence: Number(minConfidence) } : {}),
              ...(owner ? { owner_id: owner } : {}),
              ...(limit !== null ? { limit: Number(limit) } : {}),
            },
          ),
        );
        return;
      }
      if (request.method === "POST" && approvalRoute.promotionCorroborateId) {
        if (!requireUnambiguousWriteWorkspace(response, database, context)) {
          return;
        }
        const body = await readJsonBody(request);
        const sourceMemoryEntry =
          typeof body.source_memory_entry === "string" ? body.source_memory_entry : "";
        if (!sourceMemoryEntry) {
          sendJson(response, 400, { error: "missing_source_memory_entry" });
          return;
        }
        const corroborateCandidate = new PromotionCandidateStore(database).get(
          approvalRoute.promotionCorroborateId,
        );
        if (!corroborateCandidate || corroborateCandidate.workspace_id !== context.workspaceId) {
          sendNotFound(response);
          return;
        }
        sendJson(
          response,
          200,
          new PromotionService(database).recordCorroboration(approvalRoute.promotionCorroborateId, {
            source_memory_entry: sourceMemoryEntry,
            corroborated_by: context.actor,
            run_id: typeof body.run_id === "string" ? body.run_id : null,
            note: typeof body.note === "string" ? body.note : null,
            corroboration_id:
              typeof body.corroboration_id === "string" ? body.corroboration_id : null,
            ...(typeof body.strength === "number" ? { strength: body.strength } : {}),
          }),
        );
        return;
      }
      if (request.method === "GET" && url.pathname === "/learning/proposals") {
        sendJson(
          response,
          200,
          new OrgChangeProposalStore(database).listForWorkspace(context.workspaceId),
        );
        return;
      }
      if (request.method === "POST" && url.pathname === "/learning/scan") {
        if (!requireUnambiguousWriteWorkspace(response, database, context)) {
          return;
        }
        sendJson(response, 200, new LearningService(database).scan(context.workspaceId));
        return;
      }
      if (request.method === "GET" && approvalRoute.learningProposalId) {
        const proposal = new OrgChangeProposalStore(database).get(approvalRoute.learningProposalId);
        if (!proposal || proposal.workspace_id !== context.workspaceId) {
          sendNotFound(response);
          return;
        }
        sendJson(response, 200, proposal);
        return;
      }
      if (request.method === "POST" && approvalRoute.learningProposalApplyId) {
        if (!requireUnambiguousWriteWorkspace(response, database, context)) {
          return;
        }
        sendJson(
          response,
          200,
          new OrgChangeService(database).markApplied(approvalRoute.learningProposalApplyId, {
            workspace_id: context.workspaceId,
            actor: context.actor,
          }),
        );
        return;
      }
      if (request.method === "GET" && url.pathname === "/cos/notifications") {
        sendJson(
          response,
          200,
          new ChiefOfStaffService(database).listNotifications(context.workspaceId, {
            unreadOnly: url.searchParams.get("unread") === "1",
          }),
        );
        return;
      }
      if (request.method === "GET" && url.pathname === "/cadences") {
        sendJson(
          response,
          200,
          new ChiefOfStaffService(database).listCadences(context.workspaceId),
        );
        return;
      }
      if (request.method === "POST" && url.pathname === "/cos/init") {
        if (!requireUnambiguousWriteWorkspace(response, database, context)) {
          return;
        }
        sendJson(
          response,
          200,
          new ChiefOfStaffService(database).ensureDefaultCadences(context.workspaceId, utcNow()),
        );
        return;
      }
      if (request.method === "POST" && url.pathname === "/cos/tick") {
        if (!requireUnambiguousWriteWorkspace(response, database, context)) {
          return;
        }
        sendJson(
          response,
          200,
          new ChiefOfStaffService(database).tick({
            workspace_id: context.workspaceId,
            at: utcNow(),
          }),
        );
        return;
      }
      if (request.method === "POST" && approvalRoute.cosNotificationReadId) {
        if (!requireUnambiguousWriteWorkspace(response, database, context)) {
          return;
        }
        const notificationId = approvalRoute.cosNotificationReadId;
        const chiefOfStaff = new ChiefOfStaffService(database);
        if (!chiefOfStaff.getNotification(context.workspaceId, notificationId)) {
          sendNotFound(response);
          return;
        }
        sendJson(
          response,
          200,
          chiefOfStaff.markRead({
            workspace_id: context.workspaceId,
            notification_id: notificationId,
            at: utcNow(),
          }),
        );
        return;
      }
      if (request.method === "GET" && url.pathname === "/approvals") {
        sendJson(
          response,
          200,
          new ApprovalService(database).approvals.listPending(context.workspaceId),
        );
        return;
      }
      if (request.method === "POST" && approvalRoute.approvalId) {
        if (!requireUnambiguousWriteWorkspace(response, database, context)) {
          return;
        }
        const approval = approvalForContext(
          database,
          approvalRoute.approvalId,
          context.workspaceId,
        );
        if (!approval) {
          sendNotFound(response);
          return;
        }
        if (url.pathname.endsWith("/reject")) {
          const rejected = new ApprovalService(database).reject(approvalRoute.approvalId, {
            workspace_id: context.workspaceId,
            actor: context.actor,
          });
          sendJson(
            response,
            200,
            rejected.payload.target_type === "capability_call"
              ? await materializeRejectedCapabilityApproval(database, rejected)
              : rejected,
          );
        } else if (approvalRoute.approvalId === PROMOTION_APPROVAL_ID) {
          if (!requireDemoWorkspace(response, context.workspaceId)) {
            return;
          }
          sendJson(
            response,
            200,
            spine.resumeDemo(approvalRoute.approvalId, { actor: context.actor }),
          );
        } else if (
          approval.payload.target_type === "capability_call" &&
          approval.run_id === RUN_ID
        ) {
          sendJson(
            response,
            200,
            await spine.resumeApprovedCapability(approvalRoute.approvalId, {
              actor: context.actor,
              workspace_id: context.workspaceId,
            }),
          );
        } else if (
          approval.payload.target_type === "capability_call" &&
          approval.run_id === REFERENCE_RUN_ID
        ) {
          sendJson(response, 200, await approveReferenceWorkerDemo(database));
        } else if (approval.payload.target_type === "capability_call") {
          new ApprovalService(database).approve(approvalRoute.approvalId, {
            workspace_id: context.workspaceId,
            actor: context.actor,
          });
          sendJson(
            response,
            200,
            await createConfiguredCapabilityRegistry(database).resumeApprovedCall(
              approvalRoute.approvalId,
              {
                workspace_id: context.workspaceId,
              },
            ),
          );
        } else {
          sendJson(
            response,
            200,
            createApprovalServiceWithApplications(database).approve(approvalRoute.approvalId, {
              workspace_id: context.workspaceId,
              actor: context.actor,
            }),
          );
        }
        return;
      }
      if (request.method === "GET" && url.pathname === "/events") {
        const runId = url.searchParams.get("run_id");
        sendJson(
          response,
          200,
          runId
            ? new EventStore(database).listForRun(context.workspaceId, runId)
            : new EventStore(database).listForWorkspace(context.workspaceId),
        );
        return;
      }
      if (request.method === "GET" && url.pathname === "/world") {
        if (!requireUnambiguousWriteWorkspace(response, database, context)) {
          return;
        }
        ensureDefaultWorkspace(spine, database, context.workspaceId);
        const runId = url.searchParams.get("run_id");
        sendJson(
          response,
          200,
          new WorldModelService(database).rebuild(
            context.workspaceId,
            runId ??
              (new RunStore(database).get(RUN_ID)?.workspace_id === context.workspaceId
                ? RUN_ID
                : null),
          ),
        );
        return;
      }
      sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      database.close();
    }
  });
}

function consoleHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OpenMAO Console</title>
  <style>
    /* OpenMAO design system — foundations lifted from the design handoff
       (colors_and_type.css + components.css + operator-console/console.css).
       IBM Plex via CDN with a robust local + system fallback so the console still
       renders offline. Icons are inlined SVG — no remote scripts. */
    @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap');
    :root {
      color-scheme: light;
      --font-sans: "IBM Plex Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
      --font-mono: "IBM Plex Mono", ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
      --r-xs: 3px; --r-sm: 4px; --r: 6px; --r-md: 8px; --r-lg: 12px; --r-pill: 999px;
      --shadow-sm: 0 1px 3px rgba(16,32,28,.07), 0 1px 2px rgba(16,32,28,.04);
      --shadow-lg: 0 12px 32px rgba(16,32,28,.12), 0 2px 8px rgba(16,32,28,.06);
      --ease: cubic-bezier(.2,0,0,1);
      --dur-fast: 110ms; --dur: 180ms;

      --bg: #ffffff;
      --surface-1: #f6f8f7; --surface-2: #eef2f0; --surface-3: #e6ebe8;
      --fg-1: #16201d; --fg-2: #5b6b64; --fg-3: #8a988f; --fg-on-accent: #ffffff;
      --line: #d8e0dc; --line-strong: #c3cdc8;
      --accent: #0c6b58; --accent-hover: #0a5849; --accent-press: #084536;
      --accent-weak: #e3efe9; --accent-weak-line: #bcdccf;
      --danger: #9f2f2f; --danger-hover: #842626;
      --focus-ring: 0 0 0 3px rgba(12,107,88,.30);
      --terminal-bg: #101716; --terminal-fg: #f4f7f6; --terminal-muted: #8fa39b;

      --state-neutral-fg: #5b6b64; --state-neutral-bg: #eef2f0; --state-neutral-line: #d3dbd7;
      --state-info-fg: #2b5c86;    --state-info-bg: #e7f0f8;    --state-info-line: #c3d9ec;
      --state-pending-fg: #8a5a00; --state-pending-bg: #faf0d7; --state-pending-line: #ecdba8;
      --state-success-fg: #0c6b58; --state-success-bg: #e3efe9; --state-success-line: #bcdccf;
      --state-danger-fg: #9f2f2f;  --state-danger-bg: #f6e4e2;  --state-danger-line: #e8c4c0;

      --autonomy-advisory: #8a988f; --autonomy-supervised: #2f8f74;
      --autonomy-bounded: #0c6b58; --autonomy-board: #0a4a3c;
    }
    [data-theme="dark"] {
      color-scheme: dark;
      --bg: #0c1211; --surface-1: #131b19; --surface-2: #1a2422; --surface-3: #212d2a;
      --fg-1: #eef2f0; --fg-2: #9aa8a1; --fg-3: #6b7a73; --fg-on-accent: #07140f;
      --line: #25302c; --line-strong: #33403b;
      --accent: #2fa98a; --accent-hover: #45b89b; --accent-press: #57c4a8;
      --accent-weak: #122520; --accent-weak-line: #234a3f;
      --danger: #df6f6b; --danger-hover: #e88884;
      --focus-ring: 0 0 0 3px rgba(47,169,138,.34);
      --shadow-sm: 0 1px 3px rgba(0,0,0,.5); --shadow-lg: 0 16px 40px rgba(0,0,0,.6);
      --state-neutral-fg: #9aa8a1; --state-neutral-bg: #1a2422; --state-neutral-line: #2b3733;
      --state-info-fg: #7db4e0;    --state-info-bg: #112330;    --state-info-line: #294a5e;
      --state-pending-fg: #dba94a; --state-pending-bg: #271f0f; --state-pending-line: #4a3d1c;
      --state-success-fg: #46b89a; --state-success-bg: #122520; --state-success-line: #234a3f;
      --state-danger-fg: #e08a86;  --state-danger-bg: #271717;  --state-danger-line: #4d2b29;
      --autonomy-advisory: #7b8b83; --autonomy-supervised: #34a787;
      --autonomy-bounded: #2fa98a; --autonomy-board: #58c9ad;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0; color: var(--fg-1); background: var(--bg);
      font-family: var(--font-sans); -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
    }
    h1, h2, h3, p, button, input, select { font-family: inherit; }

    .btn {
      display: inline-flex; align-items: center; justify-content: center; gap: 8px;
      min-height: 36px; padding: 0 14px; font-size: 14px; font-weight: 500;
      border-radius: var(--r); border: 1px solid var(--line);
      background: var(--bg); color: var(--fg-1); cursor: pointer; white-space: nowrap;
      transition: border-color var(--dur) var(--ease), color var(--dur) var(--ease), background var(--dur) var(--ease);
    }
    .btn:hover { border-color: var(--accent); color: var(--accent); }
    .btn:focus-visible { outline: none; box-shadow: var(--focus-ring); }
    .btn:disabled { opacity: .55; cursor: default; }
    .btn-primary { background: var(--accent); border-color: var(--accent); color: var(--fg-on-accent); }
    .btn-primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); color: var(--fg-on-accent); }
    .btn-danger:hover { border-color: var(--danger); color: var(--danger); }
    .btn-ghost { background: transparent; border-color: transparent; color: var(--fg-2); }
    .btn-ghost:hover { background: var(--surface-2); color: var(--fg-1); }
    .btn-sm { min-height: 28px; padding: 0 10px; font-size: 12.5px; }
    .btn-icon { width: 32px; min-height: 32px; padding: 0; }
    .btn-icon svg { width: 16px; height: 16px; }

    .input {
      min-height: 32px; width: 180px; padding: 0 11px; font-family: var(--font-sans); font-size: 13px;
      color: var(--fg-1); background: var(--bg); border: 1px solid var(--line); border-radius: var(--r);
      transition: border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease);
    }
    .input::placeholder { color: var(--fg-3); }
    .input:focus { outline: none; border-color: var(--accent); box-shadow: var(--focus-ring); }

    .badge {
      display: inline-flex; align-items: center; gap: 6px; height: 22px; padding: 0 9px;
      font-family: var(--font-mono); font-size: 11.5px; font-weight: 500;
      border-radius: var(--r-pill); border: 1px solid; white-space: nowrap;
    }
    .badge .bdot { width: 6px; height: 6px; border-radius: 999px; background: currentColor; flex: none; }
    .badge-neutral { color: var(--state-neutral-fg); background: var(--state-neutral-bg); border-color: var(--state-neutral-line); }
    .badge-info { color: var(--state-info-fg); background: var(--state-info-bg); border-color: var(--state-info-line); }
    .badge-pending { color: var(--state-pending-fg); background: var(--state-pending-bg); border-color: var(--state-pending-line); }
    .badge-success { color: var(--state-success-fg); background: var(--state-success-bg); border-color: var(--state-success-line); }
    .badge-danger { color: var(--state-danger-fg); background: var(--state-danger-bg); border-color: var(--state-danger-line); }
    .tag {
      display: inline-flex; align-items: center; gap: 6px; height: 22px; padding: 0 8px;
      font-family: var(--font-mono); font-size: 11px; font-weight: 500; letter-spacing: .02em; white-space: nowrap;
      border-radius: var(--r-sm); border: 1px solid var(--line); color: var(--fg-2); background: var(--surface-1);
    }
    .autonomy {
      display: inline-flex; align-items: center; height: 24px; padding: 0 10px; border-radius: var(--r-pill);
      font-family: var(--font-mono); font-size: 11.5px; font-weight: 500; color: #fff;
    }
    .autonomy[data-level="advisory"] { background: var(--autonomy-advisory); }
    .autonomy[data-level="supervised"] { background: var(--autonomy-supervised); }
    .autonomy[data-level="bounded"] { background: var(--autonomy-bounded); }
    .autonomy[data-level="board-governed"] { background: var(--autonomy-board); }

    .table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
    .table th {
      font-family: var(--font-mono); font-size: 11px; font-weight: 500; letter-spacing: .06em;
      text-transform: uppercase; color: var(--fg-3); text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--line);
    }
    .table td { padding: 11px 10px; border-bottom: 1px solid var(--line); color: var(--fg-1); vertical-align: middle; overflow-wrap: anywhere; }
    .table tr:last-child td { border-bottom: 0; }
    .table tbody tr { transition: background var(--dur-fast) var(--ease); }
    .table tbody tr:hover { background: var(--surface-1); }
    .table .mono { font-family: var(--font-mono); font-size: 12px; color: var(--fg-2); }
    .table th:first-child, .table td:first-child { padding-left: 16px; }
    .table th:last-child, .table td:last-child { padding-right: 16px; }

    .console { min-height: 100vh; display: flex; flex-direction: column; }
    .con-header { display: flex; align-items: center; gap: 18px; padding: 12px 20px; border-bottom: 1px solid var(--line); }
    .con-brand { display: flex; align-items: center; gap: 10px; }
    .con-brand img { height: 26px; width: 26px; display: block; }
    .con-brand .name { font-size: 16px; font-weight: 600; letter-spacing: -0.01em; }
    .con-brand .kicker { font-family: var(--font-mono); font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--fg-3); }
    .con-ws { display: flex; align-items: center; gap: 10px; }
    .con-ws .wsname { font-family: var(--font-mono); font-size: 12px; color: var(--fg-2); }
    .con-toolbar { margin-left: auto; display: flex; align-items: center; gap: 8px; }

    .con-main { display: grid; grid-template-columns: 200px 1fr; flex: 1; min-height: 0; }
    .con-nav { border-right: 1px solid var(--line); background: var(--surface-1); padding: 12px 10px; display: flex; flex-direction: column; gap: 2px; }
    .con-nav .navbtn {
      display: flex; align-items: center; gap: 9px; width: 100%; min-height: 32px; padding: 0 10px;
      border: 1px solid transparent; border-radius: var(--r-sm); background: transparent;
      font-family: var(--font-sans); font-size: 13px; color: var(--fg-2); cursor: pointer; text-align: left;
      transition: color var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease), background var(--dur-fast) var(--ease);
    }
    .con-nav .navbtn:hover { background: var(--surface-2); color: var(--fg-1); }
    .con-nav .navbtn[aria-pressed="true"] { background: var(--accent-weak); color: var(--accent); border-color: var(--accent-weak-line); font-weight: 500; }
    .con-nav .navbtn .ico { display: inline-flex; width: 16px; height: 16px; flex: none; }
    .con-nav .navbtn .ico svg { width: 16px; height: 16px; }
    .con-nav .navcap { font-family: var(--font-mono); font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: var(--fg-3); padding: 10px 10px 4px; }

    .con-section { padding: 22px 26px; overflow: auto; min-width: 0; }
    .con-titlerow { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; margin-bottom: 18px; }
    .con-titlerow h2 { margin: 0; font-size: 20px; font-weight: 600; letter-spacing: -0.01em; }
    .con-titlerow .sub { font-family: var(--font-mono); font-size: 12px; color: var(--fg-3); margin-top: 3px; }
    .con-actions { display: flex; gap: 8px; }

    .panel { border: 1px solid var(--line); border-radius: var(--r-md); background: var(--bg); overflow: hidden; }
    .panel + .panel { margin-top: 16px; }
    .panel-head { padding: 12px 16px; border-bottom: 1px solid var(--line); display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .panel-head .ph-title { font-size: 13px; font-weight: 600; }
    .panel-body { padding: 16px; }

    .statgrid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 16px; }
    .stat { border: 1px solid var(--line); border-radius: var(--r-md); padding: 14px 16px; background: var(--surface-1); }
    .stat .sv { font-size: 24px; font-weight: 600; letter-spacing: -0.01em; font-variant-numeric: tabular-nums; word-break: break-word; }
    .stat .sk { font-family: var(--font-mono); font-size: 11px; color: var(--fg-3); margin-top: 4px; }

    .kvlist { display: flex; flex-direction: column; }
    .kvlist .kvrow { display: flex; gap: 14px; padding: 9px 0; border-bottom: 1px solid var(--line); font-size: 13px; }
    .kvlist .kvrow:last-child { border-bottom: 0; }
    .kvlist .kk { font-family: var(--font-mono); font-size: 12px; color: var(--fg-3); width: 190px; flex: none; }
    .kvlist .vv { color: var(--fg-1); min-width: 0; overflow-wrap: anywhere; }
    .kvlist .vv.mono { font-family: var(--font-mono); font-size: 12px; }

    .gate-banner {
      display: flex; align-items: center; gap: 10px; padding: 11px 14px; margin-bottom: 16px;
      background: var(--state-pending-bg); border: 1px solid var(--state-pending-line);
      border-radius: var(--r); color: var(--state-pending-fg); font-size: 13px;
    }
    .gate-banner svg { width: 16px; height: 16px; flex: none; }
    .gate-banner.ok { background: var(--state-success-bg); border-color: var(--state-success-line); color: var(--state-success-fg); }
    .gate-banner.bad { background: var(--state-danger-bg); border-color: var(--state-danger-line); color: var(--state-danger-fg); }

    .rationale { font-size: 13px; color: var(--fg-2); line-height: 1.5; border-left: 2px solid var(--accent-weak-line); padding-left: 12px; }
    .emptyrow { color: var(--fg-3); font-size: 13px; padding: 18px 16px; text-align: center; }
    .note { color: var(--fg-2); font-size: 13px; padding: 28px 16px; text-align: center; }
    .meta-line { font-family: var(--font-mono); font-size: 11px; color: var(--fg-3); }

    .tl { position: relative; padding-left: 22px; }
    .tl::before { content: ""; position: absolute; left: 5px; top: 6px; bottom: 6px; width: 2px; background: var(--line); }
    .tl .ev { position: relative; padding: 7px 0; display: flex; gap: 12px; align-items: baseline; }
    .tl .ev::before { content: ""; position: absolute; left: -21px; top: 12px; width: 8px; height: 8px; border-radius: 999px; background: var(--bg); border: 2px solid var(--fg-3); }
    .tl .ev.go::before { border-color: var(--accent); }
    .tl .ev.warn::before { border-color: var(--state-pending-fg); }
    .tl .seq { font-family: var(--font-mono); font-size: 11px; color: var(--fg-3); width: 28px; flex: none; }
    .tl .kind { font-family: var(--font-mono); font-size: 12.5px; color: var(--fg-1); }
    .tl .actor { font-family: var(--font-mono); font-size: 11px; color: var(--fg-3); margin-left: auto; }

    details.raw { margin-top: 16px; }
    details.raw summary {
      font-family: var(--font-mono); font-size: 11px; letter-spacing: .06em; text-transform: uppercase;
      color: var(--fg-3); cursor: pointer; padding: 4px 0; user-select: none;
    }
    details.raw summary:hover { color: var(--fg-2); }
    details.raw pre {
      margin: 8px 0 0; padding: 16px 18px; overflow: auto; max-height: 420px;
      background: var(--terminal-bg); color: var(--terminal-fg);
      font-family: var(--font-mono); font-size: 13px; line-height: 1.6; border-radius: var(--r);
    }

    .toast {
      position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%) translateY(8px);
      background: var(--fg-1); color: var(--bg); font-size: 13px; font-family: var(--font-mono);
      padding: 9px 16px; border-radius: var(--r); box-shadow: var(--shadow-lg);
      opacity: 0; pointer-events: none; transition: opacity var(--dur) var(--ease), transform var(--dur) var(--ease); z-index: 20;
    }
    .toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }

    select.input { cursor: pointer; }
    .con-ws select.input { width: auto; min-width: 200px; max-width: 280px; }
    .nbadge { margin-left: auto; min-width: 18px; height: 18px; padding: 0 5px; border-radius: var(--r-pill); background: var(--accent); color: var(--fg-on-accent); font-size: 10px; font-family: var(--font-mono); font-weight: 600; display: inline-flex; align-items: center; justify-content: center; }

    /* Triage Home */
    .home-grid { display: grid; grid-template-columns: 1fr 300px; gap: 16px; align-items: start; }
    .cap-label { font-family: var(--font-mono); font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: var(--fg-3); margin-bottom: 9px; }
    .triage-list { display: flex; flex-direction: column; gap: 8px; }
    .triage-item { border: 1px solid var(--line); border-radius: var(--r-md); padding: 13px 15px; background: var(--bg); display: flex; gap: 13px; align-items: flex-start; cursor: pointer; transition: border-color var(--dur-fast) var(--ease), box-shadow var(--dur-fast) var(--ease); }
    .triage-item:hover { border-color: var(--accent); box-shadow: var(--shadow-sm); }
    .triage-item.urgent { border-left: 3px solid var(--state-pending-fg); }
    .triage-item.critical { border-left: 3px solid var(--danger); }
    .triage-icon { width: 32px; height: 32px; border-radius: var(--r); display: flex; align-items: center; justify-content: center; flex: none; }
    .triage-icon svg { width: 15px; height: 15px; }
    .triage-icon.tap { background: var(--state-pending-bg); } .triage-icon.tap svg { stroke: var(--state-pending-fg); }
    .triage-icon.tbl { background: var(--state-danger-bg); } .triage-icon.tbl svg { stroke: var(--state-danger-fg); }
    .triage-icon.tkn { background: var(--accent-weak); } .triage-icon.tkn svg { stroke: var(--accent); }
    .triage-icon.tco { background: var(--state-info-bg); } .triage-icon.tco svg { stroke: var(--state-info-fg); }
    .triage-main { min-width: 0; flex: 1; }
    .tt { font-size: 13.5px; font-weight: 500; margin-bottom: 2px; }
    .ts { font-size: 12px; color: var(--fg-2); overflow-wrap: anywhere; }
    .triage-cta { margin-left: auto; flex: none; align-self: center; }
    .pulse-item { display: flex; align-items: center; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid var(--line); font-size: 13px; }
    .pulse-item:last-child { border-bottom: 0; }
    .pulse-label { color: var(--fg-2); }
    .pulse-value { font-weight: 500; font-variant-numeric: tabular-nums; }
    .all-clear { border: 1px solid var(--state-success-line); background: var(--state-success-bg); color: var(--state-success-fg); border-radius: var(--r-md); padding: 18px 16px; display: flex; gap: 10px; align-items: center; font-size: 13.5px; }
    .all-clear svg { width: 18px; height: 18px; flex: none; }

    /* Agent role cards */
    .agent-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(290px, 1fr)); gap: 14px; }
    .agent-card { border: 1px solid var(--line); border-radius: var(--r-md); background: var(--bg); padding: 17px; }
    .ac-hd { display: flex; align-items: center; gap: 11px; margin-bottom: 12px; }
    .ac-avatar { width: 38px; height: 38px; border-radius: var(--r-md); display: flex; align-items: center; justify-content: center; flex: none; background: var(--accent-weak); color: var(--accent); }
    .ac-avatar svg { width: 19px; height: 19px; }
    .ac-name { font-size: 14px; font-weight: 600; }
    .ac-role { font-size: 12px; color: var(--fg-2); margin-top: 1px; }
    .ac-tools { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 11px; }
    .ac-now { font-size: 12.5px; color: var(--fg-2); margin-bottom: 12px; overflow-wrap: anywhere; }
    .ac-stats { display: flex; gap: 18px; padding-top: 12px; border-top: 1px solid var(--line); }
    .ac-stat .asv { font-size: 17px; font-weight: 600; letter-spacing: -0.01em; font-variant-numeric: tabular-nums; }
    .ac-stat .ask { font-family: var(--font-mono); font-size: 10px; color: var(--fg-3); margin-top: 1px; }

    /* Evidence-pack approvals */
    .ap-pack { border: 1px solid var(--line); border-radius: var(--r-md); overflow: hidden; }
    .ap-pack + .ap-pack { margin-top: 14px; }
    .ap-pack.urgent { border-left: 3px solid var(--state-pending-fg); }
    .ap-hd { padding: 13px 15px; border-bottom: 1px solid var(--line); display: flex; gap: 12px; align-items: flex-start; }
    .ap-icon { width: 34px; height: 34px; border-radius: var(--r); background: var(--state-pending-bg); display: flex; align-items: center; justify-content: center; flex: none; }
    .ap-icon svg { width: 16px; height: 16px; stroke: var(--state-pending-fg); }
    .ap-title { font-size: 14px; font-weight: 600; margin-bottom: 2px; overflow-wrap: anywhere; }
    .ap-meta { font-size: 12px; color: var(--fg-2); }
    .ap-age { margin-left: auto; font-family: var(--font-mono); font-size: 11px; color: var(--fg-3); flex: none; padding-top: 2px; }
    .ap-ev { padding: 13px 15px; border-bottom: 1px solid var(--line); display: flex; flex-direction: column; gap: 8px; }
    .ap-ev-row { display: flex; gap: 10px; font-size: 12.5px; align-items: flex-start; }
    .ap-ev-label { font-family: var(--font-mono); font-size: 10.5px; color: var(--fg-3); width: 92px; flex: none; padding-top: 2px; }
    .ap-ev-val { color: var(--fg-1); line-height: 1.45; min-width: 0; overflow-wrap: anywhere; }
    .ap-acts { padding: 11px 15px; display: flex; gap: 7px; align-items: center; flex-wrap: wrap; }
    .ap-acts .spacer { flex: 1; }

    /* Knowledge / ratification */
    .know-list { display: flex; flex-direction: column; gap: 8px; }
    .know-item { border: 1px solid var(--line); border-radius: var(--r-md); padding: 13px 15px; }
    .know-item.rq { border-left: 3px solid var(--state-pending-fg); }
    .ki-hd { display: flex; align-items: flex-start; gap: 11px; }
    .ki-conf { width: 36px; height: 36px; border-radius: var(--r); background: var(--accent-weak); display: flex; align-items: center; justify-content: center; font-family: var(--font-mono); font-size: 10.5px; font-weight: 600; color: var(--accent); flex: none; }
    .ki-title { font-size: 13.5px; font-weight: 500; margin-bottom: 3px; line-height: 1.35; overflow-wrap: anywhere; }
    .ki-prov { font-size: 12px; color: var(--fg-2); overflow-wrap: anywhere; }
    .ki-acts { display: flex; gap: 6px; margin-top: 10px; flex-wrap: wrap; }

    /* Permission scope grid */
    .cap-grid { border: 1px solid var(--line); border-radius: var(--r-md); overflow: hidden; }
    .cap-row { display: flex; padding: 9px 14px; border-bottom: 1px solid var(--line); font-size: 13px; gap: 12px; align-items: center; }
    .cap-row:last-child { border-bottom: 0; }
    .cap-row.hdr { background: var(--surface-1); font-family: var(--font-mono); font-size: 10px; letter-spacing: .06em; text-transform: uppercase; color: var(--fg-3); }
    .cap-name { flex: 1; font-weight: 500; min-width: 0; overflow-wrap: anywhere; }
    .cap-sub { font-size: 11.5px; color: var(--fg-2); margin-top: 1px; font-weight: 400; }
    .p-allow { color: var(--state-success-fg); font-family: var(--font-mono); font-size: 11.5px; font-weight: 500; }
    .p-ask { color: var(--state-pending-fg); font-family: var(--font-mono); font-size: 11.5px; font-weight: 500; }
    .p-deny { color: var(--state-danger-fg); font-family: var(--font-mono); font-size: 11.5px; font-weight: 500; }

    /* Empty states that invite the next action */
    .empty-cta { border: 1px dashed var(--line-strong); border-radius: var(--r-md); padding: 30px 24px; text-align: center; background: var(--surface-1); }
    .empty-cta .ec-ico { width: 32px; height: 32px; margin: 0 auto 12px; color: var(--fg-3); }
    .empty-cta .ec-ico svg { width: 32px; height: 32px; }
    .empty-cta .ec-title { font-size: 14px; font-weight: 600; margin-bottom: 5px; }
    .empty-cta .ec-body { font-size: 13px; color: var(--fg-2); line-height: 1.5; max-width: 420px; margin: 0 auto 14px; }
    .dev-name { font-family: var(--font-mono); font-size: 10.5px; color: var(--fg-3); margin-left: 6px; }

    @media (max-width: 760px) {
      .con-header { flex-wrap: wrap; }
      .con-toolbar { margin-left: 0; width: 100%; }
      .con-main { grid-template-columns: 1fr; }
      .con-nav { border-right: 0; border-bottom: 1px solid var(--line); flex-direction: row; flex-wrap: wrap; }
      .con-nav .navcap { width: 100%; }
      .statgrid { grid-template-columns: repeat(2, 1fr); }
      .home-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="console">
    <header class="con-header">
      <div class="con-brand">
        <img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACwAAAAsCAMAAAApWqozAAADAFBMVEVMaXGITvT3jGNAQfnybDLVw+pfQPT0lYVCWvgbReK40/qHZe5dqP/6hVE6oPZUP/PbYMDyZYw2hffrQbMyTvv8hyFUSfI4QvdAM/f8cS37hzz7hSpZNfckq/5KMPX6ez38byNpRvdbUvD2gUP8cyD7gS74k1j5gC37bCD7cx9UQfr8giJBN/VRQPZYqP/0ijMZavr7TlKjP+FDTvRQNfaWL+tILvVMLPaFOPE5MfaZfLr8byD8iyP6nTQdUfv6R1UsVvglW/j3QYj8ex1CafS+JNcVWfoecfz8fhwUfftVK/QoOfcnrfsggPuVO+pHKPSCKe38NXfAINdJMveoI+Y1OPUmNvhBK/czL/cyL/bIG874cVv8dR/Rh4P8mTH4eDX7jiD8Xz38dRf0GpjjF8IcW/j7fiSzPN8rc/8wPPj8Xx4aY/n6hBpnOfEiVPoaSvoZW/kcRPkoRPoxP/dePfUbZPr4NmQZePvxK5nPGskyOPgccfocf/shgPohg/0Sj/tqM/P1gigmkvk6MfnnILM8OvcfqfskN/jZhVqeGOZmKvGKNe+oirbDGNb1SncrU/d7IPBHU/OYd7n0IKL3J58io/lXK/eBZr0kwf3ZLcj6eSA+tfdUJfXaPskZivogf/r9dRZkJ/LXg2mHG+tiI/KqH9p5I/LCINn8UyfgGrn3O37iKaUbjvr6LnQdQ/kyNfcmN/rxJ5P2LG/ZGcqySeBjKPP7ixecbJ4fqvwdn/zxizUfhfiLHe0QlvzpHrh4I+xeJPUuMPi/F9WWHOb9hR/1I6YasfzQINUavvn7bRKXebk0T/EasP3jSrz8YRoVpPv7kRbpe0wWVPn8bhX9bBf9VUEVovx0HPCDZrHzei/7VxsTtvv8fh79V0DuFasgf/kZZvt1JvDiJKvuGrGZbpsiOfz4K2sRpvwUsvzFd28eifs3KvZQL/LzGYf8VTD1KX75PFP1jyfdfVMbqfvKf3WsE+R3HO6iIepCKvZALPusGOK0Dth9F/JmKPOPG+P6TEM7vR7FAAABAHRSTlMABQoiAgIIAQIBBQ0IBhQsCBgEDipYHDU5GRMzNhdhLFcSIjl8Iw5PSi8mOo1FDkOGURgNT0dyhCF/J51gKW5oO00hqBc/om2braaUPDgqrGFdTmhwT4aZcK5+JmQjHUh4OXGHf2VwMCV6rpOVR0KWua5VPk0yjYJyo1+VjGZF1FS1Rs5DWVO4lZlDMBFXQnueQx+WMC+xOjNUjSDPH7hRsnBBpdSThHjWpTMwcsqhwcaGc2EhhshbY1tumMDiNjzIopiIik5zbq7DO02FQWmP2F3Fy8aEsbFfgZTBv4OlVlBXfY6f86O8yKCgnXzidMPDvaKDhKbIVb/ks+TtmJdarZx7JAAAAAlwSFlzAAALEwAACxMBAJqcGAAABIVJREFUeNrNVWVUG0sYvZHN7sY9hITgAYK7F4oUd68ANVoKbSmlpS20BapQ91d3d3d/7u7u7m7nTZo+CH3h9O+bPfudmTl37txP9lvg/ziULDEsKKF1QYNP3/eAEg88CvDvhwt6WAoCfcNlM+Hk6ylNNQbiZiF+0gXKhbkXxIBzQuKzibWJA13AYt0zBCX8dCFYyaXgc9XeXNA0zXcIZ7DuZSlyPwmisSv4O08r50AahCykR6Sgcn8Q810WLwafbzbUJTQmNBoS7jlDgNtc4DI3FxenCiG92gX4a87VZgZr/H00tcEP3qOc2qxEXheYCxchnbuQklzqbEw0g70Tbb1rP24G27OA9ixC3oUjl8XmxZ0GwNvVx2Dgcv8biPHbgXfmYM7nVNC2PPz4PddZk/pm6o7MzM5RGj3sI0JyltemRFYrZmdh9mWc/wzBmZv8nSW0ROLnl6rx6pdPBnkhQmTMRms72udwPxT4vOYt9PN1qzFYy8Nv1HCfPnTIeIhDpqGhDRmtaJOe3+D5HNfHq67OKz75heG+BDfczVvybyTGpiFoyDS824SMEDpE9OqIXYoaT2/XYc7g+m96bJQ/SX682RYR4t0gJQYPwbSm8OSGoIzVj49QjHB29axx84p304O7w8u3r1QZK5C8Yjw/VtyQNjguTs6nKfMwz5H66vgJTwO+L5r7wsFg0iBg8hRMaqJWJG+IW0rqB5AMc00KhduE17ngHvDtdVCJsZOBSZOnKo81q1esjruTOLCK5aqk6Sq/CV/rMTJ0ZG8SlWieAhxbBN0U3hOrljK23a0pM5hT0yXcA6HAWy/ZqFmo1Ugu14Uj5wTKctKSLXdLQvHU4ZP4eDqob5OAQ8vvUDMYRBSrP1KDl7MIUwN4WoZlCV5+ZmPY+/P53xQhtEiB0CQbNQN1PQRpi8rBKz/OCy9b5SEge4KwcenFhw/i1EkKR4t6/WOgyxFxMKu8SiQoq4p1ksk8PATamPzIcaXymVsVXx1CSpGqF00knmgGnG5WVRI7a0GgzCNQOzG/8MxezDyNGTOQcjSlrzZYjnrBTQqorJgXWyaTOZlKtBEt1wvzuzF0KEavAdautSt/oqSyvgQI18UGfBEQ5USZopVnZZG3reBrH8gxerSdDJ4WiK2sWsATWFfuTgVfijv+wt+3cesW5r8th0phl5P6WSARiDX9Fv1rdEVBQYERPTdES66EYX8xro0R4qE1dtXPCI9PBQcCizHKFBXBA3bu6UHhbjrsj2LMPyiHXNWvweh08ywWjk2UduKN7B4s+XMJ0ktVOL3xnkZAUhYeGDEvoiLQZCrJzt7SYcH1nyMF+P0nYMwYUHT/NsOwELg7RZVUREdHGUU03tu3UoRfCHH6I46aGGPXGGQdr+wjLnd3A8UzHfbwAA8jh0NDIDKe3bmH5kB4JRJYtt+OxY6ZZwkIzG5Z37Jl4nqRkkFMZGk+OOnLbJ+CgwbtLtNGuBtpMuPEFO4mnHvHOSS2ir7LwTJwD1sZAw4LEYca8J/CMtaHTAQcDHC9w0Hb2fsMx6z/AKOrDS2ydFU+AAAAAElFTkSuQmCC" alt="OpenMAO" />
        <span class="name">OpenMAO</span>
        <span class="kicker">operator console</span>
      </div>
      <div class="con-ws">
        <select id="ws-switcher" class="input" aria-label="Workspace"></select>
        <span id="autonomy"></span>
      </div>
      <div class="con-toolbar">
        <input id="token-input" class="input" type="password" autocomplete="off" placeholder="Operator token" aria-label="Operator token" />
        <button class="btn btn-ghost btn-sm" id="dev-names" aria-pressed="false" title="Reveal the underlying kernel terms">Developer names</button>
        <button class="btn btn-ghost btn-sm" id="reset-token">Reset</button>
        <button class="btn btn-sm" id="refresh">Refresh</button>
        <button class="btn btn-icon" id="theme-toggle" aria-label="Toggle theme"></button>
      </div>
    </header>
    <div class="con-main">
      <nav class="con-nav" aria-label="Console views">
        <button class="navbtn" data-view="home" data-icon="home" aria-pressed="true"><span class="ico"></span><span class="navlabel">Home</span><span class="nbadge" id="home-badge" hidden></span></button>
        <div class="navcap">Work</div>
        <button class="navbtn" data-view="work" data-icon="list-checks" aria-pressed="false"><span class="ico"></span><span class="navlabel">Tasks</span></button>
        <div class="navcap">Org</div>
        <button class="navbtn" data-view="agents" data-icon="bot" aria-pressed="false"><span class="ico"></span><span class="navlabel">Agents</span></button>
        <div class="navcap">Knowledge</div>
        <button class="navbtn" data-view="memory" data-icon="database" aria-pressed="false"><span class="ico"></span><span class="navlabel">What the org has learned</span></button>
        <button class="navbtn" data-view="search" data-icon="search" aria-pressed="false"><span class="ico"></span><span class="navlabel">Search knowledge</span></button>
        <div class="navcap">Governance</div>
        <button class="navbtn" data-view="approvals" data-icon="shield-check" aria-pressed="false"><span class="ico"></span><span class="navlabel">Approvals</span><span class="nbadge" id="appr-badge" hidden></span></button>
        <button class="navbtn" data-view="promotions" data-icon="arrow-up-circle" aria-pressed="false"><span class="ico"></span><span class="navlabel">Ratify knowledge</span></button>
        <button class="navbtn" data-view="learning" data-icon="git-branch" aria-pressed="false"><span class="ico"></span><span class="navlabel">Suggested improvements</span></button>
        <button class="navbtn" data-view="cadences" data-icon="repeat" aria-pressed="false"><span class="ico"></span><span class="navlabel">Schedules</span></button>
        <div class="navcap">Audit</div>
        <button class="navbtn" data-view="runs" data-icon="play" aria-pressed="false"><span class="ico"></span><span class="navlabel">Runs</span></button>
        <button class="navbtn" data-view="events" data-icon="activity" aria-pressed="false"><span class="ico"></span><span class="navlabel">Audit trail</span></button>
        <button class="navbtn" data-view="traces" data-icon="git-commit-horizontal" aria-pressed="false"><span class="ico"></span><span class="navlabel">Traces</span></button>
        <button class="navbtn" data-view="capabilities" data-icon="layers" aria-pressed="false"><span class="ico"></span><span class="navlabel">Tool actions</span></button>
        <button class="navbtn" data-view="capabilityCalls" data-icon="arrow-right-left" aria-pressed="false"><span class="ico"></span><span class="navlabel">Actions requested</span></button>
        <button class="navbtn" data-view="chiefOfStaff" data-icon="bell" aria-pressed="false"><span class="ico"></span><span class="navlabel">Chief of Staff log</span></button>
      </nav>
      <section class="con-section">
        <div class="con-titlerow">
          <div>
            <h2 id="view-title">Home</h2>
            <div class="sub" id="view-sub"></div>
          </div>
          <div class="con-actions" id="view-actions"></div>
        </div>
        <div id="view"></div>
      </section>
    </div>
    <div class="toast" id="toast"></div>
  </div>
  <script>
    var RUN_ID = ${JSON.stringify(RUN_ID)};
    var COORDINATOR_AGENT_ID = ${JSON.stringify(COORDINATOR_AGENT_ID)};
    var TOKEN_HEADER = ${JSON.stringify(TOKEN_HEADER)};
    var ACTOR_HEADER = ${JSON.stringify(ACTOR_HEADER)};
    var CONSOLE_ACTOR = ${JSON.stringify(CONSOLE_ACTOR)};
    var WORKSPACE_ID = ${JSON.stringify(WORKSPACE_ID)};

    function svgIcon(inner) {
      return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + inner + '</svg>';
    }
    var ICONS = {
      globe: svgIcon('<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>'),
      play: svgIcon('<polygon points="6 3 20 12 6 21 6 3"/>'),
      "list-checks": svgIcon('<path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>'),
      bot: svgIcon('<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>'),
      "shield-check": svgIcon('<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>'),
      "arrow-up-circle": svgIcon('<circle cx="12" cy="12" r="10"/><path d="m16 12-4-4-4 4"/><path d="M12 16V8"/>'),
      "git-branch": svgIcon('<line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>'),
      database: svgIcon('<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/>'),
      layers: svgIcon('<path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m6.08 9.5-3.48 1.59a1 1 0 0 0 0 1.83l8.59 3.9a2 2 0 0 0 1.65 0l8.58-3.9a1 1 0 0 0 0-1.83L17.92 9.5"/><path d="m6.08 14.5-3.48 1.59a1 1 0 0 0 0 1.83l8.59 3.9a2 2 0 0 0 1.65 0l8.58-3.9a1 1 0 0 0 0-1.83l-3.48-1.59"/>'),
      "arrow-right-left": svgIcon('<path d="m16 3 4 4-4 4"/><path d="M20 7H4"/><path d="m8 21-4-4 4-4"/><path d="M4 17h16"/>'),
      "check-check": svgIcon('<path d="M18 6 7 17l-5-5"/><path d="m22 10-7.5 7.5L13 16"/>'),
      activity: svgIcon('<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/>'),
      "git-commit-horizontal": svgIcon('<circle cx="12" cy="12" r="3"/><line x1="3" x2="9" y1="12" y2="12"/><line x1="15" x2="21" y1="12" y2="12"/>'),
      sun: svgIcon('<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>'),
      moon: svgIcon('<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>'),
      "pause-circle": svgIcon('<circle cx="12" cy="12" r="10"/><line x1="10" x2="10" y1="15" y2="9"/><line x1="14" x2="14" y1="15" y2="9"/>'),
      "check-circle": svgIcon('<path d="M21.801 10A10 10 0 1 1 17 3.335"/><path d="m9 11 3 3L22 4"/>'),
      search: svgIcon('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>'),
      bell: svgIcon('<path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.41 5.956-2.738 7.326"/>'),
      repeat: svgIcon('<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>'),
      home: svgIcon('<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>'),
      brain: svgIcon('<path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/>'),
      "alert-triangle": svgIcon('<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>'),
      info: svgIcon('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>'),
      inbox: svgIcon('<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>'),
      "arrow-right": svgIcon('<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>'),
      sparkles: svgIcon('<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .962 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.962 0z"/>')
    };

    var STATE_FAMILY = {
      queued: "neutral", draft: "neutral", idle: "neutral", log_only: "neutral",
      running: "info", in_progress: "info",
      proposed: "pending", pending: "pending", require_approval: "pending", approval_required: "pending",
      suspended_approval: "pending", provisional: "pending", review: "pending",
      approved: "success", allow: "success", done: "success", completed: "success",
      ratified: "success", confirmed: "success", enabled: "success", ok: "success", applied: "success",
      blocked: "danger", block: "danger", rejected: "danger", failed: "danger", disabled: "danger", stale: "danger"
    };

    function el(tag, attrs, kids) {
      var n = document.createElement(tag);
      if (attrs) {
        for (var k in attrs) {
          var v = attrs[k];
          if (v == null) continue;
          if (k === "class") n.className = v;
          else if (k === "text") n.textContent = v;
          else if (k === "html") n.innerHTML = v;
          else if (k.indexOf("on") === 0 && typeof v === "function") n.addEventListener(k.slice(2), v);
          else n.setAttribute(k, v);
        }
      }
      if (kids != null) {
        (Array.isArray(kids) ? kids : [kids]).forEach(function (c) {
          if (c == null || c === false) return;
          n.appendChild(typeof c === "object" ? c : document.createTextNode(String(c)));
        });
      }
      return n;
    }
    function icon(name, cls) { return el("span", { class: cls, html: ICONS[name] || "" }); }
    function strip(value, prefix) {
      var s = value == null ? "" : String(value);
      return s.indexOf(prefix) === 0 ? s.slice(prefix.length) : s;
    }
    function statusBadge(status) {
      var s = status == null || status === "" ? "—" : String(status);
      var fam = STATE_FAMILY[s] || "neutral";
      return el("span", { class: "badge badge-" + fam }, [el("span", { class: "bdot" }), s]);
    }
    function riskTag(level) {
      var map = { low: "neutral", medium: "pending", high: "danger" };
      var fam = map[level] || "neutral";
      var span = el("span", { class: "tag", text: "risk: " + (level == null ? "—" : level) });
      if (fam !== "neutral") {
        span.style.color = "var(--state-" + fam + "-fg)";
        span.style.borderColor = "var(--state-" + fam + "-line)";
        span.style.background = "var(--state-" + fam + "-bg)";
      }
      return span;
    }
    function autonomyPill(level) {
      return el("span", { class: "autonomy", "data-level": level || "supervised", text: level || "unknown" });
    }
    function tag(text) { return el("span", { class: "tag", text: text }); }

    function panel(title, body, opts) {
      opts = opts || {};
      var p = el("div", { class: "panel" });
      if (title) {
        var head = el("div", { class: "panel-head" }, el("span", { class: "ph-title", text: title }));
        if (opts.action) head.appendChild(opts.action);
        p.appendChild(head);
      }
      var b = el("div", opts.flush ? null : { class: "panel-body" });
      (Array.isArray(body) ? body : [body]).forEach(function (x) { if (x) b.appendChild(x); });
      p.appendChild(b);
      return p;
    }
    function dataTable(cols, rows) {
      var t = el("table", { class: "table" });
      var head = el("tr");
      cols.forEach(function (c) { head.appendChild(el("th", { text: c.label, style: c.width ? "width:" + c.width + "px" : null })); });
      t.appendChild(el("thead", null, head));
      var body = el("tbody");
      if (!rows || !rows.length) {
        body.appendChild(el("tr", null, el("td", { class: "emptyrow", colspan: cols.length, text: "No records." })));
      } else {
        rows.forEach(function (r) {
          var tr = el("tr");
          cols.forEach(function (c) {
            var v = c.render ? c.render(r) : r[c.key];
            var td = el("td", c.mono ? { class: "mono" } : null);
            if (v != null && typeof v === "object") td.appendChild(v);
            else td.textContent = v == null ? "" : String(v);
            tr.appendChild(td);
          });
          body.appendChild(tr);
        });
      }
      t.appendChild(body);
      return t;
    }
    function kvlist(rows) {
      var list = el("div", { class: "kvlist" });
      rows.forEach(function (r) {
        var vv = el("span", { class: "vv" + (r.mono ? " mono" : "") });
        (Array.isArray(r.value) ? r.value : [r.value]).forEach(function (x) {
          if (x == null) return;
          vv.appendChild(typeof x === "object" ? x : document.createTextNode(String(x)));
        });
        list.appendChild(el("div", { class: "kvrow" }, [el("span", { class: "kk", text: r.key }), vv]));
      });
      return list;
    }
    function rawDetails(data) {
      return el("details", { class: "raw" }, [
        el("summary", { text: "Raw record" }),
        el("pre", { text: JSON.stringify(data, null, 2) })
      ]);
    }
    function joinList(arr, sep) {
      return arr && arr.length ? arr.join(sep || ", ") : "—";
    }

    var tokenInput = document.getElementById("token-input");
    var themeToggle = document.getElementById("theme-toggle");
    var devNamesBtn = document.getElementById("dev-names");
    var wsSwitcher = document.getElementById("ws-switcher");
    var mount = document.getElementById("view");
    var viewTitle = document.getElementById("view-title");
    var viewSub = document.getElementById("view-sub");
    var viewActions = document.getElementById("view-actions");
    var autonomySlot = document.getElementById("autonomy");
    var toastEl = document.getElementById("toast");
    var activeView = "home";
    var orgState = null;
    var rolesById = {};
    var agentsById = {};
    var toastTimer = null;
    var devNames = localStorage.getItem("openmaoDevNames") === "1";
    var workspaces = [];
    var selectedWorkspace = sessionStorage.getItem("openmaoWorkspace") || WORKSPACE_ID;

    // Operator-facing vocabulary layer (docs/OPERATOR_CONSOLE_REDESIGN.md §2.1).
    // op = the operator label; dev = the underlying kernel term revealed by the toggle.
    var VOCAB = {
      home: { op: "Home" },
      work: { op: "Tasks", dev: "WorkItem" },
      agents: { op: "Agents", dev: "Agent / Role" },
      memory: { op: "What the org has learned", dev: "Collective memory" },
      search: { op: "Search knowledge", dev: "Memory search" },
      approvals: { op: "Approvals", dev: "ApprovalRequest" },
      promotions: { op: "Ratify knowledge", dev: "Promotion candidates" },
      learning: { op: "Suggested improvements", dev: "OrgChangeProposal" },
      cadences: { op: "Schedules", dev: "Cadence" },
      runs: { op: "Runs", dev: "Run" },
      events: { op: "Audit trail", dev: "Append-only events" },
      traces: { op: "Traces", dev: "Trace" },
      capabilities: { op: "Tool actions", dev: "Capability" },
      capabilityCalls: { op: "Actions requested", dev: "CapabilityCall / Result" },
      chiefOfStaff: { op: "Chief of Staff log", dev: "Notifications" }
    };
    var SUBS = {
      home: "what needs you", work: "delegated to agents, governed by approvals",
      agents: "your AI teammates and their track record", memory: "institutional knowledge with provenance",
      search: "collective + shared memory", approvals: "decide in a glance — evidence packs",
      promotions: "knowledge waiting to enter org memory", learning: "the org proposing changes to itself",
      cadences: "recurring Chief-of-Staff sweeps", runs: "every execution attempt",
      events: "human-readable, reversible history", traces: "per-node execution detail",
      capabilities: "governed tool actions and their default permission",
      capabilityCalls: "what agents asked to do and the result",
      chiefOfStaff: "your minimum-workload oversight proxy"
    };
    function titleFor(view) { return (VOCAB[view] && VOCAB[view].op) || view; }

    function operatorToken() {
      return tokenInput.value || sessionStorage.getItem("openmaoOperatorToken") || "";
    }
    function headers() {
      var h = {};
      h[TOKEN_HEADER] = operatorToken();
      h[ACTOR_HEADER] = CONSOLE_ACTOR;
      h["x-openmao-workspace"] = selectedWorkspace;
      return h;
    }
    async function parse(response) {
      var body = await response.json();
      if (!response.ok) throw body;
      return body;
    }
    async function request(path, init) {
      init = init || {};
      if (!operatorToken()) throw { error: "operator_token_required" };
      var merged = {};
      var base = headers();
      for (var k in base) merged[k] = base[k];
      if (init.headers) for (var j in init.headers) merged[j] = init.headers[j];
      return parse(await fetch(path, Object.assign({}, init, { headers: merged })));
    }

    function flash(msg) {
      toastEl.textContent = msg;
      toastEl.classList.add("show");
      clearTimeout(toastTimer);
      toastTimer = setTimeout(function () { toastEl.classList.remove("show"); }, 2400);
    }
    function applyTheme(theme) {
      document.documentElement.setAttribute("data-theme", theme);
      localStorage.setItem("openmaoConsoleTheme", theme);
      themeToggle.innerHTML = ICONS[theme === "dark" ? "sun" : "moon"];
    }
    function workspaceName() {
      for (var i = 0; i < workspaces.length; i++) {
        if (workspaces[i].id === selectedWorkspace) return workspaces[i].name || selectedWorkspace;
      }
      return selectedWorkspace;
    }
    // Reveals the kernel term beside an operator label when "Developer names" is on.
    function devName(view) {
      var v = VOCAB[view];
      return (devNames && v && v.dev) ? el("span", { class: "dev-name", text: v.dev }) : null;
    }

    function setActive(view) {
      activeView = view;
      viewTitle.replaceChildren(document.createTextNode(titleFor(view)));
      var dn = devName(view);
      if (dn) viewTitle.appendChild(dn);
      viewSub.textContent = (SUBS[view] || "") + " · " + workspaceName();
      document.querySelectorAll(".navbtn").forEach(function (b) {
        b.setAttribute("aria-pressed", String(b.getAttribute("data-view") === view));
      });
    }
    function actionBtn(label, opts) {
      opts = opts || {};
      var cls = "btn btn-sm" + (opts.variant ? " btn-" + opts.variant : "");
      return el("button", { class: cls, text: label, onclick: opts.onClick, disabled: opts.disabled });
    }
    function postAction(path, message) {
      return async function () {
        try {
          await request(path, { method: "POST" });
          if (message) flash(message);
          orgState = null;
          await refreshOrg();
          await load(activeView);
          refreshBadges();
        } catch (e) {
          flash((e && e.error) ? e.error : "request failed");
        }
      };
    }
    function setViewActions(view) {
      viewActions.replaceChildren();
      if (view === "home") {
        viewActions.appendChild(actionBtn("Run guided demo", { variant: "primary", onClick: postAction("/runs/demo", "demo started → suspended at approval gate") }));
        viewActions.appendChild(actionBtn("Approve demo", { onClick: postAction("/runs/demo/approve", "approved → run resumed → memory promoted") }));
      } else if (view === "agents") {
        viewActions.appendChild(actionBtn("Run worker", { onClick: postAction("/workers/reference-demo", "reference worker run started") }));
        viewActions.appendChild(actionBtn("Approve worker", { onClick: postAction("/workers/reference-demo/approve", "reference worker approval resolved") }));
      } else if (view === "chiefOfStaff") {
        viewActions.appendChild(actionBtn("Run a sweep", { variant: "primary", onClick: postAction("/cos/tick", "Chief of Staff ran a sweep") }));
      }
    }

    async function refreshOrg() {
      if (!operatorToken()) { autonomySlot.replaceChildren(); orgState = null; rolesById = {}; agentsById = {}; return; }
      try {
        var data = await request("/org");
        orgState = (data.organizations && data.organizations[0]) || null;
        rolesById = {};
        (data.roles || []).forEach(function (r) { rolesById[r.id] = r; });
        agentsById = {};
        (data.agents || []).forEach(function (a) { agentsById[a.id] = a; });
        autonomySlot.replaceChildren(orgState ? autonomyPill(orgState.autonomy_level) : "");
      } catch (e) {
        autonomySlot.replaceChildren();
      }
    }

    async function refreshWorkspaces() {
      if (!operatorToken()) { return; }
      try {
        workspaces = await request("/workspaces");
        if (!workspaces.some(function (w) { return w.id === selectedWorkspace; }) && workspaces.length) {
          selectedWorkspace = workspaces[0].id;
        }
        wsSwitcher.replaceChildren();
        workspaces.forEach(function (w) {
          wsSwitcher.appendChild(el("option", { value: w.id, text: w.name || w.id }));
        });
        wsSwitcher.value = selectedWorkspace;
      } catch (e) { /* token gate handled per-view */ }
    }

    // Resolve an owner/agent reference to its human identity (falls back to a stripped id).
    function agentName(ref) {
      if (ref == null) return "—";
      var a = agentsById[ref];
      return a && a.identity ? a.identity : strip(ref, "agent_");
    }
    function roleNameFor(agent) {
      var r = agent && rolesById[agent.role_id];
      return r && r.name ? r.name : strip(agent ? agent.role_id : "", "role_");
    }
    function grantsFor(agent) {
      var r = agent && rolesById[agent.role_id];
      return (r && r.capability_grants) || [];
    }

    function note(text) { return el("div", { class: "note", text: text }); }
    function loadingNote() { return note("Loading…"); }
    function errorView(e) {
      if (e && e.error === "operator_token_required") {
        return emptyCta("inbox", "Connect to your organization", "Enter your operator token in the header to load the console. Everything you do here is governed, audited, and reversible.", null);
      }
      return panel("Error", el("pre", { class: "", style: "margin:0;font-family:var(--font-mono);font-size:12px;color:var(--state-danger-fg);white-space:pre-wrap", text: JSON.stringify(e, null, 2) }));
    }
    function capLabel(text) { return el("div", { class: "cap-label", text: text }); }
    // Empty states propose the next action instead of reporting emptiness.
    function emptyCta(iconName, title, body, action) {
      var kids = [
        icon(iconName, "ec-ico"),
        el("div", { class: "ec-title", text: title }),
        el("div", { class: "ec-body", text: body })
      ];
      if (action) kids.push(action);
      return el("div", { class: "empty-cta" }, kids);
    }
    function goBtn(label, view, variant) {
      return actionBtn(label, { variant: variant || null, onClick: function () { load(view); } });
    }
    function relTime(ts) {
      if (!ts) return "";
      var then = Date.parse(ts);
      if (isNaN(then)) return ts;
      var s = Math.max(0, Math.round((Date.now() - then) / 1000));
      if (s < 60) return s + "s ago";
      if (s < 3600) return Math.round(s / 60) + " min ago";
      if (s < 86400) return Math.round(s / 3600) + " hr ago";
      return Math.round(s / 86400) + " d ago";
    }
    // Map an approval's on_reject path to plain-language reversibility (Pattern 2 evidence pack).
    function reversibility(a) {
      var r = a.on_reject;
      if (r === "fail_run") return "Reject fails this run — nothing is committed, and you can re-run it.";
      if (r === "skip_action") return "Reject skips just this action — the run continues on a safer path.";
      if (r === "no_op") return "Reject is a no-op — no side effect either way.";
      return "Reject is recorded in the audit trail.";
    }
    var SEV_FAMILY = { urgent: "danger", attention: "pending", info: "info" };
    function sevBadge(s) {
      var fam = SEV_FAMILY[s] || "neutral";
      return el("span", { class: "badge badge-" + fam }, [el("span", { class: "bdot" }), s == null ? "—" : String(s)]);
    }

    // One evidence-pack approval card: resolvable in seconds (Pattern 2 [4]).
    function approvalPack(a) {
      var rationale = (a.payload && a.payload.reason) || a.action || "Approval requested";
      var card = el("div", { class: "ap-pack urgent" });
      card.appendChild(el("div", { class: "ap-hd" }, [
        el("div", { class: "ap-icon", html: ICONS["shield-check"] }),
        el("div", { style: "min-width:0" }, [
          el("div", { class: "ap-title", text: a.action || "Approval" }),
          el("div", { class: "ap-meta", text: "requested by " + agentName(a.requested_by) })
        ]),
        el("span", { class: "ap-age", text: relTime(a.created_at) })
      ]));
      function evRow(label, value) {
        return el("div", { class: "ap-ev-row" }, [
          el("span", { class: "ap-ev-label", text: label }),
          (value != null && typeof value === "object")
            ? el("span", { class: "ap-ev-val" }, value)
            : el("span", { class: "ap-ev-val", text: value })
        ]);
      }
      var evRows = [
        evRow("What", a.action || "—"),
        evRow("Why", rationale),
        evRow("Requested by", agentName(a.requested_by)),
        evRow("Reversible?", reversibility(a))
      ];
      if (a.payload && a.payload.target_type) evRows.push(evRow("Target", el("span", { class: "tag", text: a.payload.target_type })));
      if (a.run_id) evRows.push(evRow("On a run", el("span", { class: "mono", style: "font-size:12px;color:var(--fg-2)", text: a.run_id })));
      card.appendChild(el("div", { class: "ap-ev" }, evRows));
      card.appendChild(el("div", { class: "ap-acts" }, [
        actionBtn("Approve", { variant: "primary", onClick: postAction("/approvals/" + a.id + "/approve", "Approved — agent resumes") }),
        actionBtn("Reject with reason", { variant: "danger", onClick: postAction("/approvals/" + a.id + "/reject", "Rejected — reversible, agent notified") }),
        el("span", { class: "spacer" }),
        el("span", { class: "meta-line", text: devNames ? a.id : ("on_approve: " + a.on_approve) })
      ]));
      return card;
    }

    // Agent role card: identity, role, model, scope, granted tool actions, live work + track record.
    function agentCard(a, byOwner) {
      var grants = grantsFor(a);
      var mine = byOwner[a.id] || [];
      var active = mine.filter(function (w) { return w.status === "in_progress" || w.status === "review"; });
      var done = mine.filter(function (w) { return w.status === "done"; }).length;
      var nowText = active.length ? active[0].title : "Idle";
      var card = el("div", { class: "agent-card" });
      card.appendChild(el("div", { class: "ac-hd" }, [
        el("div", { class: "ac-avatar", html: ICONS.bot }),
        el("div", { style: "min-width:0" }, [
          el("div", { class: "ac-name", text: a.identity }),
          el("div", { class: "ac-role", text: roleNameFor(a) })
        ]),
        el("div", { style: "margin-left:auto" }, statusBadge(a.status))
      ]));
      card.appendChild(el("div", { class: "ac-tools" },
        grants.length ? grants.map(function (g) { return el("span", { class: "tag", text: g }); }) : [el("span", { class: "meta-line", text: "no granted tool actions" })]
      ));
      card.appendChild(el("div", { class: "ac-now" }, [el("strong", { style: "color:var(--fg-1)", text: "Now: " }), nowText]));
      card.appendChild(el("div", { class: "ac-stats" }, [
        el("div", { class: "ac-stat" }, [el("div", { class: "asv", text: String(done) }), el("div", { class: "ask", text: "tasks done" })]),
        el("div", { class: "ac-stat" }, [el("div", { class: "asv", text: String(active.length) }), el("div", { class: "ask", text: "active now" })]),
        el("div", { class: "ac-stat", style: "flex:1;min-width:0" }, [
          el("div", { class: "asv", style: "font-size:13px;font-weight:500;color:var(--fg-2);overflow-wrap:anywhere", text: a.model_binding }),
          el("div", { class: "ask", text: "model" })
        ])
      ]));
      return card;
    }

    // One triage item: icon + plain-language summary + one-click resolution.
    function triageItem(opts) {
      var item = el("div", { class: "triage-item" + (opts.tone ? " " + opts.tone : ""), tabindex: "0", role: "button" });
      var go = function () { load(opts.view); };
      item.addEventListener("click", go);
      item.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
      var cta = actionBtn(opts.cta || "Open", { variant: opts.ctaVariant || null, onClick: function (e) { e.stopPropagation(); go(); } });
      item.appendChild(el("div", { class: "triage-icon " + opts.iconClass, html: ICONS[opts.icon] }));
      item.appendChild(el("div", { class: "triage-main" }, [
        el("div", { class: "tt", text: opts.title }),
        el("div", { class: "ts", text: opts.sub })
      ]));
      item.appendChild(el("div", { class: "triage-cta" }, cta));
      return item;
    }

    var VIEWS = {
      // Triage Home — "what needs you" aggregated from approvals + world + CoS + ratification + improvements.
      home: async function () {
        if (!orgState) await refreshOrg();
        var results = await Promise.all([
          request("/approvals").catch(function () { return []; }),
          request("/world").catch(function () { return {}; }),
          request("/cos/notifications?unread=1").catch(function () { return []; }),
          request("/memory/promotions").catch(function () { return []; }),
          request("/learning/proposals").catch(function () { return []; })
        ]);
        var approvals = results[0], w = results[1] || {}, notes = results[2], promos = results[3], proposals = results[4];
        var ratifiable = promos.filter(function (p) { return p.status === "pending"; });
        var proposed = proposals.filter(function (p) { return p.status === "proposed"; });
        var blockers = w.blockers || [];
        var pendingReviews = w.pending_reviews || [];

        var items = [];
        approvals.forEach(function (a) {
          items.push(triageItem({
            view: "approvals", icon: "shield-check", iconClass: "tap", tone: "urgent",
            title: "Approval needed: " + (a.action || "action") + " — " + agentName(a.requested_by) + " is waiting",
            sub: ((a.payload && a.payload.reason) || "Decision required before the run can proceed") + " · " + relTime(a.created_at),
            cta: "Review", ctaVariant: "primary"
          }));
        });
        blockers.forEach(function (b) {
          items.push(triageItem({
            view: "work", icon: "alert-triangle", iconClass: "tbl", tone: "critical",
            title: "Blocked: " + b, sub: "A task is stuck and needs you to clear the path", cta: "View"
          }));
        });
        if (pendingReviews.length) {
          items.push(triageItem({
            view: "work", icon: "list-checks", iconClass: "tco",
            title: pendingReviews.length + " task" + (pendingReviews.length === 1 ? "" : "s") + " awaiting your review",
            sub: "Work is finished and waiting on your sign-off", cta: "Review"
          }));
        }
        if (ratifiable.length) {
          items.push(triageItem({
            view: "promotions", icon: "brain", iconClass: "tkn",
            title: ratifiable.length + " knowledge item" + (ratifiable.length === 1 ? "" : "s") + " ready to ratify",
            sub: "Agents learned something on recent runs — confirm it to add it to org memory", cta: "Ratify"
          }));
        }
        if (proposed.length) {
          items.push(triageItem({
            view: "learning", icon: "git-branch", iconClass: "tco",
            title: proposed.length + " suggested improvement" + (proposed.length === 1 ? "" : "s") + " to your org",
            sub: "The org is proposing changes to its own roles, policies, or workflows", cta: "Review"
          }));
        }
        notes.forEach(function (n) {
          items.push(triageItem({
            view: "chiefOfStaff", icon: "bell", iconClass: "tco",
            title: "Chief of Staff: " + n.summary, sub: (n.severity || "info") + " · " + relTime(n.created_at), cta: "Open"
          }));
        });

        var left = el("div");
        left.appendChild(capLabel("Needs your attention  (" + items.length + ")"));
        if (items.length) {
          left.appendChild(el("div", { class: "triage-list" }, items));
        } else {
          left.appendChild(el("div", { class: "all-clear" }, [icon("check-circle"), "You're all clear. No approvals, blockers, or knowledge waiting on you."]));
          left.appendChild(el("div", { style: "margin-top:14px" }, emptyCta(
            "sparkles", "Watch the flywheel end-to-end",
            "Run the guided demo to delegate a task, approve it at the governance gate, and see what the org learns — the whole loop, no terminal.",
            actionBtn("Run guided demo", { variant: "primary", onClick: postAction("/runs/demo", "demo started → suspended at approval gate") })
          )));
        }

        var pulse = panel("Org pulse", el("div", null, [
          el("div", { class: "pulse-item" }, [el("span", { class: "pulse-label", text: "Active work" }), el("span", { class: "pulse-value", text: String((w.active_work || []).length) })]),
          el("div", { class: "pulse-item" }, [el("span", { class: "pulse-label", text: "Approvals waiting" }), el("span", { class: "pulse-value", style: approvals.length ? "color:var(--state-pending-fg)" : null, text: String(approvals.length) })]),
          el("div", { class: "pulse-item" }, [el("span", { class: "pulse-label", text: "Latest run" }), el("span", { class: "pulse-value" }, statusBadge(w.latest_run_status))]),
          el("div", { class: "pulse-item" }, [el("span", { class: "pulse-label", text: "Knowledge to ratify" }), el("span", { class: "pulse-value", text: String(ratifiable.length) })]),
          el("div", { class: "pulse-item" }, [el("span", { class: "pulse-label", text: "Collective memory" }), el("span", { class: "pulse-value", text: String((w.collective_memory || []).length) })])
        ]), { action: orgState ? autonomyPill(orgState.autonomy_level) : null });

        return [el("div", { class: "home-grid" }, [left, pulse]), rawDetails({ world: w, approvals: approvals, notifications: notes })];
      },
      runs: async function () {
        var rows = await request("/runs");
        if (!rows.length) {
          return [emptyCta("play", "No runs yet", "A run is one execution attempt of a task. When a run pauses at a governance gate, you'll see it here and in Approvals — OpenMAO's suspend/resume is a clean, non-destructive pause.",
            actionBtn("Run guided demo", { variant: "primary", onClick: postAction("/runs/demo", "demo started → run suspended at approval gate") })), rawDetails(rows)];
        }
        return [panel(null, dataTable([
          { label: "Run", mono: true, render: function (r) { return r.id; } },
          { label: "Status", render: function (r) { return statusBadge(r.status); } },
          { label: "At node", mono: true, render: function (r) { return r.active_node || "—"; } },
          { label: "Paused on approval", mono: true, render: function (r) { return r.suspended_approval_id || "—"; } }
        ], rows), { flush: true }), rawDetails(rows)];
      },
      work: async function () {
        var rows = await request("/work");
        if (!rows.length) {
          return [emptyCta("list-checks", "No tasks yet", "Tasks are how you delegate work to your agents — each one carries an objective, a reviewer, success criteria, and a risk level, governed by approvals. Run the guided demo to create your first.",
            actionBtn("Run guided demo", { variant: "primary", onClick: postAction("/runs/demo", "demo started → first task created") })), rawDetails(rows)];
        }
        return [panel(null, dataTable([
          { label: "Title", render: function (r) { return r.title; } },
          { label: "Owner", width: 150, render: function (r) { return agentName(r.owner); } },
          { label: "Reviewer", width: 120, mono: true, render: function (r) { return r.reviewer || "—"; } },
          { label: "Risk", width: 100, render: function (r) { return riskTag(r.risk_level); } },
          { label: "Status", width: 130, render: function (r) { return statusBadge(r.status); } }
        ], rows), { flush: true }), rawDetails(rows)];
      },
      agents: async function () {
        if (!orgState) await refreshOrg();
        var rows = await request("/agents");
        var work = await request("/work").catch(function () { return []; });
        var byOwner = {};
        work.forEach(function (w) { (byOwner[w.owner] = byOwner[w.owner] || []).push(w); });
        if (!rows.length) {
          return [emptyCta("bot", "No agents registered", "Agents are your AI teammates — each bound to a role, a model, and a governed set of tool actions. Their audited track record is what earns them wider autonomy over time.", null), rawDetails(rows)];
        }
        var grid = el("div", { class: "agent-grid" }, rows.map(function (a) { return agentCard(a, byOwner); }));
        return [grid, rawDetails({ agents: rows, roles: rolesById })];
      },
      approvals: async function () {
        if (!orgState) await refreshOrg();
        var rows = await request("/approvals");
        if (!rows.length) {
          return [emptyCta("shield-check", "Nothing waiting on you", "When an agent reaches a governance gate — a risky action, a spend, an external send — it pauses here with an evidence pack so you can decide in seconds. Approvals are how autonomy stays accountable.", null), rawDetails(rows)];
        }
        var nodes = [capLabel("Pending approvals  (" + rows.length + ")")];
        rows.forEach(function (a) { nodes.push(approvalPack(a)); });
        nodes.push(rawDetails(rows));
        return nodes;
      },
      promotions: async function () {
        var rows = await request("/memory/promotions");
        var pending = rows.filter(function (r) { return r.status === "pending"; });
        var resolved = rows.filter(function (r) { return r.status !== "pending"; });
        if (!rows.length) {
          return [emptyCta("brain", "No knowledge awaiting ratification", "When an agent proposes that something it learned should become shared org knowledge, it lands here with its evidence and corroboration count. Ratifying is how the institutional memory grows — deliberately, not automatically.", null), rawDetails(rows)];
        }
        function ratifyCard(p, isPending) {
          var conf = Math.round((p.confidence != null ? p.confidence : 0.5) * 100);
          var item = el("div", { class: "know-item" + (isPending ? " rq" : "") });
          item.appendChild(el("div", { class: "ki-hd" }, [
            el("div", { class: "ki-conf", text: conf + "%" }),
            el("div", { style: "min-width:0" }, [
              el("div", { class: "ki-title", text: p.proposed_content }),
              el("div", { class: "ki-prov", text: "proposed by " + agentName(p.proposed_by) + " · " + p.corroboration_count + (p.corroboration_count === 1 ? " independent confirmation" : " independent confirmations") + " · " + relTime(p.created_at) })
            ]),
            el("div", { style: "margin-left:auto;flex:none" }, statusBadge(p.status))
          ]));
          if (p.rationale) item.appendChild(el("div", { class: "rationale", style: "margin-top:9px", text: p.rationale }));
          return item;
        }
        var nodes = [];
        if (pending.length) {
          nodes.push(capLabel("Ready to ratify  (" + pending.length + ")"));
          nodes.push(el("div", { class: "know-list" }, pending.map(function (p) { return ratifyCard(p, true); })));
        }
        if (resolved.length) {
          nodes.push(el("div", { style: "margin-top:18px" }, capLabel("Resolved  (" + resolved.length + ")")));
          nodes.push(el("div", { class: "know-list" }, resolved.map(function (p) { return ratifyCard(p, false); })));
        }
        nodes.push(rawDetails(rows));
        return nodes;
      },
      learning: async function () {
        var rows = await request("/learning/proposals");
        if (!rows.length) {
          return [emptyCta("git-branch", "The org hasn't proposed any changes yet", "This is the self-correction surface: as the org runs, it spots patterns and proposes changes to its own roles, policies, and workflows — each with evidence, for your ratification. It stays empty until there's a signal worth acting on.", null), rawDetails(rows)];
        }
        var cards = rows.map(function (p) {
          var topLeft = el("div", { style: "display:flex;gap:8px;align-items:center;flex-wrap:wrap" }, [tag(p.change_type), el("span", { class: "meta-line", text: "signal: " + p.source_signal })]);
          var top = el("div", { style: "display:flex;justify-content:space-between;gap:12px;align-items:center" }, [topLeft, statusBadge(p.status)]);
          var meta = el("span", { class: "meta-line", text: "confidence " + Math.round((p.confidence != null ? p.confidence : 0.5) * 100) + "% · impact " + p.impact });
          var actions = el("div", { style: "margin-left:auto;display:flex;gap:8px;flex-wrap:wrap" });
          if (p.status === "proposed" && p.review_approval_id) {
            actions.appendChild(actionBtn("Ratify", { variant: "primary", onClick: postAction("/approvals/" + p.review_approval_id + "/approve", "improvement ratified") }));
            actions.appendChild(actionBtn("Reject", { variant: "danger", onClick: postAction("/approvals/" + p.review_approval_id + "/reject", "improvement rejected") }));
          } else if (p.status === "approved") {
            actions.appendChild(actionBtn("Apply to org", { onClick: postAction("/learning/proposals/" + p.id + "/apply", "improvement applied — reversible") }));
          } else if (p.status === "applied") {
            actions.appendChild(el("span", { class: "meta-line", style: "color:var(--state-success-fg)", text: "applied to org" }));
          } else if (p.status === "rejected") {
            actions.appendChild(el("span", { class: "meta-line", text: "dismissed" }));
          }
          var footer = el("div", { style: "display:flex;gap:14px;align-items:center" }, [meta, actions]);
          return el("div", { class: "panel" }, el("div", { class: "panel-body", style: "display:flex;flex-direction:column;gap:12px" }, [top, el("div", { class: "rationale", text: p.rationale }), footer]));
        });
        cards.push(rawDetails(rows));
        return cards;
      },
      memory: async function () {
        var collective = await request("/memory/collective");
        var individual = await request("/memory/individual/" + COORDINATOR_AGENT_ID);
        function memList(entries, emptyText) {
          if (!entries.length) return el("div", { class: "emptyrow" }, emptyText);
          return kvlist(entries.map(function (m) {
            var conf = m.confidence != null ? " · " + Math.round(m.confidence * 100) + "% confidence" : "";
            return {
              key: m.kind,
              value: [
                el("div", null, [document.createTextNode(m.content + " "), statusBadge(m.status)]),
                el("div", { class: "meta-line", style: "margin-top:3px", text: "provenance: " + ((m.provenance && (m.provenance.source || m.provenance.kind)) || "—") + conf })
              ]
            };
          }));
        }
        if (!collective.length && !individual.length) {
          return [emptyCta("brain", "No institutional knowledge yet", "This is the compounding asset: knowledge an agent learns, gets corroborated, and you ratify, becomes shared org memory with full provenance. It grows as work runs through the flywheel.",
            actionBtn("Run guided demo", { variant: "primary", onClick: postAction("/runs/demo", "demo started → memory will be promoted on approve") })), rawDetails({ collective: collective, individual: individual })];
        }
        return [
          panel("What the org has learned", memList(collective, "Nothing ratified into shared memory yet."), { action: devNames ? tag("scope: collective") : tag("shared") }),
          panel("One agent's private notes · " + agentName(COORDINATOR_AGENT_ID), memList(individual, "No private notes for this agent.")),
          rawDetails({ collective: collective, individual: individual })
        ];
      },
      capabilities: async function () {
        var rows = await request("/capabilities");
        function permLabel(p) {
          var map = { enabled: "Allowed", approval_required: "Needs approval", disabled: "Blocked" };
          var cls = p === "enabled" ? "p-allow" : p === "disabled" ? "p-deny" : "p-ask";
          return el("span", { class: cls, text: map[p] || p });
        }
        if (!rows.length) {
          return [emptyCta("layers", "No tool actions registered", "Tool actions are the governed things agents can do in the world — each with a default permission (allowed / needs approval / blocked) and a risk level. This is the fine-grained layer beneath the autonomy dial.", null), rawDetails(rows)];
        }
        var grid = el("div", { class: "cap-grid" });
        grid.appendChild(el("div", { class: "cap-row hdr" }, [
          el("span", { class: "cap-name", text: "Tool action" }),
          el("span", { style: "width:90px;flex:none", text: "Risk" }),
          el("span", { style: "width:140px;flex:none", text: "Default permission" })
        ]));
        rows.forEach(function (r) {
          grid.appendChild(el("div", { class: "cap-row" }, [
            el("div", { class: "cap-name" }, [el("div", { text: r.name }), el("div", { class: "cap-sub", text: r.description || (r.side_effecting ? "has side effects" : "read-only") })]),
            el("span", { style: "width:90px;flex:none" }, riskTag(r.risk_level)),
            el("span", { style: "width:140px;flex:none" }, permLabel(r.default_permission))
          ]));
        });
        return [grid, rawDetails(rows)];
      },
      capabilityCalls: async function () {
        var calls = await request("/capability-calls");
        var results = await request("/capability-results");
        var byCall = {};
        results.forEach(function (r) { byCall[r.call_id] = r.status; });
        if (!calls.length) {
          return [emptyCta("arrow-right-left", "No tool actions requested yet", "Every time an agent invokes a governed tool action, the request and its result are recorded here — the audit trail of what your agents actually did in the world.", null), rawDetails({ calls: calls, results: results })];
        }
        return [panel(null, dataTable([
          { label: "Action", mono: true, render: function (r) { return r.capability_name; } },
          { label: "Requested by", width: 150, render: function (r) { return agentName(r.requested_by); } },
          { label: "Risk", width: 90, render: function (r) { return riskTag(r.risk_level); } },
          { label: "Result", width: 110, render: function (r) { return byCall[r.id] ? statusBadge(byCall[r.id]) : tag("awaiting"); } }
        ], calls), { flush: true }), rawDetails({ calls: calls, results: results })];
      },
      events: async function () {
        var rows = await request("/events");
        function family(kind) {
          if (kind.indexOf("approved") >= 0 || kind.indexOf("completed") >= 0 || kind.indexOf("promoted") >= 0 || kind.indexOf("ratified") >= 0) return "go";
          if (kind.indexOf("requested") >= 0 || kind.indexOf("suspended") >= 0 || kind.indexOf("blocked") >= 0 || kind.indexOf("failed") >= 0 || kind.indexOf("rejected") >= 0) return "warn";
          return "";
        }
        if (!rows.length) {
          return [emptyCta("activity", "The audit trail is empty", "Every action the org takes is appended here, in order — a human-readable, reversible history. Reject and revert are your undo. It fills as work runs.", null), rawDetails(rows)];
        }
        var tl = el("div", { class: "tl" });
        rows.forEach(function (e) {
          tl.appendChild(el("div", { class: "ev " + family(e.kind) }, [
            el("span", { class: "seq", text: String(e.seq).padStart(3, "0") }),
            el("span", { class: "kind", text: e.kind }),
            el("span", { class: "actor", text: e.actor })
          ]));
        });
        return [panel("Audit trail", tl, { action: tag(rows.length + (rows.length === 1 ? " event" : " events")) }), rawDetails(rows)];
      },
      traces: async function () {
        var runs = await request("/runs");
        var run = null;
        for (var i = 0; i < runs.length; i++) { if (runs[i].id === RUN_ID) { run = runs[i]; break; } }
        if (!run) run = runs[0];
        var rows = run ? await request("/runs/" + run.id + "/traces") : [];
        if (!rows.length) {
          return [emptyCta("git-commit-horizontal", "No traces yet", "Traces are the per-node execution detail of a run — the deepest drill-down for debugging what an agent did, step by step. They appear once a run executes.", null), rawDetails(rows)];
        }
        return [panel(null, dataTable([
          { label: "Node", mono: true, render: function (r) { return r.node; } },
          { label: "Timestamp", width: 180, mono: true, render: function (r) { return r.timestamp; } },
          { label: "Run", mono: true, render: function (r) { return r.run_id; } }
        ], rows), { flush: true }), rawDetails(rows)];
      },
      search: async function () {
        var input = el("input", { class: "input", type: "search", placeholder: "Search what the org knows…", style: "width: 360px; max-width: 100%" });
        var resultsBox = el("div");
        var prompt = "Search across shared org knowledge and agents' private notes.";
        async function run() {
          var q = input.value.trim();
          if (!q) { resultsBox.replaceChildren(note(prompt)); return; }
          resultsBox.replaceChildren(loadingNote());
          try {
            var results = await request("/memory/search?q=" + encodeURIComponent(q));
            if (!results.length) { resultsBox.replaceChildren(note("No knowledge matched “" + q + "”.")); return; }
            var rows = results.map(function (r) {
              return {
                scope: r.entry.scope, kind: r.entry.kind, confidence: r.entry.confidence,
                corroboration_count: r.evidence.corroboration_count, content: r.entry.content
              };
            });
            resultsBox.replaceChildren(
              panel(null, dataTable([
                { label: "Knowledge", render: function (r) { return r.content; } },
                { label: "Where", width: 110, render: function (r) { return tag(r.scope === "collective" ? "shared" : "private"); } },
                { label: "Kind", width: 110, mono: true, render: function (r) { return r.kind; } },
                { label: "Confidence", width: 100, mono: true, render: function (r) { return Math.round((r.confidence || 0) * 100) + "%"; } },
                { label: "Confirmations", width: 120, mono: true, render: function (r) { return r.corroboration_count; } }
              ], rows), { flush: true }),
              rawDetails(results)
            );
          } catch (e) { resultsBox.replaceChildren(errorView(e)); }
        }
        input.addEventListener("keydown", function (e) { if (e.key === "Enter") run(); });
        resultsBox.appendChild(note(prompt));
        return [el("div", { style: "display:flex; gap:8px; margin-bottom:16px" }, [input, actionBtn("Search", { variant: "primary", onClick: run })]), resultsBox];
      },
      chiefOfStaff: async function () {
        var rows = await request("/cos/notifications");
        if (!rows.length) {
          return [emptyCta("bell", "Nothing from your Chief of Staff", "The Chief of Staff is your minimum-workload oversight proxy — it sweeps the org on a schedule and surfaces only what needs you. A quiet log means nothing is escalating. Run a sweep to check now.",
            actionBtn("Run a sweep", { variant: "primary", onClick: postAction("/cos/tick", "Chief of Staff ran a sweep") })), rawDetails(rows)];
        }
        return [panel(null, dataTable([
          { label: "Severity", render: function (r) { return sevBadge(r.severity); } },
          { label: "Summary", render: function (r) { return r.summary; } },
          { label: "Status", width: 110, render: function (r) { return statusBadge(r.status); } },
          { label: "", width: 112, render: function (r) { return r.status === "unread" ? actionBtn("Mark read", { onClick: postAction("/cos/notifications/" + r.id + "/read", "marked read") }) : ""; } }
        ], rows), { flush: true }), rawDetails(rows)];
      },
      cadences: async function () {
        var rows = await request("/cadences");
        if (!rows.length) {
          return [emptyCta("repeat", "No schedules set", "Schedules are the recurring sweeps your Chief of Staff runs — learning scans, stale-approval sweeps, status digests. They keep oversight lightweight and automatic.", null), rawDetails(rows)];
        }
        return [panel(null, dataTable([
          { label: "Sweep", mono: true, render: function (r) { return r.kind; } },
          { label: "Every", width: 120, mono: true, render: function (r) { return r.interval_seconds != null ? r.interval_seconds + "s" : "—"; } },
          { label: "Enabled", width: 110, render: function (r) { return statusBadge(r.enabled ? "enabled" : "disabled"); } },
          { label: "Next due", mono: true, render: function (r) { return r.next_due_at || "—"; } }
        ], rows), { flush: true }), rawDetails(rows)];
      }
    };

    async function load(view) {
      setActive(view);
      setViewActions(view);
      mount.replaceChildren(loadingNote());
      try {
        var nodes = await VIEWS[view]();
        mount.replaceChildren.apply(mount, [].concat(nodes));
      } catch (e) {
        mount.replaceChildren(errorView(e));
      }
    }

    function setNavBadge(id, n) {
      var b = document.getElementById(id);
      if (!b) return;
      if (n > 0) { b.textContent = String(n); b.hidden = false; } else { b.hidden = true; }
    }
    // Light "what needs you" counters on the nav, so triage is visible from anywhere.
    async function refreshBadges() {
      if (!operatorToken()) { setNavBadge("home-badge", 0); setNavBadge("appr-badge", 0); return; }
      try {
        var res = await Promise.all([
          request("/approvals").catch(function () { return []; }),
          request("/memory/promotions").catch(function () { return []; }),
          request("/world").catch(function () { return {}; })
        ]);
        var approvals = res[0], promos = res[1], w = res[2] || {};
        var ratifiable = promos.filter(function (p) { return p.status === "pending"; }).length;
        var attention = approvals.length + ratifiable + (w.blockers || []).length + (w.pending_reviews || []).length;
        setNavBadge("appr-badge", approvals.length);
        setNavBadge("home-badge", attention);
      } catch (e) { /* ignore */ }
    }

    function applyDevNames() {
      devNamesBtn.setAttribute("aria-pressed", String(devNames));
      // Surface the kernel term next to grouped nav labels too.
      document.querySelectorAll(".navbtn").forEach(function (b) {
        var view = b.getAttribute("data-view");
        var label = b.querySelector(".navlabel");
        if (!label) return;
        var existing = b.querySelector(".dev-name");
        if (existing) existing.remove();
        var dn = devName(view);
        if (dn) label.insertAdjacentElement("afterend", dn);
      });
    }

    async function reloadAll() {
      orgState = null;
      await refreshWorkspaces();
      await refreshOrg();
      await load(activeView);
      refreshBadges();
    }

    document.querySelectorAll(".navbtn").forEach(function (b) {
      var s = b.querySelector(".ico");
      var name = b.getAttribute("data-icon");
      if (s && ICONS[name]) s.innerHTML = ICONS[name];
      b.addEventListener("click", function () { load(b.getAttribute("data-view")); });
    });
    themeToggle.addEventListener("click", function () {
      var next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
      applyTheme(next);
    });
    devNamesBtn.addEventListener("click", function () {
      devNames = !devNames;
      localStorage.setItem("openmaoDevNames", devNames ? "1" : "0");
      applyDevNames();
      load(activeView);
    });
    wsSwitcher.addEventListener("change", function () {
      selectedWorkspace = wsSwitcher.value;
      sessionStorage.setItem("openmaoWorkspace", selectedWorkspace);
      reloadAll();
    });
    document.getElementById("refresh").addEventListener("click", function () { reloadAll(); });
    document.getElementById("reset-token").addEventListener("click", function () {
      sessionStorage.removeItem("openmaoOperatorToken");
      tokenInput.value = "";
      reloadAll();
    });
    tokenInput.value = sessionStorage.getItem("openmaoOperatorToken") || "";
    tokenInput.addEventListener("change", function () {
      sessionStorage.setItem("openmaoOperatorToken", tokenInput.value);
      reloadAll();
    });

    applyTheme(localStorage.getItem("openmaoConsoleTheme") === "dark" ? "dark" : "light");
    applyDevNames();
    reloadAll();
  </script>
</body>
</html>`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? "8000");
  const operatorToken = process.env.OPENMAO_OPERATOR_TOKEN ?? randomBytes(16).toString("hex");
  createServer({ operatorToken }).listen(port, DEFAULT_HTTP_HOST, () => {
    console.log(`OpenMAO API/console listening on http://${DEFAULT_HTTP_HOST}:${port}`);
    if (!process.env.OPENMAO_OPERATOR_TOKEN) {
      console.log(`OpenMAO local operator token: ${operatorToken}`);
    }
  });
}
