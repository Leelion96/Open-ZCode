# Node dependencies for Linux x86-64

The cloud runs Node.js 24 on Debian 12 (glibc 2.36), x86-64. Install the stage's production dependencies **separately, for linux x64** — never copy the project's `node_modules`: native code built for the user's machine crashes on load (`invalid ELF header`, `Exec format error`, `was compiled against a different Node.js version`). `zcode-site deploy` lists every binary in the stage that isn't linux x86-64.

## Two kinds of native dependencies

- **Optional platform packages** (`sharp` ≥ 0.33, `esbuild`, `@swc/core`, `@napi-rs/*`, `@libsql/*`, …): npm picks the prebuilt package for the target OS/CPU, so **cross-install works**.
- **Install-script builds** (`better-sqlite3`, `bcrypt`, `canvas`, …): a postinstall script downloads or compiles a binary for the **machine running npm**. Cross-install silently installs the local binary; it can't work. Replace the package with a pure-JS or optional-platform equivalent and adapt the code, or tell the user which feature won't work in the cloud.

## Cross-install

Copy `package.json` and the lockfile into the stage, then inside `.zcode-site/stage`:

```
npm install --omit=dev --no-audit --no-fund --os=linux --cpu=x64 --libc=glibc
```

- Requires npm ≥ 10. With a lockfile, `npm ci` accepts the same flags.
- pnpm ≥ 9: `pnpm install --prod --frozen-lockfile --config.node-linker=hoisted --os=linux --cpu=x64 --libc=glibc`

## Runtime-specific notes

- **SQLite**: Node 24 has `node:sqlite` built in (`DatabaseSync`, an API close to better-sqlite3), the simplest replacement for `better-sqlite3` / `sqlite3`. Keep the file under `$DATA_DIR`.
- **Prisma**: the engine must match the image: `binaryTargets = ["native", "debian-openssl-3.0.x"]`, then `prisma generate`.
- **Not available**: headless browsers (`puppeteer`, `playwright`), external tools (`ffmpeg`, ImageMagick, LibreOffice), GPU. A static linux-x64 binary in the package can work only within the 25 MB per-file limit.
- Packages used only at build time (vite, esbuild, swc, tailwind) don't belong in the stage.
