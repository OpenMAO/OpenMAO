import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { posix } from "node:path";

type Finding = {
  file: string;
  rule: string;
  detail: string;
};

const trackedFiles = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .split("\n")
  .filter((file) => file && existsSync(file));

// Files under docs/audits/ are private by default. The exception is a record explicitly produced
// for publication, which must carry the `-public-record.md` suffix and must have been redacted for
// third-party identity and private-channel evidence. See ADR-0006.
const PUBLIC_AUDIT_RECORD = /^docs\/audits\/[\w.-]+-public-record\.md$/;

const forbiddenTrackedPaths = [
  /\.DS_Store$/,
  /^\.claude\//,
  // docs/adr/ is public per ADR-0006 (public-or-dead governance records, Option A).
  /^docs\/research\//,
  /^docs\/(?:sessions|audit-trails|runbooks|evidence)\//,
  /^internal\//,
  /^sessions\//,
  /^decisions\//,
  /^src\/openmao\//,
  /^tests\/test_.*\.py$/,
  /^(?:pyproject\.toml|uv\.lock)$/,
  /^SPEC\.md$/,
  /^(?:BUILD_PLAN|MODULE_OWNERSHIP|WORK_BREAKDOWN)\.md$/,
];

const secretPatterns = [
  { name: "OpenAI-style API key", pattern: /sk-[A-Za-z0-9_-]{20,}/ },
  { name: "GitHub fine-grained token", pattern: /github_pat_[A-Za-z0-9_]+/ },
  { name: "GitHub classic token", pattern: /ghp_[A-Za-z0-9_]+/ },
  { name: "Slack token", pattern: /xox[baprs]-[A-Za-z0-9-]+/ },
  { name: "AWS access key", pattern: /AKIA[0-9A-Z]{16}/ },
  { name: "Google API key", pattern: /AIza[0-9A-Za-z_-]{35}/ },
  {
    name: "Private key block",
    pattern: /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/,
  },
];

// Raw-text markers that leak private material wherever they appear.
//
// Two rules were RETIRED on 2026-07-25 as image-based curation, which ADR-0006's ratification
// amendment 1 prohibits: a ban on the string "ADR-000X" and on `docs/adr/` (the ADR series is now
// public, and a rule forbidding public docs from citing decisions was the half-posture ADR-0006
// exists to end), and a ban on naming the Python reference implementation (that the project began in
// Python and moved to TypeScript is recorded in ADR-0014..ADR-0018 — unflattering is not private).
// What remains here is material that is private for privacy or operational reasons, not for image.
const forbiddenPublicReferences = [
  {
    name: "local agent workspace path",
    pattern: /\.[c]laude\//i,
  },
  {
    name: "private planning artifact",
    pattern: /canonical runtime patch|strategic architecture patch/i,
  },
];

// Link targets that point at material which stays private. Prose may name a private directory —
// describing the layout is not a leak — but a link invites a reader to open something they cannot
// see, which is either a dangling reference or a disclosure.
const forbiddenLinkTargets = [
  { name: "session records", pattern: /(^|\/)sessions\// },
  { name: "internal material", pattern: /(^|\/)internal\// },
  { name: "retired private ADR directory", pattern: /(^|\/)decisions\// },
  { name: "bounded research briefs", pattern: /(^|\/)docs\/research\// },
  {
    name: "private audit and evidence records",
    pattern: /(^|\/)docs\/(?:audit-trails|runbooks|evidence)\//,
  },
  { name: "local agent workspace", pattern: /(^|\/)\.claude\// },
];

const referenceScanExclusions = new Set([".gitignore", "scripts/check-public-hygiene.ts"]);
const findings: Finding[] = [];

const trackedSet = new Set(trackedFiles);
const trackedDirs = new Set<string>();
for (const file of trackedFiles) {
  let dir = posix.dirname(file);
  while (dir && dir !== "." && dir !== "/") {
    trackedDirs.add(dir);
    dir = posix.dirname(dir);
  }
}

for (const file of trackedFiles) {
  for (const pathPattern of forbiddenTrackedPaths) {
    if (pathPattern.test(file)) {
      findings.push({
        file,
        rule: "forbidden tracked path",
        detail: "Internal build/process artifacts must remain gitignored.",
      });
    }
  }

  if (file.startsWith("docs/audits/") && !PUBLIC_AUDIT_RECORD.test(file)) {
    findings.push({
      file,
      rule: "unredacted audit record",
      detail:
        "Audit records are private by default. Publish a redacted version named `<date>-<name>-public-record.md`; the internal record stays gitignored.",
    });
  }

  const content = readTextFile(file);
  if (content === null) {
    continue;
  }

  for (const { name, pattern } of secretPatterns) {
    if (pattern.test(content)) {
      findings.push({
        file,
        rule: `possible secret: ${name}`,
        detail: "Tracked files must not contain live secrets or credential material.",
      });
    }
  }

  if (!referenceScanExclusions.has(file)) {
    for (const { name, pattern } of forbiddenPublicReferences) {
      if (pattern.test(content)) {
        findings.push({
          file,
          rule: `forbidden public reference: ${name}`,
          detail: "Public docs/code must not reference internal build-process artifacts.",
        });
      }
    }

    if (file.endsWith(".md")) {
      checkMarkdownLinks(file, content);
    }
  }
}

if (findings.length > 0) {
  console.error("Public hygiene check failed:");
  for (const finding of findings) {
    console.error(`- ${finding.file}: ${finding.rule} (${finding.detail})`);
  }
  process.exit(1);
}

console.log(`Public hygiene check passed: ${trackedFiles.length} tracked files scanned.`);

// ADR-0006 asks for a decision index that is "tracked and link-valid". A link in a public document
// must resolve to something a stranger can actually open: a tracked file, or a directory holding
// one. Anything else is either a dangling reference (the failure the audit found in DECISIONS.md,
// which linked to ADRs that had been deleted) or a pointer at private material.
function checkMarkdownLinks(file: string, content: string): void {
  const dir = posix.dirname(file);
  for (const match of content.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const raw = match[1];
    if (raw === undefined || /^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(raw)) {
      continue;
    }
    const target = raw.split("#")[0];
    if (!target) {
      continue;
    }
    const resolved = posix.normalize(posix.join(dir, target)).replace(/\/$/, "");
    if (resolved.startsWith("..")) {
      findings.push({
        file,
        rule: "link escapes the repository",
        detail: `"${raw}" resolves outside the repo root.`,
      });
      continue;
    }

    for (const { name, pattern } of forbiddenLinkTargets) {
      if (pattern.test(`${resolved}/`)) {
        findings.push({
          file,
          rule: `link to private material: ${name}`,
          detail: `"${raw}" points at material that stays private. Name it in prose if it must be mentioned, but do not link it.`,
        });
      }
    }

    if (!trackedSet.has(resolved) && !trackedDirs.has(resolved)) {
      findings.push({
        file,
        rule: "dangling link",
        detail: `"${raw}" does not resolve to a tracked file. Public documents must not point readers at something they cannot open.`,
      });
    }
  }
}

function readTextFile(file: string): string | null {
  if (!existsSync(file)) {
    return null;
  }
  const buffer = readFileSync(file);
  if (buffer.includes(0)) {
    return null;
  }
  return buffer.toString("utf8");
}
