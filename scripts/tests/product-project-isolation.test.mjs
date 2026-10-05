import {
  tmpdir,
  assert,
  test,
  mkdir,
  readFile,
  rm,
  writeFile,
  dirname,
  join,
  randomUUID,
  fixtures,
  moduleFrom,
} from "./helpers/product-test.mjs";

test("user and project roots remain separate and generic .agents stays available", async () => {
  const home = join(fixtures, "roots-home");
  const projectDir = join(fixtures, "project");
  await mkdir(join(projectDir, ".git"), { recursive: true });
  const roots = await moduleFrom(
    "apps/zcode-cli/packages/adapters/src/skills/roots.ts",
    "skill-roots",
  );
  const result = await roots.resolveDefaultSkillRoots(projectDir, { homeDirectory: home });
  assert.ok(
    result.some((item) => item.path === join(home, ".open-zcode/skills") && item.scope === "user"),
  );
  assert.ok(
    result.some(
      (item) => item.path === join(projectDir, ".open-zcode/skills") && item.scope === "project",
    ),
  );
  assert.ok(result.some((item) => item.path === join(projectDir, ".agents/skills")));
  assert.ok(result.every((item) => !item.path.includes("/.zcode/")));
  const paths = await moduleFrom("packages/services/src/paths.ts", "paths");
  paths.setDataBaseDir(home);
  assert.equal(paths.getAppConfigDir(), join(home, ".open-zcode/v2"));
  assert.equal(paths.getTasksIndexDatabasePath(), join(home, ".open-zcode/v2/tasks-index.sqlite"));
});

test("Hook discovery selects custom project files and preserves explicit old config", async () => {
  const projectDir = join(fixtures, "hooks");
  await mkdir(join(projectDir, ".open-zcode"), { recursive: true });
  await mkdir(join(projectDir, ".zcode"), { recursive: true });
  const official = join(projectDir, ".zcode/config.json");
  await writeFile(official, "{}");
  await writeFile(join(projectDir, "open-zcode.json"), "{}");
  await writeFile(join(projectDir, ".open-zcode/config.json"), "{}");
  const hooks = await moduleFrom("packages/shared/src/workspace-hook-config.ts", "hooks");
  const result = hooks.discoverWorkspaceHookConfigPaths({ workingDirectory: projectDir });
  assert.deepEqual(
    result.map((item) => item.path),
    [join(projectDir, "open-zcode.json"), join(projectDir, ".open-zcode/config.json")],
  );
  const explicit = hooks.discoverWorkspaceHookConfigPaths({
    workingDirectory: projectDir,
    explicitProjectConfigPath: official,
  });
  assert.equal(explicit.at(-1).path, official);
  const source = hooks.createWorkspaceHookSourceInput({
    path: official,
    workingDirectory: projectDir,
    discoveryOrder: 0,
    hooks: {},
    explicitProjectConfig: true,
  });
  assert.equal(source.baseDir, projectDir);
  assert.equal(await readFile(official, "utf8"), "{}");
});

test("ignore rule writes use new filename and leave official rules intact", async () => {
  const projectDir = join(fixtures, "ignore");
  await mkdir(projectDir, { recursive: true });
  await writeFile(join(projectDir, ".zcodeignore"), "official-secret/\n");
  const rules = await moduleFrom("packages/services/src/file/workspaceFileIgnore.ts", "ignore");
  await rules.writeWorkspaceFileSearchIgnore(projectDir, "private-output/\n");
  assert.equal(
    (await rules.readWorkspaceFileSearchIgnore(projectDir)).content,
    "private-output/\n",
  );
  const loaded = await rules.loadWorkspaceFileSearchIgnoreRules(projectDir);
  assert.equal(loaded.matcher.ignores("private-output/example.txt"), true);
  assert.equal(loaded.matcher.ignores("official-secret/example.txt"), false);
  assert.equal(await readFile(join(projectDir, ".zcodeignore"), "utf8"), "official-secret/\n");
});

test("new ignore descriptions preserve custom sections from the historical marker", async () => {
  const projectDir = join(fixtures, "ignore-legacy-marker");
  await mkdir(projectDir, { recursive: true });
  const rules = await moduleFrom(
    "packages/services/src/file/workspaceFileIgnore.ts",
    "ignore-marker",
  );
  const sync = "# ===== ↑ 以上同步自 .gitignore（「从 .gitignore 同步」只重写以上部分）=====";
  const legacy =
    "# ----- ↑ 以上为 ZCode 默认排除规则（自定义规则请写在本行下方，不会被同步/恢复改动）-----";
  await rules.writeWorkspaceFileSearchIgnore(
    projectDir,
    `old-generated/\n${sync}\nnode_modules/\n${legacy}\nmy-private-output/\n`,
  );
  await writeFile(join(projectDir, ".gitignore"), "new-generated/\n");
  const synced = await rules.transformWorkspaceFileSearchIgnore(projectDir, "sync-gitignore");
  assert.ok(synced.content.includes("my-private-output/"));
  assert.ok(synced.content.includes("new-generated/"));
  assert.ok(!synced.content.includes(legacy));
  assert.ok(synced.content.includes("Open-ZCode 默认排除规则"));
  await rules.writeWorkspaceFileSearchIgnore(projectDir, synced.content);
  const reset = await rules.transformWorkspaceFileSearchIgnore(projectDir, "reset-defaults");
  assert.ok(reset.content.includes("my-private-output/"));
  assert.ok(reset.content.includes("new-generated/"));
});

test("default project creation and its desktop hint use the same configured directory", async () => {
  const home = join(fixtures, "default-project-home");
  const service = await moduleFrom(
    "packages/services/src/setting/settingService.ts",
    "default-project",
  );
  const hint = await moduleFrom(
    "packages/ui/src/ChatEmptyScratchWorkspaceDialog.tsx",
    "project-hint",
  );
  const project = await service.createSettingService().ensureDefaultProject(home);
  assert.equal(project.path, join(home, "Open-ZCodeProject"));
  assert.equal(hint.getScratchWorkspaceLocationHint("example"), "~/Open-ZCodeProject/example");
  assert.equal((await service.createSettingService().ensureDefaultProject(home)).created, false);
});

test("workflow runtime writes and fallback paths are product-owned", async () => {
  const runtime = await moduleFrom(
    "apps/zcode-cli/packages/dynamic-workflow-runtime/src/child-entry-file.ts",
    "workflow-entry",
  );
  assert.equal(runtime.workflowRunsDir("/project"), "/project/.open-zcode/workflow-runs");
  assert.equal(runtime.fallbackWorkflowRunsDir(), join(tmpdir(), "open-zcode-workflow-runs"));
  const vocabulary = await moduleFrom(
    "apps/zcode-cli/packages/contracts/src/tools/saved-workflow.ts",
    "workflow-paths",
  );
  assert.equal(vocabulary.SAVED_WORKFLOW_PROJECT_DIR, ".open-zcode/workflows");
  assert.equal(vocabulary.SAVED_WORKFLOW_GLOBAL_DIR, ".open-zcode/workflows");
  const policy = await moduleFrom(
    "apps/zcode-cli/packages/core/src/permission/workflow-draft-path.ts",
    "workflow-policy",
  );
  assert.equal(
    policy.isPreapprovedWorkflowDraftWrite({
      toolName: "Write",
      input: { file_path: "/project/.open-zcode/workflow-drafts/a.ts" },
      workingDirectory: "/project",
      workspaceRoot: "/project",
    }),
    true,
  );
  assert.equal(
    policy.isPreapprovedWorkflowDraftWrite({
      toolName: "Write",
      input: { file_path: "/project/.open-zcode/workflow-drafts-other/a.ts" },
      workingDirectory: "/project",
      workspaceRoot: "/project",
    }),
    false,
  );
});

test("saved workflow write/list and readonly-project fallback use new roots", async () => {
  const cwd = join(fixtures, "workflow-project");
  const homeDir = join(fixtures, "workflow-home");
  await mkdir(join(cwd, ".zcode/workflows"), { recursive: true });
  const sentinel = join(cwd, ".zcode/workflows/sentinel");
  await writeFile(sentinel, "official");
  const store = await moduleFrom(
    "apps/zcode-cli/packages/core/src/tool/handlers/saved-workflows/store.ts",
    "workflow-store",
  );
  const saved = store.saveSavedWorkflow({
    cwd,
    homeDir,
    name: "sample",
    meta: { description: "Acceptance fixture" },
    script: "return 1;",
    scope: "project",
  });
  assert.equal(saved.path, join(cwd, ".open-zcode/workflows/sample.dwf.ts"));
  assert.equal(store.listSavedWorkflows({ cwd, homeDir }).entries[0].name, "sample");
  assert.equal(await readFile(sentinel, "utf8"), "official");
  const runtime = await moduleFrom(
    "apps/zcode-cli/packages/dynamic-workflow-runtime/src/child-entry-file.ts",
    "workflow-write",
  );
  const blocked = join(fixtures, "blocked-project");
  await mkdir(blocked);
  await writeFile(join(blocked, ".open-zcode"), "file-blocks-directory");
  const warnings = [];
  const written = runtime.writeChildEntryFile({
    cwd: blocked,
    runId: `acceptance-${randomUUID()}`,
    source: "export {};",
    onWarning: (warning) => warnings.push(warning),
  });
  try {
    assert.equal(written.location, "tmpdir");
    assert.equal(dirname(written.path), join(tmpdir(), "open-zcode-workflow-runs"));
    assert.equal(await readFile(written.path, "utf8"), "export {};");
    assert.equal(warnings[0].kind, "entry_file_fallback");
  } finally {
    await rm(written.path, { force: true });
  }
});
