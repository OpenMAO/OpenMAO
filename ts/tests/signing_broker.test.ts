import { verify as cryptoVerify, generateKeyPairSync, type KeyObject } from "node:crypto";

import { describe, expect, it } from "vitest";

import { SensitiveMaterialError } from "../src/security/sensitive-material.js";
import {
  EnvSigningBroker,
  isSigningBroker,
  SigningBrokerError,
  StaticSigningBroker,
} from "../src/security/signing-broker.js";

// Key material is generated at runtime; no live secret appears in this file
// (public-hygiene rule).

function testKey(): { material: string; publicKey: KeyObject } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const der = privateKey.export({ format: "der", type: "pkcs8" });
  return { material: Buffer.from(der).toString("base64url"), publicKey };
}

const BYTES = Buffer.from("the exact bytes being signed", "utf8");

function verifySignature(publicKey: KeyObject, signature: Buffer): boolean {
  return cryptoVerify(null, BYTES, publicKey, signature);
}

describe("signing broker", () => {
  describe("EnvSigningBroker", () => {
    it("signs with the key material behind signkey_<name> env vars (uppercased)", () => {
      const key = testKey();
      const broker = new EnvSigningBroker({
        OPENMAO_SIGNKEY_OPERATOR: key.material,
        OPENMAO_SIGNKEY_SERVICE: testKey().material,
      });
      const signature = broker.sign("signkey_operator", BYTES);
      expect(signature).toBeInstanceOf(Buffer);
      expect(signature).toHaveLength(64);
      expect(verifySignature(key.publicKey, signature as Buffer)).toBe(true);
    });

    it("returns null when the env var is absent, empty, or whitespace-only", () => {
      const broker = new EnvSigningBroker({
        OPENMAO_SIGNKEY_EMPTY: "",
        OPENMAO_SIGNKEY_BLANK: "   ",
      });
      expect(broker.sign("signkey_missing", BYTES)).toBeNull();
      expect(broker.sign("signkey_empty", BYTES)).toBeNull();
      expect(broker.sign("signkey_blank", BYTES)).toBeNull();
    });

    it("trims whitespace-padded material rather than forwarding it verbatim", () => {
      const key = testKey();
      const broker = new EnvSigningBroker({ OPENMAO_SIGNKEY_PADDED: `  ${key.material}  ` });
      const signature = broker.sign("signkey_padded", BYTES);
      expect(signature).not.toBeNull();
      expect(verifySignature(key.publicKey, signature as Buffer)).toBe(true);
    });

    it("rejects handle names that cannot map unambiguously to an env var", () => {
      const broker = new EnvSigningBroker({ OPENMAO_SIGNKEY_FOO_BAR: "x" });
      // `.`, `-`, `:`, and uppercase would all collapse onto
      // OPENMAO_SIGNKEY_FOO_BAR, so the env broker refuses them rather than
      // sign with the wrong key.
      expect(() => broker.sign("signkey_foo.bar", BYTES)).toThrow();
      expect(() => broker.sign("signkey_foo-bar", BYTES)).toThrow();
      expect(() => broker.sign("signkey_FooBar", BYTES)).toThrow();
    });

    it("rejects a handle that is not a signkey_* identifier", () => {
      const broker = new EnvSigningBroker({});
      expect(() => broker.sign("not-a-handle", BYTES)).toThrow();
    });

    it("supports a custom env prefix", () => {
      const key = testKey();
      const broker = new EnvSigningBroker(
        { KLARVO_SIGNKEY_OPERATOR: key.material },
        "KLARVO_SIGNKEY_",
      );
      expect(broker.sign("signkey_operator", BYTES)).not.toBeNull();
    });

    it("refuses invalid material without embedding it in the error", () => {
      const invalidMaterial = "this-is-not-a-key";
      const broker = new EnvSigningBroker({ OPENMAO_SIGNKEY_BROKEN: invalidMaterial });
      let thrown: unknown;
      try {
        broker.sign("signkey_broken", BYTES);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(SigningBrokerError);
      expect((thrown as Error).message).not.toContain(invalidMaterial);
      expect((thrown as Error).message).toContain("signkey_broken");
    });
  });

  describe("StaticSigningBroker", () => {
    it("signs from an explicit map and returns null for misses, empties, and blanks", () => {
      const key = testKey();
      const broker = new StaticSigningBroker({
        signkey_test: key.material,
        signkey_empty: "",
        signkey_blank: "   ",
      });
      const signature = broker.sign("signkey_test", BYTES);
      expect(signature).not.toBeNull();
      expect(verifySignature(key.publicKey, signature as Buffer)).toBe(true);
      expect(broker.sign("signkey_absent", BYTES)).toBeNull();
      expect(broker.sign("signkey_empty", BYTES)).toBeNull();
      expect(broker.sign("signkey_blank", BYTES)).toBeNull();
    });

    it("applies the same handle validation as EnvSigningBroker", () => {
      // A handle the env broker refuses (here: no `signkey_` prefix) must not
      // sign statically — config must not pass statically and fail in the
      // environment implementation.
      const key = testKey();
      const staticBroker = new StaticSigningBroker({
        "signkey.test": key.material,
        signkey_test: key.material,
      });
      const envBroker = new EnvSigningBroker({ OPENMAO_SIGNKEY_TEST: key.material });
      for (const broker of [staticBroker, envBroker]) {
        expect(() => broker.sign("signkey.test", BYTES)).toThrow(SensitiveMaterialError);
        expect(() => broker.sign("not-a-handle", BYTES)).toThrow(SensitiveMaterialError);
      }
    });
  });

  describe("algorithm pinning at import", () => {
    it("refuses RSA and Ed448 key material instead of signing with it", () => {
      // crypto.sign(null, …) would accept either and produce a non-Ed25519
      // signature; the brokers refuse at import.
      const rsaDer = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
        format: "der",
        type: "pkcs8",
      });
      const ed448Der = generateKeyPairSync("ed448").privateKey.export({
        format: "der",
        type: "pkcs8",
      });
      for (const der of [rsaDer, ed448Der]) {
        const material = Buffer.from(der).toString("base64url");
        const envBroker = new EnvSigningBroker({ OPENMAO_SIGNKEY_FOREIGN: material });
        const staticBroker = new StaticSigningBroker({ signkey_foreign: material });
        expect(() => envBroker.sign("signkey_foreign", BYTES)).toThrow(SigningBrokerError);
        expect(() => staticBroker.sign("signkey_foreign", BYTES)).toThrow(SigningBrokerError);
      }
    });
  });

  it("isSigningBroker distinguishes brokers from plain maps", () => {
    expect(isSigningBroker(new StaticSigningBroker())).toBe(true);
    expect(isSigningBroker(new EnvSigningBroker({}))).toBe(true);
    expect(isSigningBroker({ signkey_x: "y" })).toBe(false);
    expect(isSigningBroker(null)).toBe(false);
  });

  it("exposes no way to read out key material", () => {
    // The custody boundary is the module's entire purpose: callers receive
    // signatures only. The key stores are ECMAScript-private fields, so a
    // cast cannot defeat them — verify that directly, not just the interface
    // shape.
    const key = testKey();
    for (const broker of [
      new EnvSigningBroker({ OPENMAO_SIGNKEY_X: key.material }),
      new StaticSigningBroker({ signkey_x: key.material }),
    ]) {
      // No getter or resolve escape hatch on the prototype.
      expect(Object.getOwnPropertyNames(Object.getPrototypeOf(broker)).sort()).toEqual([
        "constructor",
        "sign",
      ]);
      // No own enumerable or non-enumerable properties at all.
      expect(Object.keys(broker)).toEqual([]);
      expect(Object.getOwnPropertyNames(broker)).toEqual([]);
      // Serialization carries nothing.
      const serialized = JSON.stringify(broker);
      expect(serialized).toBe("{}");
      expect(serialized).not.toContain(key.material);
      // A cast reaches neither the stores nor any alias of them.
      const cast = broker as unknown as Record<string, unknown>;
      expect(cast.env).toBeUndefined();
      expect(cast.handles).toBeUndefined();
      expect(cast.prefix).toBeUndefined();
      for (const value of Object.values(cast)) {
        expect(typeof value === "string" && value.includes(key.material)).toBe(false);
      }
    }
  });
});
