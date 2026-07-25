import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

type Finding = {
  file: string;
  rule: string;
  detail: string;
};

const trackedFiles = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .split("\n")
  .filter((file) => file && existsSync(file));

const forbiddenTrackedPaths = [
  /\.DS_Store$/,
  /^\.claude\//,
  // docs/adr/ is public per ADR-0006 (public-or-dead governance records, Option A);
  // ADRs publish there, starting with ADR-0013.
  /^docs\/research\//,
  /^docs\/(?:sessions|audit-trails|runbooks|audits|evidence)\//,
  /^internal\//,
  /^sessions\//,
  /^decisions\//,
  /^src\/openmao\//,
  /^tests\/test_.*\.py$/,
  /^(?:pyproject\.toml|uv\.lock)$/,
  /^SPEC\.md$/,
  /^(?:BUILD_PLAN|DECISIONS|STATUS|MODULE_OWNERSHIP|WORK_BREAKDOWN)\.md$/,
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

const forbiddenPublicReferences = [
  {
    name: "internal process docs path",
    pattern: /docs\/(?:sessions|audit-trails|runbooks|audits|evidence)\//i,
  },
  {
    name: "local audit workflow",
    pattern: /\.[c]laude\/|ship-with-audit/i,
  },
  // ADR references and docs/adr/ paths are public per ADR-0006 Option A. Not-yet-published
  // ADR numbers (0001-0012) may be referenced by name; docs/adr/README.md documents the
  // numbering gap as deliberate until the ADR-0006 hygiene pass restores them.
  {
    name: "private reference implementation history",
    pattern:
      /[P]ython reference\/prototype|[P]ydantic|[F]astAPI|canonical runtime patch|strategic architecture patch/i,
  },
];

const referenceScanExclusions = new Set([".gitignore", "scripts/check-public-hygiene.ts"]);
const findings: Finding[] = [];

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
