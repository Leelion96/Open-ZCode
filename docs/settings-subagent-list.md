# Settings subagent list

The Subagents settings list is an independent Agent capabilities entry. It uses the same scope and resource-list language as MCPs, Skills, Commands, and Hooks while keeping implementation identifiers out of visible row content.

## Scope contract

- The page-level scope menu is grouped by device (shared with Plugins, MCP, Skills, Commands and Hooks): "This computer" lists User and a Projects entry; each online remote device lists its User and its Projects entry. A Projects entry opens a submenu with that device's projects, so the first level grows only with the number of devices. Offline devices are not listed. The trigger shows "device · User" or "device · project". The adjacent summary reports the number of subagents in the selected scope.
- User scope shows direct user agents, user-installed plugin agents grouped by plugin, and built-in agents.
- Workspace scope shows direct agents from `<workspace>/.zcode/agents` and agents from plugins installed into that workspace, grouped by plugin. Built-in agents never appear in workspace scope.
- Search is case-insensitive and hides empty groups. A zero-result search shows one search-empty state instead of empty group headings.
- New is placed beside the Installed heading. New inherits the selected page scope; Edit shows the resource scope but does not allow changing it.
- Workspace identity is carried together with workspace path when listing or mutating workspace resources. The path remains the filesystem target and identity remains the isolation key.

### User authority follows the selected device

User is always the User of the device selected in the scope menu. Opening Settings defaults
to the User of the device that owns the current workspace: a local tab selects
"This computer · User", a remote tab selects "<device> · User". The earlier rule
"User is always the base Host" (which hid the remote User from remote tabs) is removed.
The selected scope owns the service target; the last active tab is never the authority.

```text
This computer · User -> base services                         -> base Host user agents
<device> · User      -> that device's SourceSettingsAttachment -> device user agents (no project needed)
<device> · project   -> identity/session config services       -> selected project agents
device offline       -> no services (fail-closed notice)       -> no read, no write, no local fallback
```

- Lists, model choices, edits, creation, deletion and plugin inventory use the same scope
  authority. Local User plugin initialization may use an available local project, else the
  local home; remote User uses the device home (`systemService.info().homedir`). A remote
  path is never sent to the base Host and a local path is never sent to a remote device.
- Exception for model choices on a remote User: the SourceSettingsAttachment does not
  expose `model-selection` (R3 §8.2), so the page does not read a model catalog there. The
  catalog state is `unavailable`, not an error: no "model list failed to load" notice, and
  the form offers only "Inherit default". A persisted model on an existing agent is kept as
  is; its reasoning effort is kept and the control shows "Reasoning effort unavailable", not a
  loading spinner. A remote project still reads the model catalog of that project's Host. The page never
  borrows the catalog of the base Host or of another device.
- A User mutation refreshes already loaded subagent contexts belonging to that service
  authority. Workspace mutations refresh only the matching workspace identity. A stale
  response from a previous target must not overwrite the current projection; a late home
  directory result belongs only to the attachment that produced it.
- When the selected device goes offline the page shows an offline notice and pauses all RPC;
  it does not fall back to the base Host or show a writable old snapshot.
- Web and mobile cannot request source-settings attachments, so remote devices list only
  their projects there; a remote tab then defaults to its project scope.
- This uses existing service injection and attachments. It creates no Host or stream state
  and preserves desktop `continuous` and mobile `replayable` delivery.

Regression coverage: `useSettingsScope.test.ts` and `settingsScope.test.ts` check grouping,
defaults, source-settings routing, fail-closed and late results; `subagentsSection.test.ts`
checks that the section routes lists, models, plugin initialization and creation to the selected
scope's services, that a remote User reads no model catalog and shows no load-failure notice,
and that a real local catalog failure still shows the notice; in both cases the edit form of an
agent with a persisted model shows "Reasoning effort unavailable", not loading;
`conversation-session-remote-data-sync-scope-by-device.test.ts` (DSYNC-15)
checks real GUI creation on the remote User and the local User, and the reasoning control of a
remote agent with a persisted model.

The SSH regression must distinguish connection completion from directory selection:
`waitForSSHDirectoryStep` reports `closed` when the conversation flow unmounts the
wizard, and `directory` only when the directory step is visible. The case asserts
`closed` before checking the conversation identity/session; closing the wizard alone
does not prove a successful connection. Installation/boundary confirmations remain
handled, and connection errors fail immediately. Project flows still verify the
directory step and selected workspace. This is a test-helper contract only; Host and
desktop/mobile delivery behavior do not change.

## Resource groups

- `Installed` contains directly-created agents for the selected scope.
- Each plugin has its own group using the converted plugin display name and plugin icon where available.
- `Built-in` is a User-only group.
- Empty and loading containers use the common dashed-border treatment.

- Rows display the agent name, description, model label when applicable, tool label, and available controls.
- Rows do not display the backing Markdown path or internal built-in identifier. Values such as `/Users/name/.zcode/agents/example.md` and `built-in:general-purpose` remain implementation data used for editing and identity only.
- Group headings communicate ownership, so rows do not repeat scope labels.
- Item descriptions use `text-ui-sm text-foreground-subtle` as secondary copy.
- Model and tool metadata labels use `rounded-md bg-surface px-1.5 py-0.5 text-ui-sm text-foreground-subtle ring-1 ring-border`, matching MCP tool-count labels.
