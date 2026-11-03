# Shared Conversation Image Gallery

## Scope

Conversation Markdown images and Browser Use / `node_repl` result images use one
shared thumbnail layout and full-screen preview dialog. Chat attachment previews also use the shared dialog while retaining their own
loading/error metadata. The persistent Preview Pane keeps its separate pane lifecycle.

## Shared thumbnail layout

- A single image keeps its intrinsic ratio, uses at most half of the message
  width, and is capped at `max-h-90`.
- A multi-image group uses one column on the narrowest screens, two columns from
  the small breakpoint, and fixed `h-44` thumbnails on desktop.
- Desktop groups flow horizontally and wrap onto additional rows. They never
  create a horizontal scrollbar.
- Every thumbnail uses `rounded-xl`, a semantic border/background, and
  `object-cover`.
- Markdown and Browser Use retain separate image loading and group ownership;
  only their presentation contract is shared.

## Shared behavior

### Preview editing (2026-10-22)

The preview supports selection/moving annotations, pen, text, rectangle, ellipse,
arrow, color, eraser, undo and redo. The eraser removes an entire annotation and
never changes source pixels (confirmed by the user). Desktop tools sit on the
right; narrow screens use a bottom toolbar. Save creates a PNG at the source
image's natural resolution and adds it to the focused Composer as a new attachment.
It preserves existing text/attachments and never sends a prompt or overwrites the source.
Closing or navigating discards this preview's unsaved annotations.

- Clicking empty space closes the mask. Image clicks, controls and completed drags do not.
- Images that fit use the normal cursor. Selection mode shows grab/grabbing only
  when the scaled image exceeds its viewport; editing uses a crosshair or text cursor.
- Wheel zoom needs no modifier and anchors at the pointer, with the same 50–300%
  range as buttons and pinch. Pan stays bounded, including after viewport resize.
- Text entry consumes arrows and undo keys. Gallery navigation must not interrupt typing.
- Save is available after an edit; it locks one focused Composer before async PNG
  export. Closing/navigating invalidates the export. Composer scope changes,
  unmount, disabled state or attachment admission failure reject the append.
  Failure keeps edits and reports an error; repeated save clicks cannot duplicate files.
  PNG export is limited to 32 million source pixels to bound canvas memory.
- Download continues to save original bytes. Video items keep their playback controls
  and do not expose annotation tools. Cross-origin canvas failures are explicit.

```text
image + preview-local annotations → Save → capture focused Composer receiver
                                           ↓
                                  async natural-size PNG export
                                           ↓
              preview still open + receiver still valid → addAttachmentFiles
                                           ↓
                                existing upload/draft attachment owner
```

Impact: presentation, draft-default and commit-effect; planning mode. The shared
`ImagePreviewDialog` is used by Markdown, tool result images, user-message media
and Composer attachments. Each entry keeps its own gallery/loading state; the
preview owns only transform and annotation history. `useComposerAttachments`
remains the attachment owner and enforces existing limits. Desktop and mobile
use the same renderer path and existing local/remote upload adapter. No changes
to accepted input, runtime, snapshots, replay or original file persistence.

Must inspect: shared dialog, annotation surface and focused Composer admission.
Should inspect: mixed video/image gallery and keyboard focus. Invariants: no
automatic send, no cross-scope late append, original media unchanged. Evidence:
codegraph is unavailable for this checkout; direct callers and attachment sink
were traced with source search to depth two. The feature graph now includes this
shared preview edit contract; there are no unresolved product decisions.

| Case | Setup/action | Expected | Decision |
| --- | --- | --- | --- |
| IPE01 | Fit image, click blank/image/control | Blank closes; image/control stays; cursor is normal | accepted |
| IPE02 | Wheel, button, pinch, pan, resize | Anchored bounded zoom/pan; grab only on overflow | accepted |
| IPE03 | Pen/text/shapes, select/move, erase, undo/redo | Original preserved; edits and history render consistently | accepted |
| IPE04 | Save with text and attachment already in Composer | One natural-size PNG appended; draft preserved; zero sends | accepted |
| IPE05 | Close/switch scope during export, full/disabled Composer, export failure | No late or duplicate append; failure retains editable history | accepted |
| IPE06 | 390/1100px, light/dark, Chinese/English | Tools/save accessible; no horizontal overflow | accepted |

Dimensions: image vs video, fit vs overflow, mouse vs touch, edit vs export,
available vs invalid Composer, width/theme/locale. Sending/queue/fork/replay
cross-products are pruned because saving only uses existing draft admission.
E2E handoff: browser candidate covers IPE01–03/05–06; desktop pending candidate
covers IPE04 with the real Composer. Promotion remains subject to human review.

- The active image starts centered at 100% zoom.
- A compact bottom pill contains only circular zoom-out and zoom-in buttons with
  the current percentage between them.
- Zoomed images support bounded mouse drag, single-touch drag, and two-touch
  pinch zoom. Images that fit inside the viewport remain centered.
- Multi-image groups expose fixed `ArrowLeft` and `ArrowRight` controls centered
  vertically against the viewport. Keyboard arrows perform the same navigation.
- Changing images resets zoom and translation.
- Closing the dialog returns focus to the thumbnail that opened it.
- Circular download and close buttons stay in the top-right safe area. Windows
  positions the action row below the native `titleBarOverlay` caption area.
  Linux keeps the dialog content below its self-drawn titlebar and preserves a
  trailing inset for the action row. macOS places the action row below the hidden native titlebar; Web and mobile keep
  the normal top-right inset.
- Download saves the active image. Desktop sends HTTP(S) sources to Electron
  main for CORS-independent streaming. Main resolves each initial/redirect
  destination, rejects local/private/reserved addresses, and pins the accepted
  address set into the actual connection to prevent DNS rebinding. It applies a 30-second timeout and five-
  redirect limit, and enforces the 50 MiB bound before the native Save As
  destination is written; resolved `data:` images continue through the bounded
  byte payload path. Web uses a size-bounded response reader when JavaScript can
  read the source, and falls back to browser-native navigation for cross-origin
  HTTP(S) sources that reject CORS so renderer memory is not used as an
  unbounded download buffer.
- Base64 `data:image/...` sources never enter the network path; their content is
  bounded in renderer memory and saved through the byte-payload IPC variant.
- The dialog works in desktop continuous and Web remote replayable rendering
  without adding image bytes to conversation/session state.

## Source-specific behavior

- Markdown provides the adjacent Markdown image group and uses image alt text as
  the suggested filename.
- Browser Use / `node_repl` provides the retained images emitted by the same tool
  result as one group and suggests `result-image-{index}.{ext}` filenames. Core
  currently retains at most `MAX_NODE_REPL_DISPLAY_IMAGES = 2` display images
  per result.

## Accepted cases

| Case    | Setup                             | Action                    | Expected                                                    |
| ------- | --------------------------------- | ------------------------- | ----------------------------------------------------------- |
| SIG-001 | One Markdown or Browser Use image | Render message            | At most half message width and `max-h-90`                   |
| SIG-002 | Multiple images on narrow mobile  | Render message            | One column, wrapped without horizontal scrolling            |
| SIG-003 | Multiple images on small screen   | Render message            | Two columns, equal-height cropped thumbnails                |
| SIG-004 | Multiple images on desktop        | Render message            | Horizontal `h-44` thumbnails wrapping to new rows           |
| SIP-001 | One image                         | Open preview              | Centered image, no navigation arrows                        |
| SIP-002 | Multiple images                   | Open the second thumbnail | Second image active; arrows and keyboard navigate the group |
| SIP-003 | Zoomed image                      | Drag or pinch             | Translation/zoom stay within configured bounds              |
| SIP-004 | Any image                         | Download                  | Active image is saved through the current platform path     |
| SIP-005 | Navigated/zoomed image            | Change image              | Zoom and translation reset to 100%/center                   |
| SIP-006 | Windows or Linux desktop preview  | Open preview              | Download/close stay outside native or self-drawn controls   |

## Editing validation (2026-10-22)

- Before the fix, real browser regressions reproduced all three reports: a blank
  click kept the preview open, a fitted image had `grab`, and wheel input left
  zoom at 100%. The transparent Dialog content intercepted blank clicks, the
  viewport cursor was unconditional, and there was no wheel listener.
- Browser coverage verifies annotations, selection/move/erase/history, natural
  PNG pixels, touch pinch, bounded pan, resize, mouse-anchored wheel zoom, gallery
  button hit testing, disabled-save click isolation, and export cancellation/rejection.
  All 20 browser cases passed (18 together, two later regression cases individually).
  Visual checks cover
  390/1100px, Zai light/dark, Chinese/English.
- Real macOS Electron: save-to-Composer 1/1 passed (run
  `desktop-e2e-20261022124558480-p56523-2adaaa12b3911c95`); existing gallery 5/5
  passed (`desktop-e2e-20261022125109960-p80041-c18b5ef3f853e9e2`). The new case
  verifies a 320×240 PNG, existing draft/attachment retention and zero sends.
  Its first fixture had zero image dimensions; the repaired fixture explicitly
  waits for successful decoding before drawing.
- Official affected selection ran 502 files / 5279 assertions. One jsdom test
  lacked ResizeObserver; after adding its browser API mock, its targeted rerun
  passed 5/5. All other 501 files passed in the affected run.
- Root typecheck, Desktop E2E typecheck, lint, scoped formatting, architecture,
  fixture metadata and open-source checks passed. Lint retains existing warnings.
- Not executed: Windows/Linux native apps, real phone Safari, actual SSH/WSL/Docker
  attachment transport. Narrow browser/touch emulation does not claim those paths.
  The new desktop case remains pending human promotion; no Docker admission.
