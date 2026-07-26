export class SensitiveMaterialError extends Error {}

const SENSITIVE_KEY_PATTERN =
  /(?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|bearer|private[_-]?key|client[_-]?secret|credential[_-]?value)/i;
const SENSITIVE_VALUE_PATTERN =
  /(?:sk-[A-Za-z0-9_-]{8,}|github_pat_[A-Za-z0-9_]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|Bearer\s+\S+|-----BEGIN [^-]+PRIVATE KEY-----|(?:secret|token|password|api[_-]?key)[A-Za-z0-9_:-]{6,})/i;
// PKCS8 DER for an Ed25519 private key (RFC 8410) is a SEQUENCE wrapping a
// fixed template — INTEGER 0, the 1.3.101.112 OID, and the nested OCTET
// STRING header — but the outer SEQUENCE length varies with the optional
// attributes field: 48 bytes without attributes (base64 prefix MC4CAQ…), 50
// with an empty [0] (prefix MDACAQ…), longer with real attributes. No single
// base64 prefix covers the valid encodings, so candidate base64/base64url
// runs are decoded and the template matched on bytes instead.
//
// The run pattern is deliberately boundary-anchored: a run must begin at a
// character outside the base64 alphabet (or at string start), so a run
// starting mid-way through a longer payload is never examined on its own.
const BASE64_RUN_PATTERN = /(?:^|[^A-Za-z0-9_+/=-])([A-Za-z0-9_+/=-]{40,})/g;
const PKCS8_ED25519_TEMPLATE = Buffer.from("020100300506032b657004220420", "hex");

function isPkcs8Ed25519Der(bytes: Buffer): boolean {
  if (bytes.length < 48 || bytes[0] !== 0x30) {
    return false;
  }
  // Definite length: short form, or long form with a one- or two-byte length.
  const lengthByte = bytes[1];
  let offset: number;
  if (lengthByte === undefined) {
    return false;
  } else if (lengthByte < 0x80) {
    offset = 2;
  } else if (lengthByte === 0x81) {
    offset = 3;
  } else if (lengthByte === 0x82) {
    offset = 4;
  } else {
    return false;
  }
  return bytes
    .subarray(offset, offset + PKCS8_ED25519_TEMPLATE.length)
    .equals(PKCS8_ED25519_TEMPLATE);
}

// 72 base64 chars decode to 54 bytes — more than the DER template check ever reads.
const PKCS8_WINDOW_CHARS = 72;

function containsPkcs8Ed25519(value: string): boolean {
  for (const match of value.matchAll(BASE64_RUN_PATTERN)) {
    // Normalise the URL-safe alphabet so both base64 and base64url decode.
    const raw = match[1];
    if (raw === undefined) {
      continue;
    }
    const run = raw.replaceAll("-", "+").replaceAll("_", "/");
    // Adjacent base64-alphabet text (a "value=" prefix, a "signkey_" label,
    // surrounding prose characters) joins the same run and shifts the decode
    // phase, which would silently move the DER template off byte 0. The key
    // can begin at any character offset of the run, so every plausible window
    // is decoded. The byte-0 SEQUENCE check rejects almost all windows before
    // the template compare, keeping the scan cheap; and because the key bytes
    // themselves never shift, innocent payloads stay clean.
    // Each window is capped rather than decoding the whole remaining run: the DER
    // check never reads past the template, so 72 characters (54 bytes) is always
    // enough to decide. Without the cap the scan is quadratic in run length, and
    // this runs on ingestion payloads — a large base64-ish body would burn CPU.
    for (let start = 0; start + 40 <= run.length; start += 1) {
      const window = run.slice(start, start + PKCS8_WINDOW_CHARS);
      const decoded = Buffer.from(window.slice(0, window.length - (window.length % 4)), "base64");
      if (isPkcs8Ed25519Der(decoded)) {
        return true;
      }
    }
  }
  return false;
}
const CREDENTIAL_HANDLE_PATTERN = /^cred_[A-Za-z0-9_.:-]+$/;

export function validateCredentialHandle(handle: string): void {
  if (!CREDENTIAL_HANDLE_PATTERN.test(handle)) {
    throw new SensitiveMaterialError("credential handle must be a non-secret cred_* identifier");
  }
  assertNoSensitiveString(handle, "credential_handle");
}

export function assertNoSensitiveMaterial(value: unknown, path: string): void {
  if (value === null || value === undefined) {
    return;
  }
  if (typeof value === "string") {
    assertNoSensitiveString(value, path);
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      assertNoSensitiveMaterial(item, `${path}[${index}]`);
    }
    return;
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        throw new SensitiveMaterialError(`${path} contains sensitive key: ${key}`);
      }
      assertNoSensitiveMaterial(item, `${path}.${key}`);
    }
  }
}

export function assertNoSensitiveString(value: string, path: string): void {
  if (SENSITIVE_VALUE_PATTERN.test(value) || containsPkcs8Ed25519(value)) {
    throw new SensitiveMaterialError(`${path} contains secret-shaped material`);
  }
}

export function safeErrorMessage(message: string): string {
  try {
    assertNoSensitiveString(message, "error");
    return message;
  } catch (error) {
    if (error instanceof SensitiveMaterialError) {
      return "provider error contained sensitive material";
    }
    throw error;
  }
}
