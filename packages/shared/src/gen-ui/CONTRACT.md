# gen-ui-protocol

Pure wire contracts for generated conversation UI. A reference identifies an executor-side file;
it does not grant file access. The target Host authorizes and normalizes paths. Workspace identity
and session isolate state. A state update replaces a JSON snapshot of at most 16 KiB. Only
modelContent can enter bounded, untrusted model context. No MCP plugin identity or tool permission
is implied by a generated UI reference.

Tweak messages follow the upstream registration/update/disposal and ACK lifecycle. Each registration identifies one DOM target and at most 12 typed controls; preview changes carry registrationId, targetId, callback and previousValue. The page owner accepts at most 64 live registrations. This private Gen UI method grants no generic tool access.

`zcode/genUiStyles` carries string CSS variables restricted to the `--gen-ui-*` namespace in HostContext. Standard MCP style variables remain separate and pass SDK validation. This presentation extension changes no session or task state. See `docs/specs/gen-ui-styles.md`.

Model state travels as bounded `genUiContext` input metadata, never appended to user text.
The CLI owns legacy-tail decoding and reminder projection; queued inputs retain the snapshot
captured at admission. Empty arrays identify new-format input. See `docs/specs/gen-ui-model-context.md`.
