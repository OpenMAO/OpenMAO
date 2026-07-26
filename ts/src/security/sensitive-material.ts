export class SensitiveMaterialError extends Error {}

const SENSITIVE_KEY_PATTERN =
  /(?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|bearer|private[_-]?key|client[_-]?secret|credential[_-]?value)/i;
const SENSITIVE_VALUE_PATTERN =
  /(?:sk-[A-Za-z0-9_-]{8,}|github_pat_[A-Za-z0-9_]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|Bearer\s+\S+|-----BEGIN [^-]+PRIVATE KEY-----|(?:secret|token|password|api[_-]?key)[A-Za-z0-9_:-]{6,})/i;
// PKCS8 DER for an Ed25519 private key (RFC 8410) is 48 bytes: a fixed
// 16-byte prefix followed by the 32-byte seed, so base64/base64url encodings
// always begin with this string. Kept case-sensitive and separate from
// SENSITIVE_VALUE_PATTERN, whose /i flag would widen the byte pattern.
const PKCS8_ED25519_BASE64_PATTERN = /MC4CAQAwBQYDK2VwBCIEI[A-Za-z0-9_+/=-]{20,}/;
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
  if (SENSITIVE_VALUE_PATTERN.test(value) || PKCS8_ED25519_BASE64_PATTERN.test(value)) {
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
