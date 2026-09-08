import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { build } from "esbuild";
import { describe, expect, it, vi } from "vitest";

import { DIAGNOSTIC_CODES } from "../src/shared/diagnostics";
import { PROTOCOL_VERSION } from "../src/shared/protocol";

const SYNTHETIC_TEXT = "Пример 中文 e\u0301 🚀 “quoted” —";
const SYNTHETIC_FIRST_RUN = "Пример";
const SYNTHETIC_RUN_SPLIT = SYNTHETIC_FIRST_RUN.length;
// Locally generated one-pixel fixture bytes, invented only for this repository.
const SYNTHETIC_PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ),
);

interface PostedMessage {
  readonly type: string;
  readonly protocolVersion?: number;
  readonly exportId?: string;
  readonly sequence?: number;
  readonly path?: string;
  readonly mediaType?: string;
  readonly compression?: "deflate" | "store";
  readonly data?: string | Uint8Array;
  readonly artifacts?: readonly {
    readonly path: string;
    readonly status?: "emitted" | "unavailable";
  }[];
}

interface SelectionRecoveryRuntime {
  readonly runSelectionExport: (options: {
    readonly exportId: string;
    readonly requestId: string;
    readonly snapshotId: string;
    readonly cancellation: {
      readonly cancelled: boolean;
      cancel(): void;
      throwIfCancelled(): void;
    };
    readonly optionalArtifactByteLimit?: number;
    readonly exportedAtUtc?: string;
    readonly componentScope?: "used" | "reachable";
    readonly postMessage: (message: PostedMessage) => void;
  }) => Promise<void>;
  readonly ExportCancellationToken: new () => {
    readonly cancelled: boolean;
    cancel(): void;
    throwIfCancelled(): void;
  };
}

function requireJsonEntry(
  messages: readonly PostedMessage[],
  path: string,
): Record<string, unknown> {
  const message = messages.find(
    (candidate) =>
      candidate.type === "archive-entry" && candidate.path === path,
  );
  if (message === undefined || typeof message.data !== "string") {
    throw new Error(`Missing invented JSON entry: ${path}`);
  }
  return JSON.parse(message.data) as Record<string, unknown>;
}

function requireTextEntry(
  messages: readonly PostedMessage[],
  path: string,
): string {
  const message = messages.find(
    (candidate) =>
      candidate.type === "archive-entry" && candidate.path === path,
  );
  if (message === undefined || typeof message.data !== "string") {
    throw new Error(`Missing invented text entry: ${path}`);
  }
  return message.data;
}

describe("Current-selection export orchestration", () => {
  it("emits enriched roots and mandatory deterministic design-system indexes from the synthetic document", async () => {
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

    const mixed = Symbol("invented-mixed");
    const variableId = "variable:accent";
    const collectionId = "collection:theme";
    const paintStyleId = "style:paint";
    const textStyleId = "style:text";
    const componentOnlyStyleId = "style:component-only";
    const documentNode: Record<string, unknown> = {
      id: "document:synthetic",
      name: "Invented Selection Document",
      type: "DOCUMENT",
      parent: null,
      children: [] as unknown[],
    };
    const pageNode: Record<string, unknown> = {
      id: "page:synthetic",
      name: "Invented Selection Page",
      type: "PAGE",
      parent: documentNode,
      children: [] as unknown[],
      selection: [] as unknown[],
    };
    const textNode: Record<string, unknown> = {
      id: "node:text",
      name: "Invented Mixed Text",
      type: "TEXT",
      visible: true,
      locked: false,
      characters: SYNTHETIC_TEXT,
      parent: null,
      textStyleId,
      fillStyleId: paintStyleId,
      hasMissingFont: false,
      annotations: [
        {
          labelMarkdown: "Invented **annotation**",
          categoryId: "category:invented",
          properties: [{ type: "fontSize" }],
        },
      ],
      getStyledTextSegments: () => [
        {
          start: 0,
          end: SYNTHETIC_RUN_SPLIT,
          characters: SYNTHETIC_FIRST_RUN,
          fontName: { family: "Invented Sans", style: "Regular" },
          fontSize: 18,
          fontWeight: 400,
          fontStyle: "Regular",
          textDecoration: "UNDERLINE",
          textDecorationStyle: "SOLID",
          textDecorationOffset: { unit: "PIXELS", value: 1 },
          textDecorationThickness: { unit: "PIXELS", value: 1 },
          textDecorationColor: { r: 0.1, g: 0.2, b: 0.3, a: 1 },
          textDecorationSkipInk: true,
          textCase: "ORIGINAL",
          lineHeight: { unit: "PIXELS", value: 24 },
          letterSpacing: { unit: "PIXELS", value: 0.5 },
          fills: [],
          textStyleId,
          fillStyleId: paintStyleId,
          listOptions: { type: "NONE" },
          listSpacing: 2,
          indentation: 0,
          paragraphIndent: 0,
          paragraphSpacing: 4,
          hyperlink: null,
          boundVariables: {
            fontSize: { type: "VARIABLE_ALIAS", id: variableId },
          },
          textStyleOverrides: [{ type: "SEMANTIC_WEIGHT" }],
          openTypeFeatures: {},
        },
        {
          start: SYNTHETIC_RUN_SPLIT,
          end: SYNTHETIC_TEXT.length,
          characters: SYNTHETIC_TEXT.slice(SYNTHETIC_RUN_SPLIT),
          fontName: { family: "Invented Sans", style: "Bold" },
          fontSize: 20,
          fontWeight: 700,
          fontStyle: "Bold",
          textDecoration: "NONE",
          textCase: "UPPER",
          lineHeight: { unit: "PIXELS", value: 28 },
          letterSpacing: { unit: "PIXELS", value: 1 },
          fills: [],
          textStyleId,
          fillStyleId: paintStyleId,
          listOptions: { type: "NONE" },
          listSpacing: 3,
          indentation: 0,
          paragraphIndent: 0,
          paragraphSpacing: 6,
          hyperlink: null,
          boundVariables: {},
          textStyleOverrides: [],
          openTypeFeatures: { liga: false },
        },
      ],
    };
    const componentChild: Record<string, unknown> = {
      id: "node:component-child",
      name: "Invented Definition Child",
      type: "RECTANGLE",
      visible: true,
      locked: false,
      parent: null,
      fillStyleId: componentOnlyStyleId,
      exportAsync: vi.fn(() =>
        Promise.resolve('<svg viewBox="0 0 8 8"><path d="M0 0L8 8Z"/></svg>'),
      ),
    };
    const externalComponent: Record<string, unknown> = {
      id: "component:external",
      name: "Invented External Definition",
      type: "COMPONENT",
      key: "key:external-component",
      remote: false,
      visible: true,
      locked: false,
      parent: pageNode,
      variantProperties: null,
      componentPropertyDefinitions: {},
      componentPropertyReferences: null,
      documentationLinks: [],
      description: "Invented definition outside the selected subtree.",
      descriptionMarkdown: "Invented **external** definition.",
      children: [componentChild],
      exportAsync: vi.fn((settings: { readonly format: string }) =>
        Promise.resolve(
          settings.format === "JSON_REST_V1"
            ? {
                id: "component:external",
                name: "Invented External Definition",
              }
            : SYNTHETIC_PNG,
        ),
      ),
    };
    componentChild.parent = externalComponent;
    const selectedInstance: Record<string, unknown> = {
      id: "instance:selected",
      name: "Invented Linked Instance",
      type: "INSTANCE",
      visible: true,
      locked: false,
      parent: null,
      componentProperties: {},
      componentPropertyReferences: null,
      overrides: [],
      exposedInstances: [],
      scaleFactor: 1,
      getMainComponentAsync: () => Promise.resolve(externalComponent),
      children: [],
    };
    const rootNode: Record<string, unknown> = {
      id: "node:root",
      name: "Invented Selection Root",
      type: "FRAME",
      visible: true,
      locked: false,
      removed: false,
      parent: pageNode,
      children: [textNode, selectedInstance],
      absoluteRenderBounds: { x: 0, y: 0, width: 100, height: 80 },
      absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 80 },
      fillStyleId: paintStyleId,
      fills: [
        {
          type: "IMAGE",
          imageHash: "image:synthetic-media",
          scaleMode: "FILL",
          visible: true,
          opacity: 1,
        },
      ],
      explicitVariableModes: { [collectionId]: "mode:dark" },
      resolvedVariableModes: { [collectionId]: "mode:dark" },
      boundVariables: {
        opacity: { type: "VARIABLE_ALIAS", id: variableId },
      },
      reactions: [
        {
          trigger: null,
          actions: [
            {
              type: "URL",
              url: "https://synthetic.invalid/invented-only",
              openInNewTab: true,
            },
            {
              type: "SET_VARIABLE",
              variableId,
              variableValue: {
                type: "FLOAT",
                resolvedType: "FLOAT",
                value: 0.75,
              },
            },
            {
              type: "SYNTHETIC_FUTURE_ACTION",
              payload: { invented: true },
            },
          ],
        },
      ],
      exportAsync: vi.fn((settings: { readonly format: string }) =>
        Promise.resolve(
          settings.format === "JSON_REST_V1"
            ? {
                id: "node:root",
                name: "Invented Selection Root",
                characters: SYNTHETIC_TEXT,
              }
            : SYNTHETIC_PNG,
        ),
      ),
    };
    textNode.parent = rootNode;
    selectedInstance.parent = rootNode;
    (pageNode.children as unknown[]).push(rootNode, externalComponent);
    (pageNode.selection as unknown[]).push(rootNode);
    (documentNode.children as unknown[]).push(pageNode);

    const collection = {
      id: collectionId,
      name: "Invented Theme",
      key: "key:invented-theme",
      remote: false,
      hiddenFromPublishing: false,
      isExtension: false,
      defaultModeId: "mode:light",
      modes: [
        { modeId: "mode:light", name: "Invented Light" },
        { modeId: "mode:dark", name: "Invented Dark" },
      ],
      variableIds: [variableId],
      getPublishStatusAsync: () => Promise.resolve("CURRENT"),
    };
    const variable = {
      id: variableId,
      name: "Invented Accent",
      key: "key:invented-accent",
      remote: false,
      variableCollectionId: collectionId,
      resolvedType: "FLOAT",
      description: "Invented scalar value.",
      scopes: ["OPACITY"],
      codeSyntax: { WEB: "--invented-accent" },
      hiddenFromPublishing: false,
      valuesByMode: { "mode:light": 0.75, "mode:dark": 0.5 },
      getPublishStatusAsync: () => Promise.resolve("CURRENT"),
    };
    const paintStyle = {
      id: paintStyleId,
      key: "key:invented-paint",
      name: "Invented Paint",
      remote: false,
      type: "PAINT",
      description: "Invented paint style.",
      descriptionMarkdown: "Invented **paint** style.",
      documentationLinks: [],
      paints: [
        {
          type: "SOLID",
          visible: true,
          opacity: 1,
          color: { r: 0.1, g: 0.2, b: 0.3 },
          boundVariables: {
            opacity: { type: "VARIABLE_ALIAS", id: variableId },
          },
        },
      ],
    };
    const textStyle = {
      id: textStyleId,
      key: "key:invented-text",
      name: "Invented Text",
      remote: false,
      type: "TEXT",
      description: "Invented text style.",
      descriptionMarkdown: "Invented **text** style.",
      documentationLinks: [],
      fontSize: 18,
      fontName: { family: "Invented Sans", style: "Regular" },
      textDecoration: "NONE",
      letterSpacing: { unit: "PIXELS", value: 0 },
      lineHeight: { unit: "PIXELS", value: 24 },
      leadingTrim: "NONE",
      paragraphIndent: 0,
      paragraphSpacing: 4,
      listSpacing: 2,
      hangingPunctuation: false,
      hangingList: false,
      textCase: "ORIGINAL",
    };
    const componentOnlyStyle = {
      id: componentOnlyStyleId,
      key: "key:component-only-style",
      name: "Invented Component-only Remote Style",
      remote: true,
      type: "PAINT",
      description: "Invented accessible referenced style.",
      descriptionMarkdown: "Invented referenced style.",
      documentationLinks: [],
      paints: [
        {
          type: "SOLID",
          visible: true,
          opacity: 1,
          color: { r: 0.4, g: 0.5, b: 0.6 },
        },
      ],
    };

    const posted: PostedMessage[] = [];
    const uiMessageHandler: {
      current: ((message: unknown) => void) | undefined;
    } = { current: undefined };
    const figmaApi = {
      closePlugin: vi.fn(),
      currentPage: pageNode,
      editorType: "figma",
      getLocalEffectStylesAsync: () => Promise.resolve([]),
      getLocalGridStylesAsync: () => Promise.resolve([]),
      getLocalPaintStylesAsync: () => Promise.resolve([paintStyle]),
      getLocalTextStylesAsync: () => Promise.resolve([textStyle]),
      getImageByHash: (hash: string) =>
        hash === "image:synthetic-media"
          ? { getBytesAsync: () => Promise.resolve(SYNTHETIC_PNG) }
          : null,
      getNodeByIdAsync: () => Promise.resolve(null),
      getStyleByIdAsync: (id: string) =>
        Promise.resolve(
          id === componentOnlyStyleId ? componentOnlyStyle : null,
        ),
      mixed,
      on: vi.fn(),
      pluginId: "1234567890",
      root: documentNode,
      showUI: vi.fn(),
      ui: {
        onmessage: undefined as ((message: unknown) => void) | undefined,
        postMessage: (message: PostedMessage) => {
          posted.push(message);
          if (
            message.type === "archive-entry" &&
            typeof message.exportId === "string" &&
            typeof message.sequence === "number"
          ) {
            queueMicrotask(() => {
              uiMessageHandler.current?.({
                type: "archive-entry-accepted",
                protocolVersion: PROTOCOL_VERSION,
                exportId: message.exportId,
                sequence: message.sequence,
              });
            });
          }
        },
      },
      variables: {
        getLocalVariableCollectionsAsync: () => Promise.resolve([collection]),
        getLocalVariablesAsync: () => Promise.resolve([variable]),
        getVariableByIdAsync: (id: string) =>
          Promise.resolve(id === variableId ? variable : null),
        getVariableCollectionByIdAsync: (id: string) =>
          Promise.resolve(id === collectionId ? collection : null),
      },
    };

    const executeBundle = vm.compileFunction(builtCode ?? "", [
      "__html__",
      "figma",
    ]) as (html: string, api: typeof figmaApi) => void;
    executeBundle("<main>Invented inlined UI</main>", figmaApi);
    uiMessageHandler.current = figmaApi.ui.onmessage;
    figmaApi.ui.onmessage?.({
      type: "start-export",
      protocolVersion: PROTOCOL_VERSION,
      requestId: "selection-request",
      snapshotId: "selection-export",
      scope: "current-selection",
      ownerConfirmedCurrent: true,
    });

    await vi.waitFor(
      () => {
        expect(posted.some((message) => message.type === "export-ready")).toBe(
          true,
        );
      },
      { timeout: 5_000 },
    );
    expect(posted.some((message) => message.type === "export-failed")).toBe(
      false,
    );
    const archiveEntrySequences = posted.flatMap((message) =>
      message.type === "archive-entry" && message.sequence !== undefined
        ? [message.sequence]
        : [],
    );
    expect(archiveEntrySequences).toEqual(
      archiveEntrySequences.map((_, index) => index + 1),
    );

    const root = requireJsonEntry(
      posted,
      "selection-export/ir/nodes/roots/node%3Aroot.json",
    );
    const document = requireJsonEntry(
      posted,
      "selection-export/ir/document.json",
    );
    const variables = requireJsonEntry(
      posted,
      "selection-export/ir/variables.json",
    );
    const styles = requireJsonEntry(posted, "selection-export/ir/styles.json");
    const components = requireJsonEntry(
      posted,
      "selection-export/ir/components.json",
    );
    const componentDefinition = requireJsonEntry(
      posted,
      "selection-export/ir/components/definitions/component%3Aexternal.json",
    );
    const diagnosticArtifact = requireJsonEntry(
      posted,
      "selection-export/diagnostics.json",
    );
    const agentIndex = requireTextEntry(
      posted,
      "selection-export/agent/index.md",
    );
    const componentMarkdown = requireTextEntry(
      posted,
      "selection-export/agent/components/component%3Aexternal.md",
    );
    const pageMarkdown = requireTextEntry(
      posted,
      "selection-export/agent/pages/page%3Asynthetic.md",
    );

    expect(agentIndex).toContain("## Snapshot identity and completeness");
    expect(agentIndex.replaceAll("\\", "")).toContain(
      `Completeness: ${String((diagnosticArtifact.summary as { completeness: string }).completeness)}`,
    );
    expect(componentMarkdown).toContain("canonical component definition");
    expect(componentMarkdown).toContain(
      "../../ir/components/definitions/component%3Aexternal.json",
    );
    expect(pageMarkdown).toContain("../../ir/nodes/roots/node%3Aroot.json");

    expect(root).toMatchObject({
      assets: [
        {
          assetKind: "raster",
          imageHash: "image:synthetic-media",
          mediaType: "image/png",
          byteLength: SYNTHETIC_PNG.byteLength,
        },
      ],
      reactions: [
        {
          trigger: null,
          actions: [
            { actionType: "url", openInNewTab: true },
            {
              actionType: "set-variable",
              value: {
                type: "FLOAT",
                resolvedType: "FLOAT",
                value: 0.75,
              },
            },
            {
              actionType: "unknown",
              raw: {
                type: "SYNTHETIC_FUTURE_ACTION",
                payload: { invented: true },
              },
            },
          ],
        },
      ],
      coverage: {
        dependencies: { status: "collected" },
        reactions: { status: "collected" },
        assets: { status: "collected" },
        textSegments: { status: "collected" },
        annotationsAndAccessibility: { status: "collected" },
      },
      normalizedTree: {
        family: "container",
        explicitVariableModes: [{ collectionId, modeId: "mode:dark" }],
        resolvedVariableModes: [{ collectionId, modeId: "mode:dark" }],
        children: [
          {
            family: "text",
            annotations: [
              {
                labelMarkdown: "Invented **annotation**",
                categoryId: "category:invented",
              },
            ],
            text: {
              characters: SYNTHETIC_TEXT,
              segments: [
                {
                  start: 0,
                  end: SYNTHETIC_RUN_SPLIT,
                  characters: SYNTHETIC_FIRST_RUN,
                  fontStyle: "Regular",
                  fillStyle: { kind: "style", id: paintStyleId },
                  textStyleOverrides: [{ type: "SEMANTIC_WEIGHT" }],
                },
                {
                  start: SYNTHETIC_RUN_SPLIT,
                  end: SYNTHETIC_TEXT.length,
                  characters: SYNTHETIC_TEXT.slice(SYNTHETIC_RUN_SPLIT),
                  fontStyle: "Bold",
                  fontWeight: 700,
                  fillStyle: { kind: "style", id: paintStyleId },
                  textStyleOverrides: [],
                },
              ],
            },
          },
          {
            family: "instance",
            source: { id: "instance:selected" },
            instanceData: {
              metadataCoverage: { status: "collected" },
              mainComponent: { id: "component:external" },
            },
          },
        ],
      },
    });
    const collectedSegments = (
      root as {
        readonly normalizedTree: {
          readonly children: readonly {
            readonly text: {
              readonly segments: readonly { readonly characters: string }[];
            };
          }[];
        };
      }
    ).normalizedTree.children[0]?.text.segments;
    expect(
      collectedSegments?.map((segment) => segment.characters).join(""),
    ).toBe(SYNTHETIC_TEXT);
    const exportedDiagnostics = diagnosticArtifact.diagnostics as readonly {
      readonly code: string;
      readonly causedDataLoss: boolean;
    }[];
    expect(exportedDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: DIAGNOSTIC_CODES.interactionUnsupportedAction,
          causedDataLoss: false,
        }),
      ]),
    );
    expect(document).toMatchObject({
      counts: {
        localVariables: {
          status: "collected",
          value: 1,
          coverage: "file-local",
        },
        localStyles: {
          status: "collected",
          value: 2,
          coverage: "file-local",
        },
        localComponents: {
          status: "collected",
          value: 1,
          coverage: "selected-reachable",
        },
      },
      artifacts: {
        variables: {
          path: "selection-export/ir/variables.json",
          mediaType: "application/json",
        },
        styles: {
          path: "selection-export/ir/styles.json",
          mediaType: "application/json",
        },
        components: {
          path: "selection-export/ir/components.json",
          mediaType: "application/json",
        },
      },
    });
    expect(variables).toMatchObject({
      kind: "design-ir-variables",
      variables: [{ publishStatus: "CURRENT" }],
    });
    expect(styles).toMatchObject({
      kind: "design-ir-styles",
      styles: [
        { source: { id: componentOnlyStyleId, remote: true } },
        { source: { id: paintStyleId } },
        { source: { id: textStyleId } },
      ],
    });
    expect(components).toMatchObject({
      kind: "design-ir-components",
      definitions: [
        {
          source: { id: "component:external", remote: false },
          definitionArtifact: {
            path: "selection-export/ir/components/definitions/component%3Aexternal.json",
            mediaType: "application/json",
          },
        },
      ],
    });
    expect(componentDefinition).toMatchObject({
      kind: "design-ir-component-definition",
      source: { id: "component:external" },
      assets: [],
      coverage: {
        assets: {
          status: "not-collected",
        },
      },
      normalizedTree: {
        family: "component",
        page: { id: "page:synthetic" },
        children: [
          {
            source: { id: "node:component-child" },
            visual: {
              fillStyle: { id: componentOnlyStyleId, kind: "style" },
            },
          },
        ],
      },
    });
    expect(
      (
        componentDefinition.normalizedTree as {
          readonly children: readonly {
            readonly assetRefs: readonly unknown[];
          }[];
        }
      ).children[0]?.assetRefs,
    ).toEqual([]);
    const ready = posted.find((message) => message.type === "export-ready");
    const artifactPaths = new Set(
      ready?.artifacts?.map((artifact) => artifact.path),
    );
    for (const path of [
      "selection-export/ir/variables.json",
      "selection-export/ir/styles.json",
      "selection-export/ir/components.json",
      "selection-export/ir/components/definitions/component%3Aexternal.json",
      "selection-export/raw/rest-v1/components/component%3Aexternal.json",
      "selection-export/assets/raster/431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460.png",
    ]) {
      expect(artifactPaths).toContain(path);
    }

    // Binary assets come from the selected roots only: the vector child of
    // the component definition is never exported, and no unavailable vector
    // requirement is recorded for it either.
    expect(
      [...artifactPaths].filter((path) => path.includes("/assets/vector/")),
    ).toEqual([]);
    const vectorEntries = posted.filter((message) =>
      message.path?.includes("/assets/vector/"),
    );
    expect(vectorEntries).toEqual([]);

    const rasterEntry = posted.find((message) =>
      message.path?.includes("/assets/raster/"),
    );
    expect(rasterEntry).toMatchObject({
      mediaType: "image/png",
      compression: "store",
      data: SYNTHETIC_PNG,
    });
    expect(JSON.stringify(root)).not.toContain("base64");

    expect((pageNode.children as unknown[])[0]).toBe(rootNode);
    expect((rootNode.children as unknown[])[0]).toBe(textNode);
    expect(textNode.characters).toBe(SYNTHETIC_TEXT);

    const originalExportAsync = rootNode.exportAsync;
    const oversizedPreview = new Uint8Array(129);
    oversizedPreview.set(SYNTHETIC_PNG);
    rootNode.exportAsync = vi.fn((settings: { readonly format: string }) =>
      Promise.resolve(
        settings.format === "JSON_REST_V1"
          ? { id: "node:root", large: "x".repeat(256) }
          : oversizedPreview,
      ),
    );
    const recoveryPosted: PostedMessage[] = [];
    const previousFigma = Object.getOwnPropertyDescriptor(globalThis, "figma");
    Object.defineProperty(globalThis, "figma", {
      configurable: true,
      writable: true,
      value: figmaApi,
    });
    try {
      const selectionExportPath = fileURLToPath(
        new URL("../src/main/export-selection.ts", import.meta.url),
      );
      const cancellationPath = fileURLToPath(
        new URL("../src/main/cancellation.ts", import.meta.url),
      );
      const recoveryBundle = await build({
        bundle: true,
        stdin: {
          contents: [
            `export { runSelectionExport } from ${JSON.stringify(selectionExportPath)};`,
            `export { ExportCancellationToken } from ${JSON.stringify(cancellationPath)};`,
          ].join("\n"),
          loader: "ts",
          resolveDir: fileURLToPath(new URL("..", import.meta.url)),
        },
        format: "esm",
        platform: "node",
        target: "es2022",
        write: false,
      });
      const recoverySource = recoveryBundle.outputFiles?.[0]?.text;
      if (recoverySource === undefined) {
        throw new Error(
          "The invented selection recovery bundle was not produced.",
        );
      }
      const recoveryRuntime = (await import(
        `data:text/javascript;base64,${Buffer.from(recoverySource).toString("base64")}`
      )) as SelectionRecoveryRuntime;
      await recoveryRuntime.runSelectionExport({
        exportId: "export:selection-oversize",
        requestId: "request:selection-oversize",
        snapshotId: "selection-oversize",
        cancellation: new recoveryRuntime.ExportCancellationToken(),
        optionalArtifactByteLimit: 128,
        exportedAtUtc: "2026-08-15T00:00:00.000Z",
        postMessage: (message) => {
          recoveryPosted.push(message);
        },
      });
    } finally {
      rootNode.exportAsync = originalExportAsync;
      if (previousFigma === undefined) {
        Reflect.deleteProperty(globalThis, "figma");
      } else {
        Object.defineProperty(globalThis, "figma", previousFigma);
      }
    }
    const recoveryReady = recoveryPosted.find(
      (message) => message.type === "export-ready",
    );
    const unavailablePaths = recoveryReady?.artifacts
      ?.filter((artifact) => artifact.status === "unavailable")
      .map((artifact) => artifact.path);
    expect(unavailablePaths).toEqual(
      expect.arrayContaining([
        "selection-oversize/raw/rest-v1/roots/node%3Aroot.json",
        "selection-oversize/previews/node%3Aroot.png",
      ]),
    );
    expect(
      recoveryPosted.some(
        (message) =>
          message.type === "archive-entry" &&
          (message.path?.includes("/raw/rest-v1/roots/node%3Aroot.json") ??
            false),
      ),
    ).toBe(false);
    expect(
      recoveryPosted.some(
        (message) =>
          message.type === "archive-entry" &&
          (message.path?.includes("/previews/node%3Aroot.png") ?? false),
      ),
    ).toBe(false);
    const recoveryDiagnostics = requireJsonEntry(
      recoveryPosted,
      "selection-oversize/diagnostics.json",
    ).diagnostics as readonly Record<string, unknown>[];
    expect(
      recoveryDiagnostics.filter(
        (diagnostic) =>
          diagnostic.code === DIAGNOSTIC_CODES.archiveEntryTooLarge,
      ),
    ).toHaveLength(2);
  });

  it("exports definition and style assets when componentScope is reachable", async () => {
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

    const paintStyleId = "style:paint";
    const documentNode: Record<string, unknown> = {
      id: "document:synthetic",
      name: "Invented Reachable Document",
      type: "DOCUMENT",
      parent: null,
      children: [] as unknown[],
    };
    const pageNode: Record<string, unknown> = {
      id: "page:synthetic",
      name: "Invented Reachable Page",
      type: "PAGE",
      parent: documentNode,
      children: [] as unknown[],
      selection: [] as unknown[],
    };
    const componentChild: Record<string, unknown> = {
      id: "node:component-child",
      name: "Invented Definition Child",
      type: "RECTANGLE",
      visible: true,
      locked: false,
      parent: null,
      exportAsync: vi.fn(() =>
        Promise.resolve('<svg viewBox="0 0 8 8"><path d="M0 0L8 8Z"/></svg>'),
      ),
    };
    const externalComponent: Record<string, unknown> = {
      id: "component:external",
      name: "Invented External Definition",
      type: "COMPONENT",
      key: "key:external-component",
      remote: false,
      visible: true,
      locked: false,
      parent: pageNode,
      variantProperties: null,
      componentPropertyDefinitions: {},
      componentPropertyReferences: null,
      documentationLinks: [],
      description: "Invented definition outside the selected subtree.",
      descriptionMarkdown: "Invented **external** definition.",
      children: [componentChild],
      exportAsync: vi.fn((settings: { readonly format: string }) =>
        Promise.resolve(
          settings.format === "JSON_REST_V1"
            ? { id: "component:external" }
            : SYNTHETIC_PNG,
        ),
      ),
    };
    componentChild.parent = externalComponent;
    const selectedInstance: Record<string, unknown> = {
      id: "instance:selected",
      name: "Invented Linked Instance",
      type: "INSTANCE",
      visible: true,
      locked: false,
      parent: null,
      componentProperties: {},
      componentPropertyReferences: null,
      overrides: [],
      exposedInstances: [],
      scaleFactor: 1,
      getMainComponentAsync: () => Promise.resolve(externalComponent),
      children: [],
    };
    const rootNode: Record<string, unknown> = {
      id: "node:root",
      name: "Invented Reachable Root",
      type: "FRAME",
      visible: true,
      locked: false,
      removed: false,
      parent: pageNode,
      children: [selectedInstance],
      absoluteRenderBounds: { x: 0, y: 0, width: 100, height: 80 },
      absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 80 },
      fillStyleId: paintStyleId,
      fills: [],
      exportAsync: vi.fn((settings: { readonly format: string }) =>
        Promise.resolve(
          settings.format === "JSON_REST_V1"
            ? { id: "node:root" }
            : SYNTHETIC_PNG,
        ),
      ),
    };
    selectedInstance.parent = rootNode;
    (pageNode.children as unknown[]).push(rootNode, externalComponent);
    (pageNode.selection as unknown[]).push(rootNode);
    (documentNode.children as unknown[]).push(pageNode);

    const paintStyle = {
      id: paintStyleId,
      key: "key:invented-paint",
      name: "Invented Paint",
      remote: false,
      type: "PAINT",
      description: "",
      descriptionMarkdown: "",
      documentationLinks: [],
      paints: [
        {
          type: "IMAGE",
          imageHash: "image:style-media",
          scaleMode: "FILL",
          visible: true,
          opacity: 1,
        },
      ],
    };

    const posted: PostedMessage[] = [];
    const uiMessageHandler: {
      current: ((message: unknown) => void) | undefined;
    } = { current: undefined };
    const figmaApi = {
      closePlugin: vi.fn(),
      currentPage: pageNode,
      editorType: "figma",
      getLocalEffectStylesAsync: () => Promise.resolve([]),
      getLocalGridStylesAsync: () => Promise.resolve([]),
      getLocalPaintStylesAsync: () => Promise.resolve([paintStyle]),
      getLocalTextStylesAsync: () => Promise.resolve([]),
      getImageByHash: () => ({
        getBytesAsync: () => Promise.resolve(SYNTHETIC_PNG),
      }),
      getNodeByIdAsync: () => Promise.resolve(null),
      getStyleByIdAsync: (id: string) =>
        Promise.resolve(id === paintStyleId ? paintStyle : null),
      mixed: Symbol("invented-mixed"),
      on: vi.fn(),
      pluginId: "1234567890",
      root: documentNode,
      showUI: vi.fn(),
      ui: {
        onmessage: undefined as ((message: unknown) => void) | undefined,
        postMessage: (message: PostedMessage) => {
          posted.push(message);
          if (
            message.type === "archive-entry" &&
            typeof message.exportId === "string" &&
            typeof message.sequence === "number"
          ) {
            queueMicrotask(() => {
              uiMessageHandler.current?.({
                type: "archive-entry-accepted",
                protocolVersion: PROTOCOL_VERSION,
                exportId: message.exportId,
                sequence: message.sequence,
              });
            });
          }
        },
      },
      variables: {
        getLocalVariableCollectionsAsync: () => Promise.resolve([]),
        getLocalVariablesAsync: () => Promise.resolve([]),
        getVariableByIdAsync: () => Promise.resolve(null),
        getVariableCollectionByIdAsync: () => Promise.resolve(null),
      },
    };

    const previousFigma = Object.getOwnPropertyDescriptor(globalThis, "figma");
    Object.defineProperty(globalThis, "figma", {
      configurable: true,
      writable: true,
      value: figmaApi,
    });
    try {
      const selectionExportPath = fileURLToPath(
        new URL("../src/main/export-selection.ts", import.meta.url),
      );
      const cancellationPath = fileURLToPath(
        new URL("../src/main/cancellation.ts", import.meta.url),
      );
      const reachableBundle = await build({
        bundle: true,
        stdin: {
          contents: [
            `export { runSelectionExport } from ${JSON.stringify(selectionExportPath)};`,
            `export { ExportCancellationToken } from ${JSON.stringify(cancellationPath)};`,
          ].join("\n"),
          loader: "ts",
          resolveDir: fileURLToPath(new URL("..", import.meta.url)),
        },
        format: "esm",
        platform: "node",
        target: "es2022",
        write: false,
      });
      const reachableSource = reachableBundle.outputFiles?.[0]?.text;
      if (reachableSource === undefined) {
        throw new Error("The reachable bundle was not produced.");
      }
      const reachableRuntime = (await import(
        `data:text/javascript;base64,${Buffer.from(reachableSource).toString("base64")}`
      )) as SelectionRecoveryRuntime;
      await reachableRuntime.runSelectionExport({
        exportId: "export:selection-reachable",
        requestId: "request:selection-reachable",
        snapshotId: "selection-reachable",
        cancellation: new reachableRuntime.ExportCancellationToken(),
        componentScope: "reachable",
        exportedAtUtc: "2026-08-15T00:00:00.000Z",
        postMessage: (message) => {
          posted.push(message);
        },
      });
    } finally {
      if (previousFigma === undefined) {
        Reflect.deleteProperty(globalThis, "figma");
      } else {
        Object.defineProperty(globalThis, "figma", previousFigma);
      }
    }

    expect(posted.some((message) => message.type === "export-failed")).toBe(
      false,
    );
    const ready = posted.find((message) => message.type === "export-ready");
    expect(ready).toBeDefined();
    const artifactPaths = new Set(
      ready?.artifacts
        ?.filter((artifact) => artifact.status === "emitted")
        .map((artifact) => artifact.path) ?? [],
    );
    // Reachable scope exports the definition's vector child and paint-style
    // raster bytes on top of the used-scope baseline.
    expect(
      artifactPaths.has(
        "selection-reachable/assets/vector/node%3Acomponent-child.svg",
      ),
    ).toBe(true);
    expect(
      posted.some(
        (message) =>
          message.type === "archive-entry" &&
          message.path ===
            "selection-reachable/assets/raster/431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460.png",
      ),
    ).toBe(true);
    const componentDefinition = requireJsonEntry(
      posted,
      "selection-reachable/ir/components/definitions/component%3Aexternal.json",
    );
    expect(
      (componentDefinition.assets as readonly Record<string, unknown>[]).some(
        (asset) => asset.assetKind === "vector",
      ),
    ).toBe(true);
    expect(
      (componentDefinition.coverage as Record<string, unknown>).assets,
    ).toEqual({ status: "collected" });
    // The used-scope-only limitation text is replaced by the reachable one.
    const document = requireJsonEntry(
      posted,
      "selection-reachable/ir/document.json",
    );
    expect(
      (document.limitations as readonly string[]).some((limitation) =>
        limitation.includes("reachable accessible definitions"),
      ),
    ).toBe(true);
  });
});
