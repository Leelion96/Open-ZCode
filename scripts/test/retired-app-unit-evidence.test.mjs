import assert from "node:assert/strict";
import test from "node:test";
import {
  inspectRetiredAppUnitEvidence,
  inspectCoverageMatrices,
} from "../lib/retired-app-unit-evidence.mjs";

const unit = "packages/ui/test/example.test.ts";
const e2e = "packages/desktop/test/e2e/conversation-session/example.test.ts";
const options = { engineeringTests: new Set(["packages/desktop/test/fixture.test.ts"]) };

test("retired evidence is rejected in prose, arbitrary aliases and extended case IDs", () => {
  for (const text of [
    `正文由 \`${unit}\` 覆盖`,
    `| \`LONG\` | \`${unit}\` |`,
    `| M06g | unit | \`${unit}\` | behavior |`,
  ])
    assert.ok(inspectRetiredAppUnitEvidence(text, options).length > 0, text);
});

test("retirement notes cannot keep a positive status backed only by retired evidence", () => {
  for (const status of ["unit", "covered", "partial", "covered-unit"]) {
    assert.ok(
      inspectRetiredAppUnitEvidence(
        `| M06g | ${status} | \`retired:${unit}\` | behavior |`,
        options,
      ).length > 0,
    );
    assert.ok(
      inspectRetiredAppUnitEvidence(
        `| \`LONG\` | \`retired:${unit}\` |\n| CASE-01 | ${status} | LONG | behavior |`,
        options,
      ).length > 0,
    );
  }
});

test("historical labels, planned E2E and retained CLI CUA browser engineering evidence remain valid", () => {
  const markdown = [
    `历史：\`retired:${unit}\`，2026-01-01 通过 3/3。`,
    `| M06g | unit-retired | \`retired:${unit}\` | 待补 E2E |`,
    `| M06o | partial | \`retired:${unit}\` + \`${e2e}\` | remaining E2E |`,
    `| \`LONG\` | \`${e2e}\`（planned） |`,
    "`apps/zcode-cli/packages/core/tests/read-tool-contract.test.ts`",
    "`packages/zcode-cua/test/example.test.ts`",
    "`packages/ui/test/browser/manual-review/pending/example.test.mjs`",
    "`packages/desktop/test/fixture.test.ts`",
  ].join("\n");
  assert.deepEqual(inspectRetiredAppUnitEvidence(markdown, options), []);
});

test("all current coverage matrices stop claiming retired App evidence", async () => {
  const errors = await inspectCoverageMatrices();
  assert.deepEqual(errors, []);
});

test("planned prose cannot stand in for retained evidence", () => {
  assert.ok(
    inspectRetiredAppUnitEvidence(
      `| CASE-01 | covered | \`retired:${unit}\` + E2E 待补 | behavior |`,
      options,
    ).length > 0,
  );
});

test("retirement cannot relabel protected CLI CUA browser E2E or engineering evidence", () => {
  for (const path of [
    e2e,
    "apps/zcode-cli/packages/core/tests/read-tool-contract.test.ts",
    "packages/zcode-cua/test/example.test.ts",
    "packages/ui/test/browser/example.test.mjs",
    "packages/desktop/test/fixture.test.ts",
  ]) {
    assert.ok(
      inspectRetiredAppUnitEvidence(
        `| CASE-01 | unit-retired | \`retired:${path}\` | behavior |`,
        options,
      ).length > 0,
      path,
    );
  }
});
