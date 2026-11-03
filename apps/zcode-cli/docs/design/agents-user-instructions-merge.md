# AGENTS.md User And Workspace Merge

## Goal

ZCode should treat `~/.zcode/AGENTS.md` as the user's default instruction file and merge it with the workspace `AGENTS.md` resolved for the current session.

## Resolution

- Workspace instruction discovery keeps the current behavior: search from `workingDirectory` upward until the detected project root, or filesystem root when no project root is detected.
- The user default instruction file is `~/.zcode/AGENTS.md`.
- `HOME` resolves the user directory first. On Windows-style environments, `USERPROFILE` is used when `HOME` is absent. If neither is set, Node's `homedir()` is used.
- The user default file is only considered when `priorityFiles` includes `AGENTS.md`. Custom priority sets that omit `AGENTS.md` must not load `~/.zcode/AGENTS.md`.

## Merge Order

When both sources exist, ZCode injects both in this order:

1. User default instructions from `~/.zcode/AGENTS.md`.
2. Workspace instructions from the resolved workspace `AGENTS.md`.

Workspace instructions appear later so they can narrow or override broad user defaults for work inside the repository.

## Prompt Shape

Each loaded source renders as its own block inside the `context_prefix` announcement, in merge order:

- `Contents of <path> (user's private global instructions for all projects):`
- `Contents of <path> (project instructions, checked into the codebase):`

The full shape (fixed preamble, Project Memory index, order against other announcements) is defined in
`docs/design/v2/loop/meta-user-context.md`. This document only owns source resolution and merge order.

## Compatibility

`ResolvedUserInstructions` keeps its historical single-source fields for compatibility, while also exposing a `sources` array for multi-source rendering. Existing callers that only inspect `filePath` or `content` continue to receive a deterministic primary path and merged content.
