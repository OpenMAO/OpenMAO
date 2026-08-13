# Governed External Worker Walkthrough

This example runs a second deterministic scenario alongside the default Acme Learning Lab demo. A
mock external worker receives bounded work, requests a mock side effect, pauses at the approval
gate, and records its outcome after approval. It needs no API keys, external credentials, or hosted
services.

## Use an Isolated Database

Install the dependencies, then point this walkthrough at a temporary database so it does not share
state with another demo:

```bash
make install
OPENMAO_EXAMPLE_DIR="$(mktemp -d)"
export OPENMAO_DB="$OPENMAO_EXAMPLE_DIR/openmao.sqlite3"
```

## Run to Approval

```bash
npm run cli -- worker demo
```

The result identifies the reference worker and run, with `status: suspended_approval`. The worker
has asked to call a deterministic mock capability; OpenMAO has recorded the request but has not
executed it.

Inspect the pending gate and the run-scoped world model:

```bash
npm run cli -- approvals list
npm run cli -- world --run run_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
```

At this point, `pending_approvals` contains the capability approval and `active_work` contains the
worker's work item. `external_workers` shows the enabled worker that owns the bounded task, while
`latest_run_status` shows that the run is suspended.

## Approve and Finish

```bash
npm run cli -- worker demo-approve
npm run cli -- world --run run_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
```

The second command rebuilds an inspectable snapshot from the durable organizational record. In the
completed snapshot:

- `latest_run_status` is `completed`.
- `active_work` and `pending_approvals` are empty because the work was reviewed and the gate was
  resolved.
- `external_workers` contains `worker_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`, the enabled worker that
  performed the task.
- `recent_ingestions` contains `ingest_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee`, the accepted outcome
  ingested back into OpenMAO.
- `recent_events` and the source sequence fields identify the event history used to build the
  snapshot.

The world model is a rebuildable projection, not a second source of authority. The worker runtime
can be replaced, while work ownership, policy decisions, approvals, outcomes, and the event record
remain in OpenMAO.
