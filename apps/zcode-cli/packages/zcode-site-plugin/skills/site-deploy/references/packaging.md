# Packaging

The package is the stage directory `.zcode-site/stage/`, packed by `zcode-site deploy`. The stage root becomes `/app` in the cloud and must contain `start.sh`. Put in it only what the running site needs.

## Stage layout by project type

**Static site**
```
stage/
├── start.sh            # from templates/static.sh
├── static-server.mjs   # from templates/static-server.mjs
└── dist/               # build output (index.html, assets/…)
```

**Node server**
```
stage/
├── start.sh            # from templates/node.sh
├── package.json        # keep it: "type": "module" and package imports depend on it
├── <build output>      # dist/, build/, .output/, .next/ … whatever the entry needs
└── node_modules/       # production dependencies, installed for linux x64
```
Self-contained server outputs (standalone builds, node adapters) bring their own trimmed `node_modules`; see [app-types.md](app-types.md).

**Python server**
```
stage/
├── start.sh            # from templates/python.sh
├── <application code>  # main.py, app/, mysite/, templates/, static/ …
└── vendor/             # dependencies, linux x86-64 wheels for Python 3.12
```

## Never in the package

- `.env`, `.env.*` (except `*.example`) — secrets. `deploy` refuses them.
- `.git/`, the project binding file reported by `zcode-site help`, `.DS_Store`, `__pycache__/` — `deploy` always drops these.
- Source the runtime doesn't execute: TypeScript sources when compiled JS is shipped, frontend sources after the build, tests, docs, storybook.
- Dev dependencies and build tooling (`typescript`, `vite`, `webpack`, `eslint`, `@types/*`, `pytest`).
- Caches and local data: `.next/cache`, `.turbo`, `.cache`, `.parcel-cache`, `.svelte-kit` (except the build output), `coverage/`, `node_modules/.cache`, virtualenvs (`.venv/`, `venv/`), local SQLite files with the user's private data.
- Anything built for the local OS that the runtime would load (macOS/Windows native binaries). `deploy` reports these.

Copy what is needed into the stage instead of packing the project root and excluding things — an allow-list can't leak a file you didn't think of.

## pnpm, yarn and symlinks

pnpm (and `npm` workspaces / `yarn` PnP) lay out `node_modules` with symlinks pointing outside the directory. `deploy` follows symlinks, so links inside the stage become real files — but the targets must exist. Simplest reliable options, in order:

1. Install the stage's dependencies with npm into the stage itself (see [native-deps.md](native-deps.md)). Produces a flat, self-contained `node_modules`.
2. With pnpm: `pnpm install --prod --frozen-lockfile --config.node-linker=hoisted` inside the stage.
3. Yarn Berry PnP: set `nodeLinker: node-modules` in the stage, or use npm.

Never copy the project's own `node_modules` into the stage: it contains dev dependencies and binaries built for the local machine.

## The package check

Before creating anything, `zcode-site deploy` checks the stage and lists every problem at once in `error.data.problems` (`PACKAGE_CHECK_FAILED`); each says what to change. Don't work around a check by dropping files the app needs. The checks mirror the server preflight (`PACKAGE_INVALID`): root `start.sh` with LF endings, no `/.__zcode`, no broken symlinks or `.env` files, dependencies present for `package.json` / `requirements.txt`, the size, count and depth limits, and every native binary linux x86-64.

**Foreign binaries that are never loaded.** Some packages ship prebuilt binaries for every platform side by side (`prebuilds/darwin-arm64/…` next to `prebuilds/linux-x64/…`). Once you have confirmed the linux-x64 variant is there, delete the foreign ones from the stage (preferred, it also shrinks the package) or deploy with `--allow-foreign-binaries`.

## Making the package smaller

When a limit is exceeded, in this order:

1. Make sure only production dependencies are installed (`--omit=dev`, `--prod`, no `-r requirements-dev.txt`).
2. Use the framework's self-contained server output (standalone build, node adapter), which bundles most dependencies.
3. Bundle a Node server into one file with esbuild, keeping only native packages external, then install just those into the stage:
   `npx esbuild src/server.ts --bundle --platform=node --target=node24 --format=esm --outfile=.zcode-site/stage/server.mjs --external:better-sqlite3 --external:sharp`
   (ESM bundles of CommonJS dependencies may need `--banner:js="import { createRequire } from 'module'; const require = createRequire(import.meta.url);"`). Run `zcode-site check` to make sure nothing is missing.
4. Remove files that are never loaded at runtime: other platforms' prebuilt binaries, `*.map` source maps of dependencies, `docs/`, `test/`, `examples/` inside dependencies. Check before deleting anything you are unsure about.
5. Large media: compress images/videos, or tell the user to host large media elsewhere. A single file over 25 MB can't ship.

If the app is still too large (for example it needs PyTorch, TensorFlow, Chromium or a large model file), it can't run on ZCode Sites; tell the user.
