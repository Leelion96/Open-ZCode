import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const INTEGRATION_URL = new URL(
  "../lib/conversation-session-formal-admission-audit.mjs",
  import.meta.url,
);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const AUDIT_PATH = join(REPO_ROOT, "scripts/audit-conversation-session-case-coverage.mjs");

test("projects formal rejection into audit errors, JSON, text, and nonzero check", async () => {
  let module;
  try {
    module = await import(INTEGRATION_URL.href);
  } catch (error) {
    assert.fail(`formal admission audit integration is unavailable: ${error.message}`);
  }
  const formalAdmission = {
    counts: {
      formalAdmitted: 0,
      formalRejected: 1,
      legacyHarness: 0,
      legacyHarnessFormal: 0,
      legacyHarnessPending: 0,
      missingFixture: 1,
      missingManifest: 0,
      pending: 0,
      pendingFixtureRejected: 0,
    },
    formal: {
      admitted: [],
      rejected: [
        {
          caseName: "rejected-case",
          legacyHarness: [],
          reasons: [
            {
              code: "MISSING_CASE_FIXTURE",
              message: "case-local provider fixture is missing",
              specPath: "packages/desktop/test/e2e/conversation-session/rejected-case.test.ts",
              subjectPath:
                "packages/desktop/test/e2e/fixtures/upstream/conversation-session/rejected-case.json",
            },
          ],
          specPath: "packages/desktop/test/e2e/conversation-session/rejected-case.test.ts",
        },
      ],
    },
    pending: [],
  };

  const integration = module.buildFormalAdmissionAuditIntegration(formalAdmission);

  assert.equal(integration.json, formalAdmission);
  assert.match(integration.text.join("\n"), /formal admission: 0 admitted, 1 rejected/);
  assert.deepEqual(integration.errors, [
    "formal admission rejected packages/desktop/test/e2e/conversation-session/rejected-case.test.ts: MISSING_CASE_FIXTURE: case-local provider fixture is missing (packages/desktop/test/e2e/fixtures/upstream/conversation-session/rejected-case.json)",
  ]);
  assert.equal(module.getCoverageAuditExitCode(true, integration.errors), 1);
  assert.equal(module.getCoverageAuditExitCode(false, integration.errors), 0);
});

test("projects pending fixture metadata rejection into audit errors", async () => {
  const module = await import(INTEGRATION_URL.href);
  const formalAdmission = {
    counts: {
      formalAdmitted: 0,
      formalRejected: 0,
      legacyHarness: 0,
      legacyHarnessFormal: 0,
      legacyHarnessPending: 0,
      missingFixture: 0,
      missingManifest: 0,
      pending: 1,
      pendingFixtureRejected: 1,
    },
    formal: { admitted: [], rejected: [] },
    pending: [
      {
        reasons: [
          {
            code: "PENDING_FIXTURE_FORMAL_TARGET_MISMATCH",
            message: "case manifest spec must resolve to the canonical formal target",
            subjectPath:
              "packages/desktop/test/e2e/fixtures/cases/conversation-session/pending.json",
          },
        ],
        specPath:
          "packages/desktop/test/e2e/conversation-session/manual-review/pending/pending.test.ts",
      },
    ],
  };

  const integration = module.buildFormalAdmissionAuditIntegration(formalAdmission);

  assert.match(integration.text.join("\n"), /pending fixture metadata: 1 rejected/);
  assert.deepEqual(integration.errors, [
    "pending fixture metadata rejected packages/desktop/test/e2e/conversation-session/manual-review/pending/pending.test.ts: PENDING_FIXTURE_FORMAL_TARGET_MISMATCH: case manifest spec must resolve to the canonical formal target (packages/desktop/test/e2e/fixtures/cases/conversation-session/pending.json)",
  ]);
});

test("actual audit CLI reports overridden formal rejection in JSON and text", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-formal-cli-"));
  const specPath = join(
    root,
    "packages/desktop/test/e2e/conversation-session/cli-rejected.test.ts",
  );
  await mkdir(dirname(specPath), { recursive: true });
  await writeFile(specPath, "it('has no fixture contract', async () => {});\n", "utf8");
  const env = {
    ...process.env,
    ZCODE_CONVERSATION_SESSION_FORMAL_ADMISSION_ROOT: root,
  };

  try {
    const jsonRun = await runAudit(["--check", "--json"], env);
    assert.equal(jsonRun.exitCode, 1);
    const json = JSON.parse(jsonRun.stdout);
    assert.equal(json.formalAdmission.counts.formalRejected, 1);
    assert.match(jsonRun.stderr, /cli-rejected\.test\.ts/);
    assert.match(jsonRun.stderr, /MISSING_CASE_MANIFEST/);

    const textRun = await runAudit(["--check"], env);
    assert.equal(textRun.exitCode, 1);
    assert.match(textRun.stdout, /formal admission: 0 admitted, 1 rejected/);
    assert.match(textRun.stderr, /MISSING_CASE_FIXTURE/);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("ordinary audit CLI rejects the formal root override as test-only", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-formal-cli-untrusted-"));
  const env = {
    ...process.env,
    NODE_ENV: "test",
    ZCODE_CONVERSATION_SESSION_FORMAL_ADMISSION_ROOT: root,
  };
  delete env.NODE_TEST_CONTEXT;

  try {
    const run = await runAudit(["--check"], env);
    assert.notEqual(run.exitCode, 0);
    assert.match(run.stderr, /ZCODE_CONVERSATION_SESSION_FORMAL_ADMISSION_ROOT is test-only/);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("current coverage audit stays consistent after App unit evidence retirement", async () => {
  const env = { ...process.env };
  delete env.ZCODE_CONVERSATION_SESSION_FORMAL_ADMISSION_ROOT;
  const run = await runAudit(["--check", "--json"], env);
  assert.equal(run.exitCode, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.deepEqual(report.errors, []);

  const matrix = await readFile(
    join(REPO_ROOT, "docs/testing/conversation-session-e2e-coverage-matrix.md"),
    "utf8",
  );
  // 修复原因：顶部退役说明不影响机器索引；按主路径审计的两字母缩写检查路径，避免已删业务单测仍被计数。
  const indexedSpecs = [...matrix.matchAll(/^\|\s*`[A-Z]{2}`\s*\|([^|]+)\|/gm)]
    .flatMap((row) => [
      ...row[1].matchAll(/`((?:packages|apps)\/[^`]+\.(?:test|spec)\.[cm]?[jt]sx?)`/g),
    ])
    .map((match) => match[1]);
  assert.ok(indexedSpecs.length > 0);
  for (const spec of indexedSpecs) {
    assert.ok(
      spec.startsWith("packages/desktop/test/e2e/") || spec.startsWith("apps/zcode-cli/"),
      `retired App unit evidence remains in the automation index: ${spec}`,
    );
    await readFile(join(REPO_ROOT, spec));
  }
});

test("VI03 keeps its retained CLI unit evidence with unambiguous full paths", async () => {
  const matrix = await readFile(
    join(REPO_ROOT, "docs/testing/conversation-session-e2e-coverage-matrix.md"),
    "utf8",
  );
  const row = matrix.split("\n").find((line) => /^\|\s*VI03\s*\|/.test(line));
  assert.ok(row, "VI03 is missing from the coverage matrix");
  assert.equal(row.split("|")[2].trim(), "covered-unit");
  for (const spec of [
    "apps/zcode-cli/packages/core/tests/read-tool-contract.test.ts",
    "apps/zcode-cli/packages/adapters/tests/fs-context.test.ts",
  ]) {
    assert.ok(row.includes(`\`${spec}\``), `VI03 must identify its CLI evidence: ${spec}`);
    await readFile(join(REPO_ROOT, spec));
  }
});

function runAudit(args, env) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [AUDIT_PATH, ...args], {
      cwd: REPO_ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolveRun({ exitCode, stderr, stdout });
    });
  });
}
