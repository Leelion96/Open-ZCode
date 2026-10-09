# Open-ZCode

<div align="center">
  <img src="public/logo/icons/1024x1024.png" alt="Open-ZCode" width="128" height="128" />
</div>
<p align="center">
  <a href="README.md">简体中文</a> | English
</p>

This project is a fork of open-source [ZCode](https://github.com/zai-org/ZCode), intended to help teams quickly adopt ZCode as an AI productivity tool.

The changes implemented so far fall into three categories:

1. **Isolation from the official ZCode app**: separate brand names, application identities, user data, and project artifacts allow this fork and the official app to operate independently.
2. **A self-hosted [Open-ZCode-Server](https://github.com/Leelion96/Open-ZCode-Server) to take over upstream service capabilities used by the project**: configuration delivery and the plugin marketplace are implemented. Login, sharing, feedback, and update business capabilities are not yet implemented; their APIs remain placeholders.
3. **Adjustments to official services and commercial entry points**: disable audit reporting, official account authorization, and commercial plan entry points.

## Change Principles

Before describing the implementation, I want to explain **how I have approached modifying this project**.

When extending an open-source project, differences from upstream accumulate, increasing the effort needed to resolve conflicts when merging future upstream updates. (Unless you treat the fork as a one-off and never intend to bring in upstream updates again.)

To reduce future merge conflicts, this project follows these minimal-change principles:

- **Preserve upstream interfaces where possible, and handle differences through self-hosted services**  
  For configuration, templates, plugin catalogs, and other server-provided content, prioritize compatibility with existing interfaces and data structures. The client retains its original request, parsing, and consumption logic to minimize changes to client business code.

- **When disabling a feature, prefer configuration switches or changes to its entry points**  
  For unwanted features such as official account authorization and commercial plans, disable the relevant switches or entry points first. Preserve existing implementations and shared capabilities needed by other features where possible, avoiding extensive removal of business code.

- **Keep each commit focused on one clear requirement, making it easy to review and select independently**  
  Branding, application identity isolation, user data isolation, and project data isolation are committed separately. Each commit aims to cover the required behavior completely, without unrelated refactoring or formatting changes, so it can be retained or reverted as needed.

## Changes

The comparison below uses upstream ZCode **3.14.3** (`29628c9`) as the baseline. The current implementation is illustrated using the default desktop product configuration.

| Change                                                          | Upstream ZCode implementation                                                                                                                                                                                                                  | Current implementation                                                                                                                                                                                                                                  |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Application identity and system integration isolation           | The production app uses `dev.zcode.app`, the `zcode://` protocol, and ZCode's Electron profiles and system registration identifiers                                                                                                            | Uses `dev.openzcode.app`, the `open-zcode://` protocol, and separate profiles; isolates Finder, Windows context menu, and Linux desktop integrations while retaining Preview / Dev distinctions                                                         |
| User data and embedded Agent isolation                          | User data defaults to `~/.zcode/`; the embedded Agent uses configuration, runtime data, and executable lookup paths under that directory                                                                                                       | Defaults to `~/.open-zcode/` for settings, credentials, sessions, logs, and global resources; preserves internal structure and explicit path precedence without automatically scanning or migrating the official app's private data                     |
| Project configuration and artifact isolation                    | Uses project paths such as `.zcode/`, `zcode.json`, `.zcodeignore`, and `.zcode-share/`                                                                                                                                                        | Uses `.open-zcode/`, `open-zcode.json`, `.open-zcodeignore`, and `.open-zcode-share/`; updates reads, writes, watchers, permissions, and cleanup consistently while retaining generic `.agents/` and root `AGENTS.md`                                   |
| Application brand text                                          | The UI, native windows, system integrations, and embedded Agent use ZCode brand text                                                                                                                                                           | First-party text that needs to identify the app uses the configured name, `Open-ZCode`, across windows, menus, the Agent, process labels, and newly generated data                                                                                      |
| Simplified general wording                                      | Some error messages, internal prompts, and capability descriptions include ZCode as their subject                                                                                                                                              | Removes unnecessary brand references according to their original meaning, using specific terms such as session, runtime, and Agent; updates Chinese and English wording and historical error recognition                                                |
| Disabled official login, plan, and entitlement entry points     | BigModel / Z.ai OAuth is enabled by default, with authorization and API Key configuration on the welcome screen<br />Model settings display official personal and team plans and entitlements; the sidebar provides a plan upgrade entry point | Disables both OAuth providers by default and allows login to be skipped directly; model settings show a default plan placeholder and custom providers, hiding official plans, quota displays, and upgrade entry points                                  |
| Product configuration and template delivery (companion service) | Connects to the official product service by default, with an existing `ZCODE_BASE_URL` override; delivers feature configuration, provider templates, and scene templates                                                                       | Reuses `ZCODE_BASE_URL` to connect to Open-ZCode-Server for independently maintained configuration, provider templates, draft suggestions, and scheduled-task templates; login, sharing, feedback, and update business capabilities remain placeholders |
| Client interaction tracking (service configuration)             | Product-service configuration controls interaction tracking through `rendererActionTrace`                                                                                                                                                      | The self-hosted Server explicitly disables interaction tracking and related sampling; other telemetry follows its own configuration, so this does not mean all reporting capabilities are disabled                                                      |

Note: this table primarily covers the desktop app and embedded Agent. Standalone CLI / Web distribution identities have not been customized separately; wording, network fixes, and marketplace configuration in shared source use the same implementation across entry points. The product service and interaction tracking entries describe the companion Server's configuration. Plugin marketplace work includes local client changes that have not yet been committed.

## Quick Start

Install Git, Node.js **24.14.0**, and pnpm **10.33.2**. [mise.toml](mise.toml) is the source of truth for tool versions. Run all development and packaging commands below from the repository root.

```bash
pnpm bootstrap
```

`pnpm bootstrap` installs workspace dependencies, prepares local desktop runtime assets, and runs `build:bootstrap`.

The Agent CLI and runtime source code lives in [apps/zcode-cli/](apps/zcode-cli/) as a regular directory included when you clone this repository. No separate checkout or Git submodule initialization is required.

Once your self-hosted Server has an HTTPS address, start the desktop app on macOS / Linux:

```bash
ZCODE_BASE_URL=https://your-server.example.com pnpm dev:desktop
```

Windows PowerShell:

```powershell
$env:ZCODE_BASE_URL = "https://your-server.example.com"
pnpm dev:desktop
```

Replace the example URL with your deployment address. Process environment variables take precedence so that desktop build entry points use the same service address; environment files can also be maintained as described under Configuration below. Restart development or rebuild the distribution after changing build configuration. On first launch, skip login and configure your own API Key and endpoint in model settings.

## Branding and Isolation Configuration

[config/product.json](config/product.json) is the single configuration entry point for the desktop product:

```json
{
  "name": "Open-ZCode",
  "appId": "dev.openzcode.app",
  "customizeIdentity": true,
  "isolateUserData": true,
  "isolateProjectData": true
}
```

| Field                | Purpose                                                                                                              |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `name`               | Brand text for the app and embedded Agent; also derives identifiers and directories for enabled isolation categories |
| `appId`              | Desktop appId used when application identity isolation is enabled                                                    |
| `customizeIdentity`  | Isolates installation identity, external protocol, Electron profiles, and system integrations                        |
| `isolateUserData`    | Isolates user-level business data and the embedded Agent's default user directory                                    |
| `isolateProjectData` | Isolates project configuration, ignore files, shared attachments, and runtime artifacts                              |

The three switches are independent. A disabled category follows upstream defaults. Restart desktop development or rebuild after changing the name or switches; official data is not automatically migrated, merged, or removed. See [Desktop Product Configuration](config/README.md#产品品牌与隔离配置) for details and explicit path override boundaries.

## Development and Usage

### Setup Options

Additional setup and build commands:

| Command                        | Purpose                                                                                                                             |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install`                 | Install dependencies                                                                                                                |
| `pnpm prepare:desktop-runtime` | Prepare desktop runtime assets, including remote assets by default                                                                  |
| `pnpm prepare:remote-assets`   | Prepare remote runtime assets separately                                                                                            |
| `pnpm bootstrap:with-remote`   | Set up dependencies and local and remote assets, then build the relevant packages sequentially; skip the desktop application bundle |
| `pnpm build`                   | Recursively run each workspace package's build script, including its asset preparation steps                                        |

The default `bootstrap` skips remote asset preparation and is suitable for local desktop development. Run the corresponding preparation command when working with remote workspaces or validating remote distribution assets.

### Desktop

```bash
pnpm dev:desktop

# Use the test environment
pnpm dev:desktop:test
```

`pnpm dev:desktop` defaults to `pnpm dev:desktop:prod` and sets `ZCODE_ENV=production`; endpoint configuration determines the actual service address. Switching between `test` and `production` does not automatically select a self-hosted service. The startup script prepares local runtime assets, builds the desktop Agent, then starts Electron and source watchers.

Set `ZCODE_DATA_BASE_DIR` to use a separate development data directory. For example, on macOS / Linux:

```bash
ZCODE_DATA_BASE_DIR="$HOME/.open-zcode-dev-home" pnpm dev:desktop:test
```

### Remote Features (SSH/WSL)

Run `pnpm bootstrap:with-remote` to prepare remote resources (`mock-cdn`), then start `pnpm dev:desktop`. When connecting to a remote project, select the option to download locally and upload. Development uses `packages/desktop/mock-cdn` and local build outputs, uploaded via SFTP, without downloading those runtime resources from the CDN.

### Web Development

Use development mode when editing Web or backend source code:

```bash
pnpm dev:web

# Set the backend workspace (macOS / Linux)
ZCODE_SERVER_WORKSPACE=/path/to/project pnpm dev:web
```

This starts both the Web development server (default: `http://localhost:5173`) and the backend (default: `http://localhost:3030`). Open the Web development server in your browser. `/ws` and general `/api` requests are proxied to the local backend; `/api/v1/oauth/token` is proxied separately to the configured product service.

The Web frontend, backend, and its original Agent use the branding and user/project directory configuration from `config/product.json`. The startup command, Agent lookup order, and directory precedence retain their existing behavior, with no separate Web Agent output or automatic build step.

After changing Agent source code, run `pnpm --filter @zcode/cli... build` and restart the service. To validate the complete distribution, extract and run it as described under Packaging → ZCode CLI distribution below.

### ZCode CLI distribution

The command-line distribution includes the TUI, Web client, and Agent behind one `zcode` command. With no arguments it starts the TUI; a leading `--web` starts Web mode; all other arguments go to the existing Agent CLI. Both modes run locally without Electron.

```bash
# Start the terminal UI by default
zcode

# Start the Web interface
zcode --web

# Set the project and port without opening a browser automatically
zcode --web --workspace /path/to/project --port 3030 --no-open

# Show CLI or Web options
zcode --help
zcode --web --help
```

In Web mode, it uses the current directory as the workspace, listens on `127.0.0.1` without token authentication by default, selects an available port, and opens a browser. Use the URL printed in the terminal and press `Ctrl+C` to stop the service. For LAN access, use `--host 0.0.0.0`; listening on a non-local address generates an access token by default. Use the token-bearing URL printed in the terminal. Set a token with `--token`, or disable token authentication with `--no-token`.

When starting the general Web service's HTTP entry directly, configure API/WebSocket authentication with `ZCODE_SERVER_AUTH_TOKEN`. When creating the service programmatically, use the `authToken` option.

See Packaging below for build instructions. `pnpm build:zcode` only creates the distribution; it does not replace an existing `zcode` on `PATH`. If the command still points to an older installation or another checkout, check it with `command -v zcode` on macOS / Linux or `where.exe zcode` on Windows.

### CLI Source Development

Use the source entry when developing the TUI or Agent:

```bash
pnpm --filter @zcode/cli dev --help
pnpm --filter @zcode/cli dev

# Build the CLI and its workspace dependencies
pnpm --filter @zcode/cli... build
node apps/zcode-cli/packages/cli/dist/zcode.cjs --help
```

This entry runs the Agent CLI directly and does not handle the distribution's `--web` switch. Use `pnpm dev:web` for Web development, or the extracted `bin/zcode.mjs` shown below to test the unified command.

## Configuration

The root [.env.example](.env.example) provides sample service URLs and build configuration, retaining upstream URLs as reference values. Copy it only for first-time setup when `.env` does not exist; preserve existing local configuration. Desktop builds read `.env`, `.env.local`, and environment files for the build mode; mode-specific files can override general files, and process environment variables take precedence. Select the Desktop product environment with `dev:desktop:test` or `dev:desktop:prod`.

| Setting                              | Purpose                                                                                                                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ZCODE_BASE_URL`                     | Product service origin, such as `https://your-server.example.com`, without `/api/v1`                                                                                      |
| `ZCODE_DATA_BASE_DIR`                | Base directory for application data; the current desktop configuration uses `.open-zcode/`, while standalone CLI / Web builds without product configuration use `.zcode/` |
| `ZCODE_SERVER_WORKSPACE`             | Workspace path for the Web backend                                                                                                                                        |
| `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` | Path to a local provider configuration file; uses the built-in configuration when unset                                                                                   |
| `ZCODE_DIST_BASE_URL`                | Download base URL used by the CLI distribution installer                                                                                                                  |

The CDN, remote resources, shared-page backlinks, and third-party model services have separate URL settings; changing `ZCODE_BASE_URL` alone does not establish that all network requests have switched. See [.env.example](.env.example) for the variables and [config/README.md](config/README.md) for defaults shipped with the client.

## Packaging

See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) for third-party copyright and license information, and retain the corresponding notices in distributions.

### Desktop

```bash
pnpm bundle:desktop

# Set the target platform and CPU architecture
pnpm bundle:desktop -- --os win --arch x64

pnpm bundle:desktop -- --help
```

The default target is macOS arm64, and the default output directory is `packages/desktop/dist/`. `--os` accepts `mac`, `win`, or `linux`; `--arch` accepts `x64` or `arm64`. Packaging and signing require the tools and configuration for the target platform.

With the current default branding, open the DMG and drag Open-ZCode into Applications. Local builds are unsigned. If macOS blocks the first launch, you can run this command for your own build:

```bash
sudo xattr -rd com.apple.quarantine /Applications/Open-ZCode.app
```

### ZCode CLI distribution

Run `pnpm build:zcode` to build the CLI/TUI, backend, and Web client, collect the TUI native libraries, workers, and runtime dependencies, then assemble the distribution. Running the distribution still requires Node.js; use the version specified in `mise.toml`.

Before packaging, set the download base URL with `ZCODE_DIST_BASE_URL` in `.env`, `.env.local`, or the process environment, or pass it through `--base-url`. The URL below is a placeholder; replace it with your hosting URL when publishing:

```bash
pnpm build:zcode --base-url https://downloads.example.com/zcode/

# When ZCODE_DIST_BASE_URL is already configured
pnpm build:zcode

# Repackage existing Agent, backend, and Web build outputs
pnpm build:zcode --skip-build

# Show options for the version, output directory, and more
pnpm build:zcode --help
```

The version defaults to the root `package.json` version. Output is written to `dist/zcode/`:

- `releases/<version>/zcode-<version>.tar.gz`: runtime package.
- `releases/<version>/sha256.txt`: checksum file.
- `latest.json` and `install.sh`: version index and installer.

Upload the entire directory to the configured download base URL. The installer downloads the runtime package from that URL, installs it to `~/.zcode/runtime` by default, and creates the `zcode` command in `~/.local/bin`. Override these directories with `ZCODE_DIST_HOME` and `ZCODE_DIST_BIN_DIR`, respectively.

Existing Lite users should switch to the new build command, environment variables, and installer. Installation does not remove old Lite directories or migrate/delete session data.

To test a packaged build locally, extract and run it directly without uploading or installing it:

```bash
zcode_version=$(node -p "require('./dist/zcode/latest.json').version")
mkdir -p dist/zcode/debug
tar -xzf "dist/zcode/releases/$zcode_version/zcode-$zcode_version.tar.gz" \
  -C dist/zcode/debug
# Start the TUI by default
node dist/zcode/debug/zcode/bin/zcode.mjs

# Start Web mode
node dist/zcode/debug/zcode/bin/zcode.mjs --web \
  --workspace "$PWD" --port 3030 --no-open
```

Open `http://127.0.0.1:3030` to validate the complete flow, with one backend serving the Web pages and running the Agent. The port must be available; if `pnpm dev:web` is already running, choose another `--port`.

## Repository Structure

| Directory                                            | Responsibility                                                                          |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `packages/desktop`                                   | Electron Main, Host, Renderer, and desktop packaging                                    |
| `packages/web`                                       | Web client                                                                              |
| `packages/server`                                    | HTTP / WebSocket services and remote connections                                        |
| `packages/zcode-server-cli`                          | Standalone server startup and process management                                        |
| `packages/ui`                                        | Shared React components, hooks, and Zustand state                                       |
| `packages/services`                                  | Business services and persistence                                                       |
| `packages/shared`, `packages/rpc`, `packages/client` | Shared protocols and types, RPC framework, and Agent client SDK                         |
| `packages/provider`, `packages/provider-node`        | Common provider capabilities and Node implementations                                   |
| `apps/zcode-cli`                                     | Agent CLI, TUI, runtime, and tools                                                      |
| `scripts`, `config`, `third-party`                   | Build and maintenance scripts, built-in configuration, and third-party notice materials |

## Current Scope and Upstream Relationship

The current source is based on upstream ZCode **3.14.3**. This project is independently maintained and retains upstream attribution, internal package names, protocol fields, and compatible file formats.

- Branding and data isolation configuration covers the desktop app and embedded Agent. Standalone CLI / Web distribution identities, the Computer Use Helper, and remote runtime components are outside this isolation scope; the standalone command remains `zcode`.
- Branding changes cover first-party text. Logos and icons retain their existing appearance; third-party and user content retains its source identity. Existing data is not automatically migrated. See [Application Branding](specs/features/application-brand-text.md) for details.
- `ZCODE_BASE_URL` selects the product service endpoint. The Server's implemented capabilities, other URL settings, and client fallback behavior together determine the actual operating scope.
- Windows / Linux adapter checks do not establish real installation, uninstallation, or signing validation. See [Product Isolation Verification](specs/features/product-isolation-verification.md).

Upstream project and communities: [ZCode source](https://github.com/zai-org/ZCode) · [Upstream Feishu community](https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=47ag983c-8fcb-4d6d-814b-5395193a712c&qr_code=true) · [Upstream Discord](https://discord.gg/z9aBcQXZQ3). These entry points belong to the upstream project.

## License and Project Notice

First-party code uses [Apache-2.0](LICENSE). See [NOTICE.md](NOTICE.md) and [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) for capability scope, maintenance rules, execution and data risks, and third-party copyright information. Third-party components and resources follow their own licenses.
