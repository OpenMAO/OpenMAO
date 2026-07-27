import { readFile } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WorkspaceSchema } from "../src/contracts/index.js";
import {
  Database,
  hashPrincipalToken,
  PrincipalStore,
  WorkspaceStore,
} from "../src/persistence/index.js";
import { PrincipalAuthError, PrincipalAuthService } from "../src/security/principal-auth.js";

const fixturePath = new URL("../../tests/fixtures/canonical_v0.json", import.meta.url);

let database: Database;
let workspaceId: string;
let principalId: string;

beforeEach(async () => {
  database = new Database(":memory:");
  database.initialize();
  const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as Record<string, unknown>;
  workspaceId = new WorkspaceStore(database).save(WorkspaceSchema.parse(fixture.workspace)).id;
  principalId = new PrincipalStore(database).create({
    id: "principal_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    workspace_id: workspaceId,
    kind: "human",
    display_name: "Ada Operator",
    created_at: "2026-07-26T12:00:00Z",
  }).id;
});

afterEach(() => {
  database.close();
});

describe("PrincipalAuthService", () => {
  it("mints a token shown ONCE in plaintext while persisting only its SHA-256", () => {
    const service = new PrincipalAuthService(database);
    const minted = service.mint({ workspace_id: workspaceId, principal_id: principalId });
    expect(minted.token).toMatch(/^prt_[0-9a-f]{64}$/);
    expect(minted.principal_id).toBe(principalId);

    // No stored column anywhere in the table may contain the plaintext token.
    const rows = database.connection.prepare("SELECT * FROM principal_credentials").all() as Array<
      Record<string, unknown>
    >;
    expect(rows).toHaveLength(1);
    for (const row of rows) {
      expect(Object.values(row).join("|")).not.toContain(minted.token);
    }
    expect(rows[0]?.token_hash).toBe(hashPrincipalToken(minted.token));
  });

  it("resolves a token to the principal FORCED from the stored credential row", () => {
    const service = new PrincipalAuthService(database);
    const minted = service.mint({ workspace_id: workspaceId, principal_id: principalId });
    const resolved = service.resolve(minted.token);
    expect(resolved).toEqual({ principal_id: principalId, workspace_id: workspaceId });
  });

  it("returns null for a missing or unknown token", () => {
    const service = new PrincipalAuthService(database);
    expect(service.resolve(null)).toBeNull();
    expect(service.resolve("prt_doesnotexist")).toBeNull();
  });

  it("refuses to mint for a principal absent from the workspace", () => {
    const service = new PrincipalAuthService(database);
    expect(() =>
      service.mint({
        workspace_id: workspaceId,
        principal_id: "principal_missingmissingmissingmissin",
      }),
    ).toThrow(PrincipalAuthError);
  });

  it("stops resolving a token once its credential is revoked", () => {
    const service = new PrincipalAuthService(database);
    const minted = service.mint({ workspace_id: workspaceId, principal_id: principalId });
    expect(service.resolve(minted.token)).not.toBeNull();
    service.revoke(minted.credential_id);
    expect(service.resolve(minted.token)).toBeNull();
  });

  it("keeps a principal's OTHER credentials working when one is revoked", () => {
    const service = new PrincipalAuthService(database);
    const first = service.mint({ workspace_id: workspaceId, principal_id: principalId });
    const second = service.mint({ workspace_id: workspaceId, principal_id: principalId });
    service.revoke(first.credential_id);
    expect(service.resolve(first.token)).toBeNull();
    expect(service.resolve(second.token)).toEqual({
      principal_id: principalId,
      workspace_id: workspaceId,
    });
  });

  it("stops resolving a DISABLED principal's existing token — resolve re-checks principal status", () => {
    const service = new PrincipalAuthService(database);
    const minted = service.mint({ workspace_id: workspaceId, principal_id: principalId });
    expect(service.resolve(minted.token)).not.toBeNull();

    new PrincipalStore(database).setStatus(principalId, "disabled");
    expect(service.resolve(minted.token)).toBeNull();

    // Re-enabling restores resolution: the check is on live standing, not a tombstone.
    new PrincipalStore(database).setStatus(principalId, "active");
    expect(service.resolve(minted.token)).not.toBeNull();
  });
});
