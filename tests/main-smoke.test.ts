import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { build } from "esbuild";
import { describe, expect, it, vi } from "vitest";

import { ARCHIVE_SINGLE_ENTRY_BYTE_LIMIT } from "../src/shared/archive";
import { PROTOCOL_VERSION } from "../src/shared/protocol";

async function flushTasks(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("built main-thread shell", () => {
  it("opens the themed UI and reports synthetic document metadata without mutation", async () => {
    const buildResult = await build({
      bundle: true,
      entryPoints: [
        fileURLToPath(new URL("../src/main/code.ts", import.meta.url)),
      ],
      format: "iife",
      platform: "browser",
      target: "es2022",
      write: false,
    });
    const builtCode = buildResult.outputFiles?.[0]?.text;
    expect(builtCode).toBeDefined();
    const showUI = vi.fn();
    const postMessage = vi.fn();
    const callbacks = new Map<string, () => void>();
    const on = vi.fn((event: string, callback: () => void) => {
      callbacks.set(event, callback);
    });
    const closePlugin = vi.fn();
    const figmaApi = {
      closePlugin,
      currentPage: {
        selection: [{ id: "synthetic-selection" }],
      },
      editorType: "figma",
      on,
      pluginId: "1234567890",
      root: {
        children: [{ id: "synthetic-page-1" }, { id: "synthetic-page-2" }],
        name: "Synthetic Shell Fixture",
      },
      showUI,
      ui: {
        onmessage: undefined as ((message: unknown) => void) | undefined,
        postMessage,
      },
    };

    vm.runInNewContext(builtCode ?? "", {
      __html__: "<main>Synthetic inlined UI</main>",
      figma: figmaApi,
    });

    expect(showUI).toHaveBeenCalledWith(
      "<main>Synthetic inlined UI</main>",
      expect.objectContaining({
        height: 600,
        themeColors: true,
        width: 380,
      }),
    );
    expect(on).toHaveBeenCalledWith("selectionchange", expect.any(Function));
    expect(on).toHaveBeenCalledWith("close", expect.any(Function));
    expect(closePlugin).not.toHaveBeenCalled();
    expect(figmaApi.ui.onmessage).toEqual(expect.any(Function));

    figmaApi.ui.onmessage?.({
      type: "initialize-request",
      protocolVersion: PROTOCOL_VERSION,
    });

    expect(postMessage).toHaveBeenCalledWith({
      type: "initialize-result",
      protocolVersion: PROTOCOL_VERSION,
      document: {
        name: "Synthetic Shell Fixture",
        pageCount: 2,
        selectionCount: 1,
      },
      capabilities: {
        exportAvailable: true,
        supportedScopes: ["current-selection", "entire-file"],
      },
      runtime: {
        editorType: "figma",
        pluginId: "1234567890",
      },
    });

    figmaApi.ui.onmessage?.({
      type: "ping-request",
      protocolVersion: PROTOCOL_VERSION,
      requestId: "ping-1",
    });

    expect(postMessage).toHaveBeenLastCalledWith({
      type: "pong-result",
      protocolVersion: PROTOCOL_VERSION,
      requestId: "ping-1",
    });
    const messageCountBeforeClose = postMessage.mock.calls.length;
    callbacks.get("close")?.();
    figmaApi.ui.onmessage?.({
      type: "ping-request",
      protocolVersion: PROTOCOL_VERSION,
      requestId: "ping-after-close",
    });
    expect(postMessage).toHaveBeenCalledTimes(messageCountBeforeClose);
    expect(figmaApi.root.children).toHaveLength(2);
    expect(figmaApi.currentPage.selection).toHaveLength(1);
  });

  it("backpressures archive entries and fails closed on invalid acknowledgements or ready overtaking", async () => {
    const buildResult = await build({
      bundle: true,
      entryPoints: [
        fileURLToPath(new URL("../src/main/code.ts", import.meta.url)),
      ],
      format: "iife",
      platform: "browser",
      target: "es2022",
      write: false,
      plugins: [
        {
          name: "synthetic-export-producer",
          setup(builder) {
            builder.onResolve(
              { filter: /^\.\/export-(?:selection|entire-file)$/ },
              (args) => ({ path: args.path, namespace: "synthetic-export" }),
            );
            builder.onLoad(
              { filter: /.*/, namespace: "synthetic-export" },
              (args) => {
                const entireFile = args.path.endsWith("entire-file");
                const runName = entireFile
                  ? "runEntireFileExport"
                  : "runSelectionExport";
                const classifyName = entireFile
                  ? "classifyEntireFileExportFailure"
                  : "classifySelectionExportFailure";
                const scopeSummary = entireFile
                  ? '{ kind: "entire-file", pageCount: 1 }'
                  : '{ kind: "current-selection", rootCount: 1 }';
                return {
                  loader: "js",
                  contents: `
                    export async function ${runName}(options) {
                      options.postMessage({
                        type: "export-started",
                        protocolVersion: ${PROTOCOL_VERSION},
                        requestId: options.requestId,
                        exportId: options.exportId,
                        scopeSummary: ${scopeSummary},
                      });
                      const first = options.postMessage({
                        type: "archive-entry",
                        protocolVersion: ${PROTOCOL_VERSION},
                        exportId: options.exportId,
                        path: options.snapshotId + "/probe-1.bin",
                        mediaType: "application/octet-stream",
                        compression: "store",
                        data:
                          options.snapshotId === "session-capacity"
                            ? { byteLength: ${ARCHIVE_SINGLE_ENTRY_BYTE_LIMIT + 1} }
                            : options.snapshotId === "session-overtake" ||
                                options.snapshotId === "session-text-cancel"
                              ? "🚲".repeat(140_000)
                              : new Uint8Array([1]),
                      });
                      if (options.snapshotId === "session-overtake") {
                        options.postMessage({
                          type: "export-ready",
                          protocolVersion: ${PROTOCOL_VERSION},
                          exportId: options.exportId,
                          manifestDraft: {},
                          artifacts: [],
                        });
                      }
                      await first;
                      await options.postMessage({
                        type: "archive-entry",
                        protocolVersion: ${PROTOCOL_VERSION},
                        exportId: options.exportId,
                        path: options.snapshotId + "/probe-2.bin",
                        mediaType: "application/octet-stream",
                        compression: "store",
                        data: new Uint8Array([2]),
                      });
                      options.postMessage({
                        type: "export-ready",
                        protocolVersion: ${PROTOCOL_VERSION},
                        exportId: options.exportId,
                        manifestDraft: {},
                        artifacts: [],
                      });
                    }
                    export function ${classifyName}() {
                      return "collection-failed";
                    }
                  `,
                };
              },
            );
          },
        },
      ],
    });
    const builtCode = buildResult.outputFiles?.[0]?.text;
    expect(builtCode).toBeDefined();

    const posted: unknown[] = [];
    const callbacks = new Map<string, () => void>();
    const figmaApi = {
      closePlugin: vi.fn(),
      currentPage: { selection: [] },
      editorType: "figma",
      on: vi.fn((event: string, callback: () => void) => {
        callbacks.set(event, callback);
      }),
      pluginId: "1234567890",
      root: {
        children: [{ id: "synthetic-page-1" }],
        name: "Synthetic Backpressure Fixture",
      },
      showUI: vi.fn(),
      ui: {
        onmessage: undefined as ((message: unknown) => void) | undefined,
        postMessage: (message: unknown) => posted.push(message),
      },
    };

    vm.runInNewContext(builtCode ?? "", {
      __html__: "<main>Synthetic inlined UI</main>",
      figma: figmaApi,
      setTimeout,
    });

    const start = (requestId: string, snapshotId: string): void => {
      figmaApi.ui.onmessage?.({
        type: "start-export",
        protocolVersion: PROTOCOL_VERSION,
        requestId,
        snapshotId,
        scope: "current-selection",
        ownerConfirmedCurrent: true,
      });
    };
    const messagesFor = (exportId: string): Record<string, unknown>[] =>
      posted.filter(
        (message): message is Record<string, unknown> =>
          typeof message === "object" &&
          message !== null &&
          "exportId" in message &&
          message.exportId === exportId,
      );

    start("export-request-1", "session-cancel");
    await flushTasks();
    expect(
      messagesFor("export-000001").filter(
        (message) => message.type === "archive-entry",
      ),
    ).toMatchObject([{ sequence: 1 }]);
    figmaApi.ui.onmessage?.({
      type: "archive-entry-accepted",
      protocolVersion: PROTOCOL_VERSION,
      exportId: "export-999999",
      sequence: 1,
    });
    await flushTasks();
    expect(
      messagesFor("export-000001").filter(
        (message) => message.type === "archive-entry",
      ),
    ).toHaveLength(1);
    figmaApi.ui.onmessage?.({
      type: "cancel-export",
      protocolVersion: PROTOCOL_VERSION,
      exportId: "export-000001",
    });
    await flushTasks();
    expect(messagesFor("export-000001")).toContainEqual(
      expect.objectContaining({ type: "export-cancelled" }),
    );

    start("export-request-2", "session-wrong-ack");
    await flushTasks();
    figmaApi.ui.onmessage?.({
      type: "archive-entry-accepted",
      protocolVersion: PROTOCOL_VERSION,
      exportId: "export-000002",
      sequence: 2,
    });
    await flushTasks();
    expect(
      messagesFor("export-000002").some(
        (message) =>
          message.type === "export-failed" &&
          typeof message.safeError === "object" &&
          message.safeError !== null &&
          "code" in message.safeError &&
          message.safeError.code === "archive-failed",
      ),
    ).toBe(true);
    expect(
      messagesFor("export-000002").filter(
        (message) => message.type === "archive-entry",
      ),
    ).toHaveLength(1);

    start("export-request-3", "session-overtake");
    await flushTasks();
    expect(
      messagesFor("export-000003").some(
        (message) =>
          message.type === "export-failed" &&
          typeof message.safeError === "object" &&
          message.safeError !== null &&
          "code" in message.safeError &&
          message.safeError.code === "archive-failed",
      ),
    ).toBe(true);
    expect(
      messagesFor("export-000003").some(
        (message) => message.type === "export-ready",
      ),
    ).toBe(false);
    expect(
      messagesFor("export-000003").some(
        (message) => message.type === "archive-entry",
      ),
    ).toBe(false);

    start("export-request-4", "session-success");
    await flushTasks();
    expect(
      messagesFor("export-000004").filter(
        (message) => message.type === "archive-entry",
      ),
    ).toMatchObject([{ sequence: 1 }]);
    figmaApi.ui.onmessage?.({
      type: "archive-entry-accepted",
      protocolVersion: PROTOCOL_VERSION,
      exportId: "export-000004",
      sequence: 1,
    });
    await flushTasks();
    expect(
      messagesFor("export-000004").filter(
        (message) => message.type === "archive-entry",
      ),
    ).toMatchObject([{ sequence: 1 }, { sequence: 2 }]);
    expect(
      messagesFor("export-000004").some(
        (message) => message.type === "export-ready",
      ),
    ).toBe(false);
    figmaApi.ui.onmessage?.({
      type: "archive-entry-accepted",
      protocolVersion: PROTOCOL_VERSION,
      exportId: "export-000004",
      sequence: 2,
    });
    await flushTasks();
    expect(
      messagesFor("export-000004").some(
        (message) => message.type === "export-ready",
      ),
    ).toBe(true);

    start("export-request-5", "session-capacity");
    await flushTasks();
    expect(
      messagesFor("export-000005").some(
        (message) =>
          message.type === "export-failed" &&
          typeof message.safeError === "object" &&
          message.safeError !== null &&
          "code" in message.safeError &&
          message.safeError.code === "archive-capacity-exceeded",
      ),
    ).toBe(true);
    expect(
      messagesFor("export-000005").some(
        (message) =>
          message.type === "archive-entry" || message.type === "export-ready",
      ),
    ).toBe(false);

    start("export-request-6", "session-text-cancel");
    figmaApi.ui.onmessage?.({
      type: "cancel-export",
      protocolVersion: PROTOCOL_VERSION,
      exportId: "export-000006",
    });
    await flushTasks();
    expect(messagesFor("export-000006")).toContainEqual(
      expect.objectContaining({ type: "export-cancelled" }),
    );
    expect(
      messagesFor("export-000006").some(
        (message) =>
          message.type === "archive-entry" || message.type === "export-ready",
      ),
    ).toBe(false);
    expect(callbacks.has("close")).toBe(true);
  });
});
