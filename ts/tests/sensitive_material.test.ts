import { createPrivateKey, generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  assertNoSensitiveString,
  SensitiveMaterialError,
  validateCredentialHandle,
} from "../src/security/sensitive-material.js";

// Token-shaped strings are assembled at runtime so this source file contains no
// literal secret pattern and stays clean for the public hygiene scan.
const fineGrainedPat = ["github", "pat", "1".repeat(24)].join("_");
const classicPat = `ghp_${"a".repeat(24)}`;

describe("sensitive material guard", () => {
  it("flags GitHub fine-grained and classic tokens", () => {
    expect(() => assertNoSensitiveString(fineGrainedPat, "body")).toThrow(SensitiveMaterialError);
    expect(() => assertNoSensitiveString(classicPat, "body")).toThrow(SensitiveMaterialError);
  });

  it("allows ordinary text", () => {
    expect(() => assertNoSensitiveString("a normal issue comment", "body")).not.toThrow();
  });

  it("flags base64 and base64url PKCS8-encoded Ed25519 key material", () => {
    // Generated at runtime so this file contains no literal key material.
    const { privateKey } = generateKeyPairSync("ed25519");
    const der = privateKey.export({ format: "der", type: "pkcs8" });
    expect(() => assertNoSensitiveString(Buffer.from(der).toString("base64"), "env")).toThrow(
      SensitiveMaterialError,
    );
    expect(() => assertNoSensitiveString(Buffer.from(der).toString("base64url"), "env")).toThrow(
      SensitiveMaterialError,
    );
  });

  it("flags PKCS8 Ed25519 material carrying an attributes field", () => {
    // PKCS8 permits optional attributes; with an empty [0] the same key is 50
    // bytes and begins MDACAQ…, not MC4CAQ…, so a fixed-prefix scrubber misses
    // it. Built from a runtime-generated seed: no literal key material here.
    const { privateKey } = generateKeyPairSync("ed25519");
    const plain = Buffer.from(privateKey.export({ format: "der", type: "pkcs8" }));
    const seed = plain.subarray(16, 48);
    const withAttributes = Buffer.concat([
      Buffer.from("3030020100300506032b657004220420", "hex"),
      seed,
      Buffer.from("a000", "hex"),
    ]);
    // The encoding is genuinely valid: node imports it as an Ed25519 key.
    expect(
      createPrivateKey({ key: withAttributes, format: "der", type: "pkcs8" }).asymmetricKeyType,
    ).toBe("ed25519");
    expect(withAttributes.toString("base64").startsWith("MDACAQ")).toBe(true);
    expect(() => assertNoSensitiveString(withAttributes.toString("base64"), "env")).toThrow(
      SensitiveMaterialError,
    );
    expect(() => assertNoSensitiveString(withAttributes.toString("base64url"), "env")).toThrow(
      SensitiveMaterialError,
    );
  });

  it("flags PKCS8 material embedded in adjacent base64-alphabet text", () => {
    // A maximal-run detector anchored at decoded offset 0 is defeated by any
    // alphabet character before the key: the run grows, the decode phase
    // shifts, and the key silently passes. These are the shapes key material
    // actually takes in log lines and handle assignments, so they must all be
    // scrubbed.
    const { privateKey } = generateKeyPairSync("ed25519");
    const b64 = Buffer.from(privateKey.export({ format: "der", type: "pkcs8" })).toString("base64");
    for (const wrapped of [
      `prefix${b64}`,
      `value=${b64}`,
      `signkey_${b64}`,
      `embedded${b64}tailtext`,
    ]) {
      expect(() => assertNoSensitiveString(wrapped, "env")).toThrow(SensitiveMaterialError);
    }
  });

  it("flags base64url PKCS8 material embedded in adjacent text", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const b64url = Buffer.from(privateKey.export({ format: "der", type: "pkcs8" })).toString(
      "base64url",
    );
    for (const wrapped of [`prefix${b64url}`, `signkey_${b64url}`, `abc${b64url}xyz`]) {
      expect(() => assertNoSensitiveString(wrapped, "env")).toThrow(SensitiveMaterialError);
    }
  });

  it("flags long-form 0x81 and 0x82 SEQUENCE length encodings", () => {
    // The scrubber accepts long-form SEQUENCE lengths because they are legal
    // BER for the same key; re-encoding a runtime key with 0x81/0x82 headers
    // produces material node still imports as Ed25519, and it must be caught
    // both bare and behind adjacent alphabet text.
    const { privateKey } = generateKeyPairSync("ed25519");
    const der = Buffer.from(privateKey.export({ format: "der", type: "pkcs8" }));
    const body = der.subarray(2); // skip the original 30 2e short-form header
    const long81 = Buffer.concat([Buffer.from([0x30, 0x81, body.length]), body]);
    const long82 = Buffer.concat([
      Buffer.from([0x30, 0x82, body.length >> 8, body.length & 0xff]),
      body,
    ]);
    for (const candidate of [long81, long82]) {
      expect(
        createPrivateKey({ key: candidate, format: "der", type: "pkcs8" }).asymmetricKeyType,
      ).toBe("ed25519");
      expect(() => assertNoSensitiveString(candidate.toString("base64"), "env")).toThrow(
        SensitiveMaterialError,
      );
      expect(() => assertNoSensitiveString(`prefix${candidate.toString("base64")}`, "env")).toThrow(
        SensitiveMaterialError,
      );
    }
    // base64url coverage on the 0x82 form exercises both branches at once.
    expect(() => assertNoSensitiveString(long82.toString("base64url"), "env")).toThrow(
      SensitiveMaterialError,
    );
  });

  it("does not flag ordinary prose or innocent base64 payloads", () => {
    expect(() =>
      assertNoSensitiveString("a normal issue comment about 48 bytes of config", "body"),
    ).not.toThrow();
    const innocentBase64 = Buffer.from(
      "an ordinary payload that happens to encode to a long base64 string!",
    ).toString("base64");
    expect(innocentBase64.length).toBeGreaterThanOrEqual(40);
    expect(() => assertNoSensitiveString(innocentBase64, "body")).not.toThrow();
    const innocentBase64Url = Buffer.from(
      "another ordinary payload, base64url this time, still nothing secret-shaped",
    ).toString("base64url");
    expect(() => assertNoSensitiveString(innocentBase64Url, "body")).not.toThrow();
  });

  it("rejects a credential handle that embeds a token, accepts a plain handle", () => {
    expect(() => validateCredentialHandle(`cred_${fineGrainedPat}`)).toThrow(
      SensitiveMaterialError,
    );
    expect(() => validateCredentialHandle("cred_github")).not.toThrow();
  });
});
