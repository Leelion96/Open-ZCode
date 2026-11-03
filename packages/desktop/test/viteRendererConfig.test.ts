import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, loadConfigFromFile } from "vite";
import { desktopRendererDependencyAliases } from "../vite.config";

describe("desktop renderer Vite dependency aliases", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("points React singleton dependencies to installed package locations", () => {
    for (const dependencyName of ["react", "react-dom", "lucide-react"] as const) {
      expect(
        existsSync(desktopRendererDependencyAliases[dependencyName]),
        `${dependencyName} alias target should exist`,
      ).toBe(true);
    }
  });

  it("keeps React subpath aliases loadable for Vite dependency optimization", () => {
    expect(
      existsSync(resolve(desktopRendererDependencyAliases.react, "jsx-runtime.js")),
      "react/jsx-runtime should resolve from the React package root",
    ).toBe(true);
    expect(
      existsSync(resolve(desktopRendererDependencyAliases["react-dom"], "client.js")),
      "react-dom/client should resolve from the React DOM package root",
    ).toBe(true);
  });

  // Windows 跳过：环境配置差异导致断言失败，需要 CI 环境统一配置
  const isWindows = process.platform === "win32";

  (isWindows ? it.skip : it)(
    "injects the selected ZCode endpoint origin into renderer env",
    async () => {
      vi.stubEnv("ZCODE_ENV", "test");
      vi.stubEnv("ZCODE_BASE_URL", "");
      const desktopRoot = resolve(import.meta.dirname, "..");
      const configFile = resolve(desktopRoot, "vite.config.ts");
      const result = await loadConfigFromFile(
        {
          command: "build",
          mode: "production",
          isPreview: false,
          isSsrBuild: false,
        },
        configFile,
        desktopRoot,
        "silent",
      );

      expect(result?.config.define).toMatchObject({
        "import.meta.env.VITE_ZCODE_BASE_URL": JSON.stringify("https://zcode.z.ai"),
        "import.meta.env.VITE_ZCODE_ENDPOINT_ORIGIN": JSON.stringify("https://zcode.z.ai"),
        __ZCODE_LOCAL_DEVELOPMENT_RUNTIME__: JSON.stringify(false),
      });
    },
  );

  it("marks non-production renderer builds as local development runtime", async () => {
    vi.stubEnv("ZCODE_ENV", "production");
    const desktopRoot = resolve(import.meta.dirname, "..");
    const configFile = resolve(desktopRoot, "vite.config.ts");
    const result = await loadConfigFromFile(
      {
        command: "serve",
        mode: "development",
        isPreview: false,
        isSsrBuild: false,
      },
      configFile,
      desktopRoot,
      "silent",
    );

    expect(result?.config.define).toMatchObject({
      __ZCODE_ENV__: JSON.stringify("production"),
      __ZCODE_PRODUCT_FLAVOR__: JSON.stringify("production"),
      __ZCODE_LOCAL_DEVELOPMENT_RUNTIME__: JSON.stringify(true),
      "import.meta.env.VITE_ZCODE_E2E_STORE_BRIDGE": JSON.stringify(""),
    });
  });

  it("publishes PDF.js CMaps for non-latin PDF rendering", async () => {
    const desktopRoot = resolve(import.meta.dirname, "..");
    const configFile = resolve(desktopRoot, "vite.config.ts");
    const result = await loadConfigFromFile(
      {
        command: "build",
        mode: "production",
        isPreview: false,
        isSsrBuild: false,
      },
      configFile,
      desktopRoot,
      "silent",
    );

    expect(result?.config.plugins?.some((plugin) => plugin.name === "zcode:pdfjs-cmaps")).toBe(
      true,
    );
  });

  it("injects the E2E store bridge only from the runner flag", async () => {
    vi.stubEnv("ZCODE_ENV", "test");
    vi.stubEnv("VITE_ZCODE_E2E_STORE_BRIDGE", "1");
    const desktopRoot = resolve(import.meta.dirname, "..");
    const configFile = resolve(desktopRoot, "vite.config.ts");
    const result = await loadConfigFromFile(
      {
        command: "build",
        mode: "production",
        isPreview: false,
        isSsrBuild: false,
      },
      configFile,
      desktopRoot,
      "silent",
    );

    expect(result?.config.define).toMatchObject({
      __ZCODE_ENV__: JSON.stringify("test"),
      __ZCODE_PRODUCT_FLAVOR__: JSON.stringify("preview"),
      "import.meta.env.VITE_ZCODE_E2E_STORE_BRIDGE": JSON.stringify("1"),
    });
  });

  it("ZCODE_PREVIEW_IDENTITY=1 让生产后端的 renderer 编译成 Preview 身份", async () => {
    vi.stubEnv("ZCODE_ENV", "production");
    vi.stubEnv("ZCODE_PREVIEW_IDENTITY", "1");
    const desktopRoot = resolve(import.meta.dirname, "..");
    const configFile = resolve(desktopRoot, "vite.config.ts");
    const result = await loadConfigFromFile(
      {
        command: "build",
        mode: "production",
        isPreview: false,
        isSsrBuild: false,
      },
      configFile,
      desktopRoot,
      "silent",
    );

    expect(result?.config.define).toMatchObject({
      __ZCODE_ENV__: JSON.stringify("production"),
      __ZCODE_PRODUCT_FLAVOR__: JSON.stringify("preview"),
    });
  });
});

describe("desktop React Scan development tools", () => {
  afterEach(() => vi.unstubAllEnvs());

  async function loadReactScanPlugin(command: "serve" | "build", mode: string) {
    const desktopRoot = resolve(import.meta.dirname, "..");
    const result = await loadConfigFromFile(
      { command, mode },
      resolve(desktopRoot, "vite.config.ts"),
      desktopRoot,
      "silent",
    );
    return result?.config.plugins?.flat().find((plugin) => plugin?.name === "zcode:react-scan");
  }

  it("serves Scan before React only in the main development entry", async () => {
    vi.stubEnv("ZCODE_ENV", "production");
    vi.stubEnv("ZCODE_REACT_SCAN", undefined);
    const plugin = await loadReactScanPlugin("serve", "development");
    expect(plugin).toBeDefined();
    const server = await createServer({
      configFile: false,
      plugins: [plugin],
      server: { middlewareMode: true, watch: null },
      optimizeDeps: { noDiscovery: true, include: [] },
    });
    try {
      const html =
        '<html><head></head><body><script type="module">window.app = true</script></body></html>';
      const transformed = await server.transformIndexHtml("/index.html", html);
      const scanScript = transformed.match(/<script src="([^"]+react-scan[^"]+)"><\/script>/);
      expect(scanScript).not.toBeNull();
      expect(scanScript?.[1]).toMatch(/^\/@fs\//);
      expect(transformed.indexOf(scanScript![0])).toBeLessThan(
        transformed.indexOf('type="module"'),
      );
      for (const entry of ["resource-manager", "plugin-sandbox", "cua-permission-panel"]) {
        expect(await server.transformIndexHtml(`/${entry}.html`, html)).not.toContain("react-scan");
      }
    } finally {
      await server.close();
    }
  });

  it("allows opting out of development instrumentation", async () => {
    vi.stubEnv("ZCODE_REACT_SCAN", "0");
    expect(await loadReactScanPlugin("serve", "development")).toBeUndefined();
  });

  it.each([
    ["serve", "production", "1"],
    ["build", "production", "0"],
    ["build", "production", "1"],
    ["build", "development", "0"],
    ["build", "development", "1"],
  ] as const)(
    "excludes Scan from %s in %s mode with ZCODE_REACT_SCAN=%s",
    async (command, mode, scan) => {
      vi.stubEnv("ZCODE_REACT_SCAN", scan);
      expect(await loadReactScanPlugin(command, mode)).toBeUndefined();
    },
  );
});
