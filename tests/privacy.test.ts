import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const manifestPath = new URL("../manifest.json", import.meta.url);

async function readSource(path: string): Promise<string> {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

async function productionSourcePaths(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return productionSourcePaths(entryPath);
      }
      return entry.isFile() && entry.name.endsWith(".ts") ? [entryPath] : [];
    }),
  );
  return nested.flat().sort();
}

describe("manifest and privacy invariants", () => {
  it("declares a Figma-assigned ID and the network-disabled Design contract", async () => {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
      string,
      unknown
    >;

    expect(manifest).toMatchObject({
      name: "Figma Design IR",
      api: "1.0.0",
      editorType: ["figma"],
      main: "dist/code.js",
      ui: "dist/ui.html",
      documentAccess: "dynamic-page",
      networkAccess: {
        allowedDomains: ["none"],
      },
    });
    expect(manifest.id).toMatch(/^\d+$/);
    expect(manifest.networkAccess).not.toHaveProperty("devAllowedDomains");
  });

  it("contains no network, persistence, content logging, or disallowed API surface", async () => {
    const projectRoot = fileURLToPath(new URL("..", import.meta.url));
    const typescriptPaths = await productionSourcePaths(
      path.join(projectRoot, "src"),
    );
    const source = [
      ...(await Promise.all(
        typescriptPaths.map((file) => readFile(file, "utf8")),
      )),
      await readSource("src/ui/index.html"),
      await readSource("src/ui/styles.css"),
    ].join("\n");

    expect(source).not.toMatch(/https?:\/\//i);
    expect(source).not.toMatch(
      /\b(fetch|XMLHttpRequest|WebSocket|localStorage|sessionStorage|indexedDB|clientStorage)\b/,
    );
    expect(source).not.toMatch(
      /\b(caches|CacheStorage|serviceWorker)\b|\bdocument\.cookie\b/,
    );
    expect(source).not.toMatch(/\bconsole\s*\./);
    expect(source).not.toMatch(
      /\b(createRectangle|createFrame|createText|createComponent|createPage|setCurrentPageAsync|loadFontAsync)\b/,
    );
    expect(source).not.toMatch(/\bfigma\.currentPage\s*=(?!=)/);
    expect(source).not.toMatch(
      /\b(importVariableByKeyAsync|importComponentByKeyAsync|importComponentSetByKeyAsync|importStyleByKeyAsync|teamLibrary|loadAllPagesAsync|getInstancesAsync|getStyleConsumersAsync|setReactionsAsync|setBoundVariable(?:ForPaint)?|setExplicitVariableModeForCollection|clearExplicitVariableModeForCollection|setProperties|swapComponent|detachInstance)\b/,
    );
    expect(source).not.toMatch(/\b(?:getNodeById|getStyleById)\s*\(/);
  });
});
