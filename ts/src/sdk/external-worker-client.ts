/**
 * A network SDK for an OUT-OF-PROCESS external worker. Where `OpenMaoLocalClient` drives an
 * in-process `Database` handle, this client speaks only the loopback HTTP API over `fetch` — so a
 * real separate process (e.g. a "Hermes worker" running its own runtime) can request a governed
 * capability and submit an outcome under OpenMAO authority without ever sharing the database, a
 * provider, or a raw credential.
 *
 * It authenticates with a **per-worker token** (`x-openmao-worker-token`), NOT the operator token —
 * so it can ONLY act as its own worker: it cannot issue envelopes, approve, or impersonate another
 * worker. The worker's identity and workspace are forced server-side from the token (so this client
 * never sets `requested_by` / `worker_id` / workspace itself). Operator actions (registering a
 * worker, issuing its bounded envelope, minting its token) are done by the operator, out of band.
 */
export type ExternalWorkerClientOptions = {
  baseUrl: string;
  workerToken: string;
};

export type CapabilityCallRequest = {
  id?: string;
  run_id: string;
  capability_name: string;
  provider: string;
  input?: Record<string, unknown>;
  task_id: string;
  credential_handle?: string | null;
  side_effecting?: boolean;
  audit_payload?: Record<string, unknown>;
  risk_level?: "low" | "medium" | "high";
  idempotency_key: string;
};

export type WorkerOutcomeRequest = {
  id?: string;
  envelope_id: string;
  status: "completed" | "blocked" | "failed";
  summary: string;
  output?: Record<string, unknown>;
  artifacts?: unknown[];
  idempotency_key: string;
};

export class ExternalWorkerClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export class ExternalWorkerClient {
  constructor(private readonly options: ExternalWorkerClientOptions) {}

  /** List the bounded envelopes issued to a work item — how the worker discovers its authority. */
  listEnvelopes(workItemId: string): Promise<unknown[]> {
    return this.request<unknown[]>("GET", `/work/${encodeURIComponent(workItemId)}/envelopes`);
  }

  /**
   * Request a governed capability. The server gates it through `invoke()`: a within-envelope
   * side-effecting call SUSPENDS for approval (the returned invocation carries an `approval_id` and
   * no successful result); an out-of-bounds call is BLOCKED. Idempotent on the call `id`.
   */
  requestCapability(call: CapabilityCallRequest): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("POST", "/capability-calls", call);
  }

  /** Poll the recorded capability results (e.g. to observe an approved call's `ok` result). */
  listResults(): Promise<unknown[]> {
    return this.request<unknown[]>("GET", "/capability-results");
  }

  /** Submit the bounded work's outcome back into the org record. Idempotent on `idempotency_key`. */
  submitOutcome(
    workItemId: string,
    outcome: WorkerOutcomeRequest,
  ): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(
      "POST",
      `/work/${encodeURIComponent(workItemId)}/outcomes`,
      outcome,
    );
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const init: RequestInit = {
      method,
      headers: {
        "content-type": "application/json",
        "x-openmao-worker-token": this.options.workerToken,
      },
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }
    const response = await fetch(`${this.options.baseUrl}${path}`, init);
    const text = await response.text();
    const parsed = text ? JSON.parse(text) : null;
    if (!response.ok) {
      const message =
        parsed && typeof parsed === "object" && "error" in parsed
          ? String((parsed as { error: unknown }).error)
          : `request failed: ${method} ${path}`;
      throw new ExternalWorkerClientError(message, response.status);
    }
    return parsed as T;
  }
}
