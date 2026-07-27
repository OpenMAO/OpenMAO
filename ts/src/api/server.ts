import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

import { CapabilityRegistryError } from "../capabilities/index.js";
import { ChiefOfStaffService } from "../chief_of_staff/index.js";
import {
  type CapabilityCall,
  CapabilityCallSchema,
  newId,
  type ResourceGrants,
  utcNow,
} from "../contracts/index.js";
import { ApprovalService, SelfApprovalError } from "../governance/index.js";
import { IngestionService } from "../ingestion/index.js";
import { LearningService } from "../learning/index.js";
import { MemoryRetrievalService, PromotionService } from "../memory/index.js";
import { OrgChangeService } from "../org/index.js";
import {
  AgentStore,
  BoundedWorkEnvelopeStore,
  CapabilityCallConflictError,
  CapabilityCallStore,
  CapabilityResultConflictError,
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
  type AuthenticatedPrincipal,
  enrichPrincipalIdentity,
} from "../security/authenticated-principal.js";
import { PrincipalAuthService } from "../security/principal-auth.js";
import { SensitiveMaterialError, safeErrorMessage } from "../security/sensitive-material.js";
import { WorkerAuthService } from "../security/worker-auth.js";
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
import { consoleHtml } from "./console.js";

type ServerOptions = {
  dbPath?: string;
};

const DEFAULT_HTTP_HOST = "127.0.0.1";
const PRINCIPAL_TOKEN_HEADER = "x-openmao-principal-token";
const WORKER_TOKEN_HEADER = "x-openmao-worker-token";
const WORKSPACE_HEADER = "x-openmao-workspace";
const LEGACY_WORKSPACE_HEADER = "x-openmao-workspace-id";
// Self-asserted identity is gone. These headers are not ignored — a caller
// presenting one is attempting the spoof this boundary exists to close, and
// the request is refused with 400 even when it carries a valid credential.
// The list is a permanent regression fence: do not remove entries.
const ACTOR_HEADER = "x-openmao-actor";
const REJECTED_HEADERS: readonly string[] = [ACTOR_HEADER, "x-openmao-operator-token"];

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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
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

/**
 * The authenticated boundary principal. Every variant carries the stable
 * principal id the request's authority derives from; `actor` on the context
 * is always derived from it, never from a caller-supplied value. An operator
 * is a registry principal resolved from its credential (key id from the
 * stored enrolment, when one is active); a worker's principal id is its
 * worker id — the worker-token path was already principal-shaped (#127).
 */
type Principal =
  | { kind: "operator"; principalId: string; keyId: string | null }
  | { kind: "worker"; workerId: string; principalId: string; keyId: string | null };

type RequestContext = {
  actor: string;
  workspaceId: string;
  principal: Principal;
  /**
   * The branded authenticated identity behind an operator request (null for a
   * worker-token request, whose authority is the worker itself). Callers that
   * must pass a verified identity on to a service — never a bare string —
   * take it from here; it cannot be fabricated at the call site.
   */
  authenticated: AuthenticatedPrincipal | null;
};

// A worker token is permitted ONLY these routes; everything else (envelope issuance, approvals, and
// every admin/read-all route) requires an operator principal credential. Default-deny for workers.
function isWorkerAllowed(method: string, pathname: string): boolean {
  if (method === "GET") {
    return (
      pathname === "/workspaces/current" ||
      pathname === "/capability-calls" ||
      pathname === "/capability-results" ||
      /^\/work\/[^/]+\/envelopes$/.test(pathname)
    );
  }
  if (method === "POST") {
    return pathname === "/capability-calls" || /^\/work\/[^/]+\/outcomes$/.test(pathname);
  }
  return false;
}

/**
 * Resolves the authenticated principal for a request. There is no shared
 * operator token and no self-asserted actor: a principal credential resolves
 * through PrincipalAuthService, which FORCES the identity and workspace from
 * the stored credential row, and the worker-token path forces them from the
 * stored worker credential the same way. Fails closed: a retired
 * self-assertion header is a 400 (presenting it is a spoof attempt, never a
 * hint), anything unauthenticated is a 403.
 */
function authenticateContext(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  database: Database,
): RequestContext | null {
  const identity = new PrincipalAuthService(database).resolve(
    headerValue(request, PRINCIPAL_TOKEN_HEADER),
  );
  if (identity) {
    const principal = enrichPrincipalIdentity(database, identity);
    if (!principal) {
      sendJson(response, 403, { error: "forbidden" });
      return null;
    }
    // The workspace is forced from the stored credential. An explicit
    // selection is honoured only when it AGREES — a conflicting one would be
    // an attempt to act in a workspace the credential does not bind.
    const selectedWorkspace =
      headerValue(request, WORKSPACE_HEADER) ??
      headerValue(request, LEGACY_WORKSPACE_HEADER) ??
      url.searchParams.get("workspace_id");
    if (selectedWorkspace !== null && selectedWorkspace !== principal.workspace_id) {
      sendJson(response, 400, { error: "workspace_mismatch" });
      return null;
    }
    return {
      actor: principal.actor,
      workspaceId: principal.workspace_id,
      principal: {
        kind: "operator",
        principalId: principal.principal_id,
        keyId: principal.key_id,
      },
      authenticated: principal,
    };
  }
  // Worker token → a scoped principal. The actor and workspace are FORCED to the resolved worker; a
  // worker can never spoof another identity or workspace through headers.
  const workerPrincipal = new WorkerAuthService(database).resolve(
    headerValue(request, WORKER_TOKEN_HEADER),
  );
  if (workerPrincipal) {
    return {
      actor: workerPrincipal.worker_id,
      workspaceId: workerPrincipal.workspace_id,
      principal: {
        kind: "worker",
        workerId: workerPrincipal.worker_id,
        principalId: workerPrincipal.worker_id,
        keyId: null,
      },
      authenticated: null,
    };
  }
  sendJson(response, 403, { error: "forbidden" });
  return null;
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

/**
 * The authenticated operator behind a demo route. Unreachable for a worker
 * principal (the worker allowlist already 403s these routes), so a missing
 * identity here is a server bug, not a client error — throw rather than
 * record under a fabricated actor.
 */
function operatorOf(context: RequestContext): AuthenticatedPrincipal {
  if (!context.authenticated) {
    throw new Error("demo route reached without an authenticated operator principal");
  }
  return context.authenticated;
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
  return createHttpServer(async (request: IncomingMessage, response: ServerResponse) => {
    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      sendJson(response, 403, { error: "loopback_only" });
      return;
    }

    // The self-assertion fence applies to EVERY route — including the
    // unauthenticated /health and /console: presenting a retired identity
    // header is a spoof attempt, and the rule is 400 with no exceptions.
    // Checked before routing so no dispatch order can bypass it again.
    for (const rejected of REJECTED_HEADERS) {
      if (headerValue(request, rejected) !== null) {
        sendJson(response, 400, {
          error: rejected === ACTOR_HEADER ? "actor_header_rejected" : "operator_token_removed",
          message: `${rejected} is not accepted: identity is established by a principal credential (${PRINCIPAL_TOKEN_HEADER})`,
        });
        return;
      }
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
        sendHtml(
          response,
          consoleHtml({
            RUN_ID,
            COORDINATOR_AGENT_ID,
            TOKEN_HEADER: PRINCIPAL_TOKEN_HEADER,
            WORKSPACE_ID,
          }),
        );
        return;
      }

      const context = authenticateContext(request, response, url, database);
      if (!context) {
        return;
      }
      // Default-deny: a worker token may reach only its allowlisted routes. This is what makes
      // envelope issuance, approvals, and every admin route operator-only — so a worker can never
      // issue itself a wider envelope or approve its own calls (#102).
      if (
        context.principal.kind === "worker" &&
        !isWorkerAllowed(request.method ?? "", url.pathname)
      ) {
        sendJson(response, 403, { error: "worker_forbidden" });
        return;
      }

      if (request.method === "POST" && url.pathname === "/runs/demo") {
        if (!requireDemoWorkspace(response, context.workspaceId)) {
          return;
        }
        sendJson(response, 200, await spine.startDemo());
        return;
      }
      if (request.method === "POST" && url.pathname === "/runs/demo/approve") {
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
        // A worker sees only its OWN calls; the operator sees all in the workspace.
        const callWorkerId =
          context.principal.kind === "worker" ? context.principal.workerId : null;
        const calls = new CapabilityCallStore(database).listForWorkspace(context.workspaceId);
        sendJson(
          response,
          200,
          callWorkerId === null ? calls : calls.filter((c) => c.requested_by === callWorkerId),
        );
        return;
      }
      // The one out-of-process capability-INITIATE primitive: an external worker submits a
      // CapabilityCall for gating. The route is deliberately thin — it forces the call's workspace
      // to the authenticated one and otherwise routes the call UNCHANGED through
      // CapabilityRegistryService.invoke(), which is the single enforcement point (task-envelope
      // scope, worker grant, credential-handle binding, side-effect/approval gate, idempotent
      // at-most-once execution). A hostile body cannot escape those bounds; see #92.
      if (request.method === "POST" && url.pathname === "/capability-calls") {
        const body = await readJsonBody(request);
        const externalActor = body.external_actor;
        // A worker principal can only act AS ITSELF — its identity is forced from the authenticated
        // token, never taken from the body, so it cannot impersonate another worker.
        const callerWorkerId =
          context.principal.kind === "worker" ? context.principal.workerId : null;
        let call: CapabilityCall;
        try {
          call = CapabilityCallSchema.parse({
            id: typeof body.id === "string" ? body.id : newId("call"),
            workspace_id: context.workspaceId,
            run_id: String(body.run_id ?? ""),
            capability_name: String(body.capability_name ?? ""),
            provider: String(body.provider ?? ""),
            input: asRecord(body.input),
            requested_by: callerWorkerId ?? String(body.requested_by ?? ""),
            external_actor: callerWorkerId
              ? { actor_type: "worker", actor_id: callerWorkerId, display_name: null }
              : externalActor && typeof externalActor === "object" && !Array.isArray(externalActor)
                ? externalActor
                : null,
            task_id: String(body.task_id ?? ""),
            credential_handle:
              typeof body.credential_handle === "string" ? body.credential_handle : null,
            side_effecting: body.side_effecting === true,
            audit_payload: asRecord(body.audit_payload),
            risk_level: typeof body.risk_level === "string" ? body.risk_level : "low",
            idempotency_key: String(body.idempotency_key ?? ""),
          });
        } catch (error) {
          sendJson(response, 400, {
            error: safeErrorMessage(error instanceof Error ? error.message : String(error)),
          });
          return;
        }
        // A non-empty idempotency key is required: an empty key would be shared by every keyless
        // call workspace-wide, causing spurious conflicts or silent deduplication.
        if (!call.idempotency_key) {
          sendJson(response, 400, { error: "idempotency_key is required" });
          return;
        }
        try {
          const invocation = await createConfiguredCapabilityRegistry(database).invoke(call);
          sendJson(response, 200, invocation);
        } catch (error) {
          // Reusing an idempotency key with a DIFFERENT call/result id is a client-side conflict, not
          // a server fault: surface it as 409 with a stable, detail-free code (never echo internal
          // text). Checked before the generic fallback below.
          if (error instanceof CapabilityCallConflictError) {
            sendJson(response, 409, { error: "capability_call_conflict" });
            return;
          }
          if (error instanceof CapabilityResultConflictError) {
            sendJson(response, 409, { error: "capability_result_conflict" });
            return;
          }
          // Scrub EVERY error (not only CapabilityRegistryError) so a sensitive-material or any other
          // error can never echo a secret-adjacent string into the response. Registry rejections are
          // client errors (400); anything else is a server error (500) — still scrubbed.
          const message = safeErrorMessage(error instanceof Error ? error.message : String(error));
          const clientError =
            error instanceof CapabilityRegistryError || error instanceof SensitiveMaterialError;
          sendJson(response, clientError ? 400 : 500, { error: message });
        }
        return;
      }
      if (request.method === "GET" && url.pathname === "/capability-results") {
        const results = new CapabilityResultStore(database).listForWorkspace(context.workspaceId);
        if (context.principal.kind === "worker") {
          // A worker sees only results for its OWN calls.
          const ownWorkerId = context.principal.workerId;
          const ownCallIds = new Set(
            new CapabilityCallStore(database)
              .listForWorkspace(context.workspaceId)
              .filter((c) => c.requested_by === ownWorkerId)
              .map((c) => c.id),
          );
          sendJson(
            response,
            200,
            results.filter((result) => ownCallIds.has(result.call_id)),
          );
          return;
        }
        sendJson(response, 200, results);
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
        if (!requireDemoWorkspace(response, context.workspaceId)) {
          return;
        }
        sendJson(response, 200, await runReferenceWorkerDemo(database, operatorOf(context)));
        return;
      }
      if (request.method === "POST" && url.pathname === "/workers/reference-demo/approve") {
        if (!requireDemoWorkspace(response, context.workspaceId)) {
          return;
        }
        sendJson(response, 200, await approveReferenceWorkerDemo(database, operatorOf(context)));
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
        // The body's actor is foreign PROVENANCE, never authority: the
        // recorded event's actor is the authenticated principal, and the ref
        // lands in payload.actor_ref. An inbound event claiming OpenMAO
        // operator authority is refused.
        if (actorType === "operator") {
          sendJson(response, 400, {
            error: "operator_actor_forbidden",
            message:
              "an inbound foreign event cannot claim OpenMAO operator authority (actor_type: operator)",
          });
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
            recorded_by: context.actor,
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
        const body = await readJsonBody(request);
        const output = body.output;
        sendJson(
          response,
          201,
          new WorkService(database).submitWorkerOutcome({
            id: typeof body.id === "string" ? body.id : null,
            workspace_id: context.workspaceId,
            envelope_id: String(body.envelope_id ?? ""),
            // A worker principal submits outcomes only as ITSELF — forced from the token.
            worker_id:
              context.principal.kind === "worker"
                ? context.principal.workerId
                : String(body.worker_id ?? ""),
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
        // A worker sees only the envelopes issued to ITSELF; the operator sees all for the item.
        const envWorkerId = context.principal.kind === "worker" ? context.principal.workerId : null;
        const envelopes = new BoundedWorkEnvelopeStore(database).listForWorkItem(
          context.workspaceId,
          approvalRoute.workEnvelopeId,
        );
        sendJson(
          response,
          200,
          envWorkerId === null
            ? envelopes
            : envelopes.filter((envelope) => envelope.worker_id === envWorkerId),
        );
        return;
      }
      if (request.method === "POST" && approvalRoute.workEnvelopeId) {
        const body = await readJsonBody(request);
        const input = body.input;
        try {
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
              resource_grants:
                body.resource_grants &&
                typeof body.resource_grants === "object" &&
                !Array.isArray(body.resource_grants)
                  ? (body.resource_grants as ResourceGrants)
                  : null,
              input:
                input && typeof input === "object" && !Array.isArray(input)
                  ? (input as Record<string, unknown>)
                  : {},
              idempotency_key:
                typeof body.idempotency_key === "string" ? body.idempotency_key : null,
            }),
          );
        } catch (error) {
          // Mirror the capability route: scrub every error so a secret-shaped resource grant (or any
          // other failure) can never echo secret-adjacent material. A sensitive-material rejection is
          // a client error (400); anything else is a server error (500) — still scrubbed.
          const message = safeErrorMessage(error instanceof Error ? error.message : String(error));
          sendJson(response, error instanceof SensitiveMaterialError ? 400 : 500, {
            error: message,
          });
        }
        return;
      }
      if (request.method === "GET" && approvalRoute.individualMemoryAgentId) {
        // Provenance invariant (#113): the individual-memory read goes through
        // the trust-filtered retrieval, so untrusted memory never surfaces here
        // without the reviewed path. Default = guidance-eligible only; the
        // response stays a raw MemoryEntry[] for the console contract.
        sendJson(
          response,
          200,
          new MemoryRetrievalService(database)
            .list(context.workspaceId, {
              scope: "individual",
              owner_id: approvalRoute.individualMemoryAgentId,
            })
            .map((result) => result.entry),
        );
        return;
      }
      if (request.method === "GET" && url.pathname === "/memory/collective") {
        // Collective memory is inherently guidance-eligible: only ratified
        // entries become collective (#113), so reading the store directly here
        // surfaces nothing untrusted and needs no trust filter.
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
        sendJson(
          response,
          200,
          new ChiefOfStaffService(database).ensureDefaultCadences(context.workspaceId, utcNow()),
        );
        return;
      }
      if (request.method === "POST" && url.pathname === "/cos/tick") {
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
          sendJson(response, 200, await approveReferenceWorkerDemo(database, operatorOf(context)));
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
      if (error instanceof SelfApprovalError) {
        // Separation of duties: the approver is the same identity that requested the approval.
        // That is a caller-side conflict, not a server fault — map it to 409 with a stable code
        // and a safe message rather than echoing the internal exception text (#101).
        sendJson(response, 409, {
          error: "self_approval_forbidden",
          message: "approver must differ from requester",
        });
        return;
      }
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      database.close();
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? "8000");
  createServer().listen(port, DEFAULT_HTTP_HOST, () => {
    console.log(`OpenMAO API/console listening on http://${DEFAULT_HTTP_HOST}:${port}`);
    console.log(
      `Authenticate with a principal credential in the ${PRINCIPAL_TOKEN_HEADER} header (see \`principals init\`).`,
    );
  });
}
