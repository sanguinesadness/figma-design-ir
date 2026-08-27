import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";

import {
  StreamingArchiveBuilder,
  type ArchiveBuilderRuntime,
  type CompletedArchive,
} from "../src/shared/archive-builder";
import {
  archivePaths,
  requireSnapshotId,
  type ArchiveEntryDescriptor,
  type SnapshotId,
} from "../src/shared/archive";
import { DIAGNOSTIC_CODES } from "../src/shared/diagnostics";
import type {
  ArchiveEntryPayload,
  ExportProducerMessage,
  ExportReady,
  ProgressMessage,
} from "../src/shared/protocol";
import { serializeCanonicalJson } from "../src/shared/serialization";
import { sha256Hex } from "../src/shared/sha256";

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });
const REPEATED_IMAGE_HASH = "image:invented-entire-file-repeat";
const LARGE_UNICODE_TEXT = "Орбита 星 e\u0301 🧭 — bounded · ".repeat(256);

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

interface FakeNode extends Record<string, unknown> {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  parent: FakeNode | FakePage | FakeDocument | null;
  children: FakeNode[];
  exportAsync(settings: { readonly format: string }): Promise<unknown>;
}

interface FakePage extends Record<string, unknown> {
  readonly id: string;
  readonly name: string;
  readonly type: "PAGE";
  parent: FakeDocument | null;
  readonly children: FakeNode[];
  loadAsync(): Promise<void>;
  exportAsync(settings: { readonly format: string }): Promise<unknown>;
  findAllWithCriteria(criteria: {
    readonly types: readonly string[];
  }): FakeNode[];
}

interface FakeDocument extends Record<string, unknown> {
  readonly id: string;
  readonly name: string;
  readonly type: "DOCUMENT";
  readonly parent: null;
  readonly children: FakePage[];
}

interface FakeApiHarness {
  readonly api: unknown;
  readonly loadAllPagesAsync: ReturnType<typeof vi.fn>;
  readonly currentPage: FakePage;
  readonly currentPageWriteWasObserved: () => boolean;
  readonly getImageByHash: ReturnType<typeof vi.fn>;
  readonly getBytesAsync: ReturnType<typeof vi.fn>;
}

interface NodeOptions {
  readonly visible?: boolean;
  readonly width?: number;
  readonly height?: number;
  readonly fills?: readonly unknown[];
  readonly children?: readonly FakeNode[];
  readonly exportOverride?: (settings: {
    readonly format: string;
  }) => Promise<unknown>;
  readonly extra?: Readonly<Record<string, unknown>>;
}

interface PageOptions {
  readonly events: string[];
  readonly children?: readonly FakeNode[];
  readonly load?: () => Promise<void>;
  readonly rawValue?:
    | Readonly<Record<string, unknown>>
    | ((callNumber: number) => Readonly<Record<string, unknown>>);
  readonly rawExport?: (callNumber: number) => Promise<unknown>;
  readonly onChildrenRead?: () => void;
}

interface CancellationTokenLike {
  readonly cancelled: boolean;
  cancel(): void;
  throwIfCancelled(): void;
}

interface RunEntireFileOptionsLike {
  readonly exportId: string;
  readonly requestId: string;
  readonly snapshotId: string;
  readonly cancellation: CancellationTokenLike;
  readonly postMessage: (
    message: ExportProducerMessage,
  ) => void | Promise<void>;
  readonly exportedAtUtc?: string;
  readonly api?: unknown;
  readonly now?: () => number;
  readonly optionalArtifactByteLimit?: number;
  readonly pageArtifactByteLimit?: number;
  readonly onPageReleased?: (metrics: {
    readonly pageIndex: number;
    readonly rootCount: number;
    readonly nodeCount: number;
  }) => void;
}

interface EntireFileTestRuntime {
  readonly runEntireFileExport: (
    options: RunEntireFileOptionsLike,
  ) => Promise<void>;
  readonly ExportCancellationToken: new () => CancellationTokenLike;
  readonly ExportCancelledError: new () => Error;
  readonly assertCanonicalJsonFits: (
    value: unknown,
    options: {
      readonly byteLimit: number;
      readonly checkpoint: () => void;
      readonly textYieldInterval?: number;
      readonly yieldControl?: () => Promise<void>;
    },
  ) => Promise<void>;
}

let entireFileRuntimePromise: Promise<EntireFileTestRuntime> | undefined;

function loadEntireFileTestRuntime(): Promise<EntireFileTestRuntime> {
  entireFileRuntimePromise ??= (async () => {
    const exportPath = fileURLToPath(
      new URL("../src/main/export-entire-file.ts", import.meta.url),
    );
    const cancellationPath = fileURLToPath(
      new URL("../src/main/cancellation.ts", import.meta.url),
    );
    const preflightPath = fileURLToPath(
      new URL("../src/main/archive-entry-preflight.ts", import.meta.url),
    );
    const result = await build({
      bundle: true,
      stdin: {
        contents: [
          `export { runEntireFileExport } from ${JSON.stringify(exportPath)};`,
          `export { ExportCancellationToken, ExportCancelledError } from ${JSON.stringify(cancellationPath)};`,
          `export { assertCanonicalJsonFits } from ${JSON.stringify(preflightPath)};`,
        ].join("\n"),
        loader: "ts",
        resolveDir: fileURLToPath(new URL("..", import.meta.url)),
      },
      format: "esm",
      platform: "node",
      target: "es2022",
      write: false,
    });
    const source = result.outputFiles?.[0]?.text;
    if (source === undefined) {
      throw new Error("The invented entire-file test bundle was not produced.");
    }
    const loaded: unknown = await import(
      `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
    );
    if (
      typeof loaded !== "object" ||
      loaded === null ||
      !("runEntireFileExport" in loaded) ||
      !("ExportCancellationToken" in loaded) ||
      !("ExportCancelledError" in loaded) ||
      !("assertCanonicalJsonFits" in loaded) ||
      typeof loaded.runEntireFileExport !== "function" ||
      typeof loaded.ExportCancellationToken !== "function" ||
      typeof loaded.ExportCancelledError !== "function" ||
      typeof loaded.assertCanonicalJsonFits !== "function"
    ) {
      throw new Error(
        "The invented entire-file test bundle has the wrong exports.",
      );
    }
    return loaded as unknown as EntireFileTestRuntime;
  })();
  return entireFileRuntimePromise;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function generatedPngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  bytes.set([73, 72, 68, 82], 12);
  const writeUint32 = (offset: number, value: number): void => {
    bytes[offset] = (value >>> 24) & 0xff;
    bytes[offset + 1] = (value >>> 16) & 0xff;
    bytes[offset + 2] = (value >>> 8) & 0xff;
    bytes[offset + 3] = value & 0xff;
  };
  writeUint32(16, width);
  writeUint32(20, height);
  return bytes;
}

const SYNTHETIC_PNG = generatedPngHeader(1, 1);

function makeNode(
  id: string,
  type: string,
  options: NodeOptions = {},
): FakeNode {
  const width = options.width ?? 120;
  const height = options.height ?? 80;
  const node = {
    id,
    name: `Invented ${id}`,
    type,
    parent: null,
    children: [...(options.children ?? [])],
    visible: options.visible ?? true,
    locked: false,
    width,
    height,
    x: 0,
    y: 0,
    absoluteBoundingBox: { x: 0, y: 0, width, height },
    absoluteRenderBounds: { x: 0, y: 0, width, height },
    annotations: [],
    reactions: [],
    exportSettings: [],
    ...(options.fills === undefined ? {} : { fills: options.fills }),
    ...(options.extra ?? {}),
    exportAsync: vi.fn((settings: { readonly format: string }) => {
      if (options.exportOverride !== undefined) {
        return options.exportOverride(settings);
      }
      if (settings.format === "JSON_REST_V1") {
        return Promise.resolve({ id, type, invented: true });
      }
      if (settings.format === "PNG") {
        return Promise.resolve(SYNTHETIC_PNG);
      }
      if (settings.format === "SVG_STRING") {
        return Promise.resolve(
          '<svg viewBox="0 0 1 1"><path d="M0 0Z"/></svg>',
        );
      }
      return Promise.reject(new Error("Unsupported invented export format."));
    }),
  } as FakeNode;
  for (const child of node.children) {
    child.parent = node;
  }
  return node;
}

function imageFill(): readonly unknown[] {
  return [
    {
      type: "IMAGE",
      imageHash: REPEATED_IMAGE_HASH,
      scaleMode: "FILL",
      visible: true,
      opacity: 1,
    },
  ];
}

function makeTextNode(id: string, characters: string): FakeNode {
  return makeNode(id, "TEXT", {
    extra: {
      characters,
      hasMissingFont: false,
      getStyledTextSegments: () => [
        { start: 0, end: characters.length, characters },
      ],
    },
  });
}

function makeComponent(id: string, children: readonly FakeNode[]): FakeNode {
  return makeNode(id, "COMPONENT", {
    children,
    extra: {
      key: `key:${id}`,
      remote: false,
      variantProperties: null,
      componentPropertyDefinitions: {},
      componentPropertyReferences: null,
      documentationLinks: [],
      description: `Invented definition ${id}`,
      descriptionMarkdown: `Invented definition ${id}`,
    },
  });
}

function makeInstance(id: string, mainComponent: FakeNode): FakeNode {
  return makeNode(id, "INSTANCE", {
    extra: {
      componentProperties: {},
      componentPropertyReferences: null,
      overrides: [],
      exposedInstances: [],
      isExposedInstance: false,
      scaleFactor: 1,
      getMainComponentAsync: () => Promise.resolve(mainComponent),
    },
  });
}

function allDescendants(roots: readonly FakeNode[]): FakeNode[] {
  const result: FakeNode[] = [];
  const work = [...roots].reverse();
  while (work.length > 0) {
    const node = work.pop();
    if (node === undefined) {
      continue;
    }
    result.push(node);
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      const child = node.children[index];
      if (child !== undefined) {
        work.push(child);
      }
    }
  }
  return result;
}

function makePage(id: string, options: PageOptions): FakePage {
  const children = [...(options.children ?? [])];
  let rawExportCallCount = 0;
  const page = {
    id,
    name: `Invented ${id}`,
    type: "PAGE" as const,
    parent: null,
    get children(): FakeNode[] {
      options.onChildrenRead?.();
      return children;
    },
    loadAsync: vi.fn(async () => {
      options.events.push(`load:${id}`);
      await (options.load?.() ?? Promise.resolve());
    }),
    exportAsync: vi.fn((settings: { readonly format: string }) => {
      if (settings.format !== "JSON_REST_V1") {
        return Promise.reject(
          new Error("Pages use only the invented raw export."),
        );
      }
      rawExportCallCount += 1;
      options.events.push(`raw:${id}:${rawExportCallCount}`);
      if (options.rawExport !== undefined) {
        return options.rawExport(rawExportCallCount);
      }
      return Promise.resolve(
        typeof options.rawValue === "function"
          ? options.rawValue(rawExportCallCount)
          : (options.rawValue ?? { id, invented: true }),
      );
    }),
    findAllWithCriteria: vi.fn((): FakeNode[] => {
      throw new Error(
        "Entire-file export must not use a synchronous full-page criteria scan.",
      );
    }),
  } as FakePage;
  for (const child of children) {
    child.parent = page;
  }
  return page;
}

function makeVariables(count: number): {
  readonly collections: readonly Record<string, unknown>[];
  readonly variables: readonly Record<string, unknown>[];
} {
  const modeId = "mode:invented";
  const collectionId = "collection:invented-entire-file";
  const variableIds = Array.from(
    { length: count },
    (_, index) => `variable:invented-${index.toString().padStart(3, "0")}`,
  );
  return {
    collections: [
      {
        id: collectionId,
        name: "Invented bounded collection",
        key: "key:invented-bounded-collection",
        remote: false,
        hiddenFromPublishing: false,
        isExtension: false,
        defaultModeId: modeId,
        modes: [{ modeId, name: "Invented mode" }],
        variableIds,
      },
    ],
    variables: variableIds.map((id, index) => ({
      id,
      name: `Invented variable ${index}`,
      key: `key:${id}`,
      remote: false,
      variableCollectionId: collectionId,
      resolvedType: "FLOAT",
      description: "Invented bounded value.",
      scopes: ["ALL_SCOPES"],
      codeSyntax: {},
      hiddenFromPublishing: false,
      valuesByMode: { [modeId]: index },
    })),
  };
}

function createApi(
  pages: readonly FakePage[],
  options?: {
    readonly variableCount?: number;
    readonly getBytesAsync?: () => Promise<Uint8Array>;
    readonly currentPageIndex?: number;
  },
): FakeApiHarness {
  const document: FakeDocument = {
    id: "document:invented-entire-file",
    name: "Invented Entire File Document",
    type: "DOCUMENT",
    parent: null,
    children: [...pages],
  };
  for (const page of pages) {
    page.parent = document;
  }
  const currentPage = pages[options?.currentPageIndex ?? pages.length - 1];
  if (currentPage === undefined) {
    throw new Error("The invented API needs one page.");
  }
  const nodesById = new Map<string, FakeNode>();
  for (const page of pages) {
    for (const node of allDescendants(page.children)) {
      nodesById.set(node.id, node);
    }
  }
  const variableFixture = makeVariables(options?.variableCount ?? 0);
  const getBytesAsync = vi.fn(
    options?.getBytesAsync ?? (() => Promise.resolve(SYNTHETIC_PNG)),
  );
  const getImageByHash = vi.fn((hash: string) =>
    hash === REPEATED_IMAGE_HASH ? { getBytesAsync } : null,
  );
  const loadAllPagesAsync = vi.fn(() =>
    Promise.reject(new Error("loadAllPagesAsync must not be called.")),
  );
  let currentPageWriteObserved = false;
  const apiObject: Record<string, unknown> = {
    root: document,
    mixed: Symbol("invented-mixed"),
    loadAllPagesAsync,
    getNodeByIdAsync: (id: string) =>
      Promise.resolve(nodesById.get(id) ?? null),
    getImageByHash,
    getLocalPaintStylesAsync: () => Promise.resolve([]),
    getLocalTextStylesAsync: () => Promise.resolve([]),
    getLocalEffectStylesAsync: () => Promise.resolve([]),
    getLocalGridStylesAsync: () => Promise.resolve([]),
    getStyleByIdAsync: () => Promise.resolve(null),
    variables: {
      getLocalVariableCollectionsAsync: () =>
        Promise.resolve(variableFixture.collections),
      getLocalVariablesAsync: () => Promise.resolve(variableFixture.variables),
      getVariableByIdAsync: (id: string) =>
        Promise.resolve(
          variableFixture.variables.find((variable) => variable.id === id) ??
            null,
        ),
      getVariableCollectionByIdAsync: (id: string) =>
        Promise.resolve(
          variableFixture.collections.find(
            (collection) => collection.id === id,
          ) ?? null,
        ),
    },
  };
  Object.defineProperty(apiObject, "currentPage", {
    configurable: true,
    enumerable: true,
    get: () => currentPage,
    set: () => {
      currentPageWriteObserved = true;
    },
  });
  return {
    api: apiObject,
    loadAllPagesAsync,
    currentPage,
    currentPageWriteWasObserved: () => currentPageWriteObserved,
    getImageByHash,
    getBytesAsync,
  };
}

async function withGlobalFigma<T>(
  api: unknown,
  run: () => Promise<T>,
): Promise<T> {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "figma");
  Object.defineProperty(globalThis, "figma", {
    configurable: true,
    writable: true,
    value: api,
  });
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      Reflect.deleteProperty(globalThis, "figma");
    } else {
      Object.defineProperty(globalThis, "figma", previous);
    }
  }
}

function archiveRuntime(): ArchiveBuilderRuntime {
  return {
    encodeUtf8: (text) => TEXT_ENCODER.encode(text),
    decodeUtf8: (bytes) => TEXT_DECODER.decode(bytes),
    sha256: (bytes) => Promise.resolve(sha256Hex(bytes)),
  };
}

function descriptorFromMessage(
  message: ArchiveEntryPayload,
): ArchiveEntryDescriptor {
  return {
    metadata: {
      path: message.path,
      mediaType: message.mediaType,
      compression: message.compression,
      uncompressedByteLength:
        typeof message.data === "string"
          ? TEXT_ENCODER.encode(message.data).byteLength
          : message.data.byteLength,
    },
    data: message.data,
  };
}

function requireReady(messages: readonly ExportProducerMessage[]): ExportReady {
  const ready = messages.find(
    (message): message is ExportReady => message.type === "export-ready",
  );
  if (ready === undefined) {
    throw new Error("The invented export did not become ready.");
  }
  return ready;
}

async function finalizeMessages(
  snapshotId: SnapshotId,
  messages: readonly ExportProducerMessage[],
): Promise<CompletedArchive> {
  const builder = new StreamingArchiveBuilder(snapshotId, archiveRuntime());
  for (const message of messages) {
    if (message.type === "archive-entry") {
      await builder.addEntry(descriptorFromMessage(message));
    }
  }
  const ready = requireReady(messages);
  return await builder.finalize(ready.manifestDraft, ready.artifacts);
}

function concatenate(chunks: readonly Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(
    chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function parseMessageJson(
  messages: readonly ExportProducerMessage[],
  path: string,
): Record<string, unknown> {
  const message = messages.find(
    (candidate): candidate is ArchiveEntryPayload =>
      candidate.type === "archive-entry" && candidate.path === path,
  );
  if (message === undefined || typeof message.data !== "string") {
    throw new Error(`Missing invented JSON entry: ${path}`);
  }
  return JSON.parse(message.data) as Record<string, unknown>;
}

function archiveEntryPaths(
  messages: readonly ExportProducerMessage[],
): string[] {
  return messages.flatMap((message) =>
    message.type === "archive-entry" ? [message.path] : [],
  );
}

function progressShape(message: ProgressMessage): {
  readonly completed: number;
  readonly total: number | undefined;
  readonly currentLabel: string | undefined;
  readonly hasDuration: boolean;
} {
  return {
    completed: message.completed,
    total: message.total,
    currentLabel: message.currentLabel,
    hasDuration: message.durationMs !== undefined,
  };
}

function expectedProgressPair(
  pageIndex: number,
  total: number,
  currentLabel: string,
): readonly ReturnType<typeof progressShape>[] {
  return [
    {
      completed: pageIndex,
      total,
      currentLabel,
      hasDuration: false,
    },
    {
      completed: pageIndex + 1,
      total,
      currentLabel,
      hasDuration: true,
    },
  ];
}

function hasBoundedDuration(message: ProgressMessage): boolean {
  return (
    message.durationMs === undefined ||
    (Number.isFinite(message.durationMs) && message.durationMs >= 0)
  );
}

describe("Entire-file scalability and resilience", () => {
  it("streams a bounded combined stress fixture page-by-page with global closure and page-local release", async () => {
    const runtime = await loadEntireFileTestRuntime();
    const snapshotId = requireSnapshotId("entire-file-bounded-stress");
    const events: string[] = [];
    const loadedPageIds = new Set<string>();
    const warmedPageIds = new Set<string>();
    const materializedPageIds = new Set<string>();
    const rawCacheStates = new Map<string, string[]>();
    const loadCompletionOrder: string[] = [];
    let activePageLoads = 0;
    let maximumActivePageLoads = 0;
    let activeRawExports = 0;
    let maximumActiveRawExports = 0;
    const recordPageLoad = async (pageId: string): Promise<void> => {
      materializedPageIds.delete(pageId);
      activePageLoads += 1;
      maximumActivePageLoads = Math.max(
        maximumActivePageLoads,
        activePageLoads,
      );
      try {
        loadedPageIds.add(pageId);
        await Promise.resolve();
        loadCompletionOrder.push(pageId);
      } finally {
        activePageLoads -= 1;
      }
    };
    const exportRawPage = async (
      pageId: string,
      callNumber: number,
      value: Readonly<Record<string, unknown>>,
    ): Promise<Readonly<Record<string, unknown>>> => {
      activeRawExports += 1;
      maximumActiveRawExports = Math.max(
        maximumActiveRawExports,
        activeRawExports,
      );
      try {
        await Promise.resolve();
        const cacheState = warmedPageIds.has(pageId) ? "warm" : "cold";
        const observedStates = rawCacheStates.get(pageId) ?? [];
        observedStates.push(cacheState);
        rawCacheStates.set(pageId, observedStates);
        return {
          ...value,
          cacheState,
          allPagesWarmed: warmedPageIds.size === 3,
        };
      } finally {
        activeRawExports -= 1;
      }
    };
    const imageNodeA = makeNode("node:image-a", "FRAME", {
      fills: imageFill(),
    });
    const componentA = makeComponent("component:alpha", [imageNodeA]);

    const deepText = makeTextNode("node:deep-text", LARGE_UNICODE_TEXT);
    let deepChild = deepText;
    for (let depth = 39; depth >= 0; depth -= 1) {
      deepChild = makeNode(
        `node:deep-${depth.toString().padStart(2, "0")}`,
        "FRAME",
        {
          children: [deepChild],
        },
      );
    }
    const hiddenDirectFrame = makeNode("node:hidden-direct", "FRAME", {
      visible: false,
    });
    const pageOne = makePage("page:one", {
      events,
      children: [componentA, deepChild, hiddenDirectFrame],
      load: () => recordPageLoad("page:one"),
      onChildrenRead: () => {
        materializedPageIds.add("page:one");
      },
      rawExport: (callNumber) =>
        exportRawPage("page:one", callNumber, {
          id: "page:one",
          text: LARGE_UNICODE_TEXT,
          allPagesLoaded: loadedPageIds.size === 3,
          rootsMaterialized: materializedPageIds.has("page:one"),
        }),
    });

    const crossPageInstance = makeInstance(
      "instance:alpha-in-beta",
      componentA,
    );
    const imageNodeB = makeNode("node:image-b", "FRAME", {
      fills: imageFill(),
    });
    const componentB = makeComponent("component:beta", [
      crossPageInstance,
      imageNodeB,
    ]);
    const sectionFrame = makeNode("node:section-frame", "FRAME", {
      fills: imageFill(),
    });
    const sectionHiddenFrame = makeNode("node:section-hidden", "FRAME", {
      visible: false,
    });
    const sectionNestedFrame = makeNode("node:section-nested", "FRAME");
    const sectionGroup = makeNode("node:section-group", "GROUP", {
      children: [sectionNestedFrame],
    });
    const section = makeNode("node:section", "SECTION", {
      children: [sectionFrame, sectionHiddenFrame, sectionGroup],
      extra: { sectionContentsHidden: false },
    });
    const pageTwo = makePage("page:two", {
      events,
      children: [componentB, section],
      load: () => recordPageLoad("page:two"),
      onChildrenRead: () => {
        materializedPageIds.add("page:two");
      },
      rawExport: (callNumber) =>
        exportRawPage("page:two", callNumber, {
          id: "page:two",
          allPagesLoaded: loadedPageIds.size === 3,
          rootsMaterialized: materializedPageIds.has("page:two"),
        }),
    });

    const wideChildren = Array.from({ length: 64 }, (_, index) =>
      makeNode(
        `node:wide-image-${index.toString().padStart(2, "0")}`,
        "FRAME",
        {
          fills: imageFill(),
        },
      ),
    );
    const wideText = makeTextNode("node:wide-text", LARGE_UNICODE_TEXT);
    wideChildren.push(wideText);
    const wideFrame = makeNode("node:wide-root", "FRAME", {
      children: wideChildren,
    });
    const groupNestedFrame = makeNode("node:group-nested", "FRAME");
    const directGroup = makeNode("node:direct-group", "GROUP", {
      children: [groupNestedFrame],
    });
    const zeroFrame = makeNode("node:zero-direct", "FRAME", { width: 0 });
    const pageThree = makePage("page:three", {
      events,
      children: [wideFrame, directGroup, zeroFrame],
      load: () => recordPageLoad("page:three"),
      onChildrenRead: () => {
        materializedPageIds.add("page:three");
      },
      rawExport: (callNumber) =>
        exportRawPage("page:three", callNumber, {
          id: "page:three",
          allPagesLoaded: loadedPageIds.size === 3,
          rootsMaterialized: materializedPageIds.has("page:three"),
        }),
    });

    const harness = createApi([pageOne, pageTwo, pageThree], {
      variableCount: 32,
      currentPageIndex: 1,
    });
    const warmOnCollectedGetter = (pageId: string, node: FakeNode): void => {
      const reactions = node.reactions;
      Object.defineProperty(node, "reactions", {
        configurable: true,
        enumerable: true,
        get: () => {
          if (!warmedPageIds.has(pageId)) {
            events.push(`warm:${pageId}`);
            warmedPageIds.add(pageId);
          }
          return reactions;
        },
      });
    };
    warmOnCollectedGetter("page:one", deepText);
    warmOnCollectedGetter("page:two", crossPageInstance);
    warmOnCollectedGetter("page:three", wideText);
    const directRootIdsBefore = [pageOne, pageTwo, pageThree].map((page) =>
      page.children.map((node) => node.id),
    );
    const messages: ExportProducerMessage[] = [];
    const released: {
      readonly pageIndex: number;
      readonly rootCount: number;
      readonly nodeCount: number;
    }[] = [];
    await withGlobalFigma(harness.api, async () => {
      await runtime.runEntireFileExport({
        exportId: "export:entire-file-stress",
        requestId: "request:entire-file-stress",
        snapshotId,
        cancellation: new runtime.ExportCancellationToken(),
        api: harness.api,
        exportedAtUtc: "2026-08-15T00:00:00.000Z",
        postMessage: (message) => {
          messages.push(message);
          if (message.type === "progress") {
            events.push(
              `progress:${message.phase}:${message.completed}/${message.total ?? "unknown"}:${message.currentLabel ?? "unlabeled"}`,
            );
          }
          if (message.type === "archive-entry") {
            events.push(`emit:${message.path}`);
          }
        },
        onPageReleased: (metrics) => {
          released.push(metrics);
          events.push(`release:${metrics.pageIndex}`);
        },
      });
    });
    const requireEventIndex = (event: string): number => {
      const index = events.indexOf(event);
      expect(index).toBeGreaterThanOrEqual(0);
      return index;
    };

    expect(harness.loadAllPagesAsync).not.toHaveBeenCalled();
    expect(harness.currentPageWriteWasObserved()).toBe(false);
    expect(harness.currentPage.id).toBe("page:two");
    expect(events.filter((event) => event.startsWith("load:"))).toEqual([
      "load:page:one",
      "load:page:two",
      "load:page:three",
    ]);
    expect(events.indexOf("load:page:three")).toBeLessThan(
      events.indexOf("raw:page:one:1"),
    );
    expect(loadCompletionOrder).toEqual(["page:one", "page:two", "page:three"]);
    expect(maximumActivePageLoads).toBe(1);
    expect(events.filter((event) => event.startsWith("raw:"))).toEqual([
      "raw:page:one:1",
      "raw:page:two:1",
      "raw:page:three:1",
      "raw:page:one:2",
      "raw:page:two:2",
      "raw:page:three:2",
    ]);
    expect(events.indexOf("raw:page:three:1")).toBeLessThan(
      events.indexOf("raw:page:one:2"),
    );
    expect(maximumActiveRawExports).toBe(1);
    for (const pageId of ["page:one", "page:two", "page:three"]) {
      expect(rawCacheStates.get(pageId)).toEqual(["cold", "warm"]);
    }
    expect(released).toHaveLength(3);
    expect(
      released.reduce((total, page) => total + page.nodeCount, 0),
    ).toBeGreaterThan(100);
    for (let pageIndex = 0; pageIndex < 2; pageIndex += 1) {
      expect(events.indexOf(`release:${pageIndex}`)).toBeLessThan(
        events.indexOf(`raw:page:${pageIndex === 0 ? "two" : "three"}:2`),
      );
    }
    expect(
      [pageOne, pageTwo, pageThree].map((page) =>
        page.children.map((node) => node.id),
      ),
    ).toEqual(directRootIdsBefore);
    const getMainComponentAsync =
      crossPageInstance.getMainComponentAsync as () => Promise<FakeNode>;
    await expect(getMainComponentAsync()).resolves.toBe(componentA);

    const progress = messages.filter(
      (message): message is ProgressMessage => message.type === "progress",
    );
    expect(new Set(progress.map((message) => message.phase))).toEqual(
      new Set([
        "scope",
        "page-loading",
        "collection",
        "raw",
        "asset",
        "preview",
        "serialization",
        "archive",
      ]),
    );
    expect(
      progress.every(
        (message) =>
          message.total === undefined || message.completed <= message.total,
      ),
    ).toBe(true);
    expect(
      progress
        .filter((message) => message.phase === "page-loading")
        .filter((message) => message.durationMs !== undefined),
    ).toHaveLength(3);
    const rawProgress = progress.filter((message) => message.phase === "raw");
    const rawStabilizationProgress = rawProgress.filter((message) =>
      message.currentLabel?.endsWith("; stabilization"),
    );
    expect(rawStabilizationProgress.map(progressShape)).toEqual(
      Array.from({ length: 3 }, (_, pageIndex) =>
        expectedProgressPair(
          pageIndex,
          3,
          `Page ${pageIndex + 1} of 3; stabilization`,
        ),
      ).flat(),
    );
    const rawRetryProgress = rawProgress.filter((message) =>
      message.currentLabel?.endsWith("; stabilization retry"),
    );
    expect(rawRetryProgress).toEqual([]);
    const ordinaryRawProgress = rawProgress.filter((message) =>
      /^Page \d+ of 3$/u.test(message.currentLabel ?? ""),
    );
    expect(ordinaryRawProgress.map(progressShape)).toEqual(
      Array.from({ length: 3 }, (_, pageIndex) =>
        expectedProgressPair(pageIndex, 3, `Page ${pageIndex + 1} of 3`),
      ).flat(),
    );
    expect(rawProgress).toHaveLength(
      rawStabilizationProgress.length + ordinaryRawProgress.length,
    );
    expect(rawProgress.every(hasBoundedDuration)).toBe(true);
    const componentGraphProgress = progress.filter(
      (message) =>
        message.phase === "collection" &&
        message.currentLabel?.includes("; component graph") === true,
    );
    expect(componentGraphProgress.length).toBeGreaterThan(3);
    expect(componentGraphProgress.every(hasBoundedDuration)).toBe(true);
    expect(
      componentGraphProgress.some(
        (message) => message.total === undefined && message.completed > 0,
      ),
    ).toBe(true);
    expect(
      componentGraphProgress.find((message) =>
        message.currentLabel?.startsWith(
          "Page 2 of 3; component graph complete;",
        ),
      )?.currentLabel,
    ).toMatch(/; 1 reused; \d+ duplicate queues skipped$/u);
    const componentArtifactProgress = progress.filter(
      (message) =>
        message.phase === "collection" &&
        message.currentLabel?.endsWith("; component artifacts") === true,
    );
    expect(
      componentArtifactProgress.map((message) => ({
        completed: message.completed,
        total: message.total,
        label: message.currentLabel,
        hasDuration: message.durationMs !== undefined,
      })),
    ).toEqual([
      {
        completed: 0,
        total: 1,
        label: "Page 1 of 3; component artifacts",
        hasDuration: false,
      },
      {
        completed: 1,
        total: 1,
        label: "Page 1 of 3; component artifacts",
        hasDuration: true,
      },
      {
        completed: 0,
        total: 1,
        label: "Page 2 of 3; component artifacts",
        hasDuration: false,
      },
      {
        completed: 1,
        total: 1,
        label: "Page 2 of 3; component artifacts",
        hasDuration: true,
      },
      {
        completed: 0,
        total: 0,
        label: "Page 3 of 3; component artifacts",
        hasDuration: false,
      },
    ]);
    expect(
      progress.every(
        (message) =>
          message.currentLabel === undefined ||
          !/(?:Invented|page:|node:|image:|Орбита)/u.test(message.currentLabel),
      ),
    ).toBe(true);

    const pageIds = ["page:one", "page:two", "page:three"];
    for (const pageId of pageIds) {
      const rawPage = parseMessageJson(
        messages,
        archivePaths.rawRestPage(snapshotId, pageId),
      );
      expect(rawPage.allPagesLoaded).toBe(true);
      expect(rawPage.cacheState).toBe("warm");
      expect(rawPage.rootsMaterialized).toBe(true);
    }
    for (const page of [pageOne, pageTwo, pageThree]) {
      expect(
        (page.exportAsync as ReturnType<typeof vi.fn>).mock.calls,
      ).toHaveLength(2);
      expect(
        archiveEntryPaths(messages).filter(
          (path) => path === archivePaths.rawRestPage(snapshotId, page.id),
        ),
      ).toHaveLength(1);
    }
    const expectedPageEmissionOrder = pageIds.flatMap((pageId) => [
      archivePaths.rawRestPage(snapshotId, pageId),
      archivePaths.irNodePage(snapshotId, pageId),
    ]);
    expect(
      archiveEntryPaths(messages).filter(
        (path) =>
          path.includes("/raw/rest-v1/pages/") ||
          path.includes("/ir/nodes/pages/"),
      ),
    ).toEqual(expectedPageEmissionOrder);
    for (const [pageIndex, pageId] of pageIds.entries()) {
      const rootCount = [3, 2, 3][pageIndex]!;
      const previewCount = [2, 2, 1][pageIndex]!;
      const actualRawEvent = requireEventIndex(`raw:${pageId}:2`);
      expect(requireEventIndex(`warm:${pageId}`)).toBeLessThan(actualRawEvent);
      expect(
        requireEventIndex(
          `progress:collection:${rootCount}/${rootCount}:Page ${pageIndex + 1} of 3`,
        ),
      ).toBeLessThan(actualRawEvent);
      expect(
        requireEventIndex(
          `progress:asset:${rootCount}/${rootCount}:Page ${pageIndex + 1} of 3`,
        ),
      ).toBeLessThan(actualRawEvent);
      expect(
        requireEventIndex(
          `progress:preview:${previewCount}/${previewCount}:Page ${pageIndex + 1} of 3`,
        ),
      ).toBeLessThan(actualRawEvent);
      expect(actualRawEvent).toBeLessThan(
        requireEventIndex(
          `emit:${archivePaths.rawRestPage(snapshotId, pageId)}`,
        ),
      );
      expect(
        requireEventIndex(
          `emit:${archivePaths.rawRestPage(snapshotId, pageId)}`,
        ),
      ).toBeLessThan(
        requireEventIndex(
          `progress:raw:${pageIndex + 1}/3:Page ${pageIndex + 1} of 3`,
        ),
      );
      expect(
        requireEventIndex(
          `progress:raw:${pageIndex + 1}/3:Page ${pageIndex + 1} of 3`,
        ),
      ).toBeLessThan(
        requireEventIndex(
          `emit:${archivePaths.irNodePage(snapshotId, pageId)}`,
        ),
      );
      expect(
        requireEventIndex(
          `emit:${archivePaths.irNodePage(snapshotId, pageId)}`,
        ),
      ).toBeLessThan(requireEventIndex(`release:${pageIndex}`));
    }

    const entryPaths = archiveEntryPaths(messages);
    for (const globalPath of [
      archivePaths.irVariables(snapshotId),
      archivePaths.irStyles(snapshotId),
      archivePaths.irComponents(snapshotId),
    ]) {
      expect(entryPaths.filter((path) => path === globalPath)).toHaveLength(1);
    }
    const components = parseMessageJson(
      messages,
      archivePaths.irComponents(snapshotId),
    );
    const definitions = components.definitions as readonly Record<
      string,
      unknown
    >[];
    expect(definitions.map((definition) => definition.source)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "component:alpha" }),
        expect.objectContaining({ id: "component:beta" }),
      ]),
    );
    expect(definitions).toHaveLength(2);
    expect(
      new Set(
        definitions.map((definition) => JSON.stringify(definition.source)),
      ).size,
    ).toBe(2);
    const dependencies = components.dependencies as readonly Record<
      string,
      unknown
    >[];
    expect(
      dependencies.some((dependency) => {
        const from = dependency.from as Record<string, unknown> | undefined;
        const to = dependency.to as Record<string, unknown> | undefined;
        return (
          from?.id === "component:beta" &&
          to?.id === "component:alpha" &&
          dependency.relationship === "instance"
        );
      }),
    ).toBe(true);
    const componentDefinitionPaths = entryPaths.filter((path) =>
      path.includes("/ir/components/definitions/"),
    );
    expect(componentDefinitionPaths).toHaveLength(2);
    expect(new Set(componentDefinitionPaths).size).toBe(2);

    const document = parseMessageJson(
      messages,
      archivePaths.irDocument(snapshotId),
    );
    const documentPages = document.pages as readonly Record<string, unknown>[];
    expect(
      documentPages.map((page) => ({ kind: page.kind, id: page.id })),
    ).toEqual(pageIds.map((id) => ({ kind: "page", id })));
    expect(document.currentPageId).toBe(harness.currentPage.id);
    const counts = document.counts as Record<string, unknown>;
    expect(counts.localVariables).toEqual({
      status: "collected",
      value: 32,
      coverage: "file-local",
    });
    expect(counts.localComponents).toEqual({
      status: "collected",
      value: 2,
      coverage: "file-local",
    });
    for (const pageId of pageIds) {
      const page = parseMessageJson(
        messages,
        archivePaths.irNodePage(snapshotId, pageId),
      );
      expect(page).not.toHaveProperty("definitions");
      expect(
        (page.assets as readonly Record<string, unknown>[]).some(
          (asset) => asset.assetKind === "raster",
        ),
      ).toBe(true);
    }
    expect(harness.getImageByHash).toHaveBeenCalledTimes(1);
    expect(harness.getBytesAsync).toHaveBeenCalledTimes(1);
    const rasterPaths = entryPaths.filter((path) =>
      path.includes("/assets/raster/"),
    );
    expect(rasterPaths).toHaveLength(1);

    expect(entryPaths.filter((path) => path.includes("/previews/"))).toEqual([
      archivePaths.preview(snapshotId, componentA.id),
      archivePaths.preview(snapshotId, deepChild.id),
      archivePaths.preview(snapshotId, componentB.id),
      archivePaths.preview(snapshotId, sectionFrame.id),
      archivePaths.preview(snapshotId, wideFrame.id),
    ]);

    const completed = await finalizeMessages(snapshotId, messages);
    expect(completed.manifest.completeness).toBe("complete");
    const files = unzipSync(concatenate(completed.chunks));
    expect(files[archivePaths.manifest(snapshotId)]).toBeDefined();
    for (const [path, bytes] of Object.entries(files)) {
      if (path.endsWith(".json")) {
        const text = strFromU8(bytes);
        expect(() => {
          JSON.parse(text);
        }).not.toThrow();
        expect(text).not.toMatch(/data:[^"\s]+;base64,/iu);
      }
    }
    expect(
      strFromU8(files[archivePaths.irNodePage(snapshotId, "page:one")]!),
    ).toContain(LARGE_UNICODE_TEXT);
  });

  it("continues after an isolated middle-page load failure and finalizes a truthfully incomplete readable archive", async () => {
    const runtime = await loadEntireFileTestRuntime();
    const measuredCanonicalValue = {
      z: 'quote" slash\\ line\n control\u0001 lone\ud800 pair🚲',
      a: [-0, false, { k: "星 e\u0301 —" }],
    };
    const exactCanonicalByteLength = TEXT_ENCODER.encode(
      serializeCanonicalJson(measuredCanonicalValue),
    ).byteLength;
    await expect(
      runtime.assertCanonicalJsonFits(measuredCanonicalValue, {
        byteLimit: exactCanonicalByteLength,
        checkpoint: () => undefined,
        textYieldInterval: 3,
        yieldControl: () => Promise.resolve(),
      }),
    ).resolves.toBeUndefined();
    await expect(
      runtime.assertCanonicalJsonFits(measuredCanonicalValue, {
        byteLimit: exactCanonicalByteLength - 1,
        checkpoint: () => undefined,
        textYieldInterval: 3,
        yieldControl: () => Promise.resolve(),
      }),
    ).rejects.toMatchObject({ code: "archive-capacity-exceeded" });
    const snapshotId = requireSnapshotId("entire-file-page-failure");
    const events: string[] = [];
    const oversizedVector = makeNode("node:oversized-vector", "VECTOR", {
      exportOverride: (settings) =>
        settings.format === "SVG_STRING"
          ? Promise.resolve(`<svg>${"x".repeat(128)}</svg>`)
          : Promise.reject(new Error("Unsupported invented export format.")),
    });
    const retainedVector = makeNode("node:retained-vector", "VECTOR");
    const oversizedPageText = makeTextNode(
      "node:oversized-page-text",
      LARGE_UNICODE_TEXT.repeat(4),
    );
    const firstRoot = makeNode("node:first-root", "FRAME", {
      children: [oversizedVector, retainedVector, oversizedPageText],
      fills: imageFill(),
    });
    const oversizedRaster = new Uint8Array(129);
    const oversizedPreview = new Uint8Array(129);
    oversizedPreview.set(SYNTHETIC_PNG);
    const lastRoot = makeNode("node:last-root", "FRAME", {
      exportOverride: (settings) => {
        if (settings.format === "PNG") {
          return Promise.resolve(oversizedPreview);
        }
        if (settings.format === "JSON_REST_V1") {
          return Promise.resolve({ id: "node:last-root", invented: true });
        }
        return Promise.reject(new Error("Unsupported invented export format."));
      },
    });
    const firstPage = makePage("page:first", {
      events,
      children: [firstRoot],
    });
    const failedPage = makePage("page:failed", {
      events,
      load: () =>
        Promise.reject(new Error("INVENTED_PAGE_DETAIL_MUST_NOT_ESCAPE")),
    });
    let collectorFailureEnabled = false;
    const collectorFailedRoot = makeNode("node:collector-failed-root", "FRAME");
    const collectorFailedPage = makePage("page:collector-failed", {
      events,
      children: [collectorFailedRoot],
      load: () => {
        collectorFailureEnabled = true;
        return Promise.resolve();
      },
      onChildrenRead: () => {
        if (collectorFailureEnabled) {
          throw new Error("INVENTED_PAGE_CHILDREN_DETAIL_MUST_NOT_ESCAPE");
        }
      },
    });
    const rawStabilizationFailedRoot = makeNode(
      "node:raw-stabilization-failed-root",
      "FRAME",
    );
    const rawStabilizationFailedPage = makePage(
      "page:raw-stabilization-failed",
      {
        events,
        children: [rawStabilizationFailedRoot],
        rawExport: () =>
          Promise.reject(
            new Error("INVENTED_RAW_STABILIZATION_DETAIL_MUST_NOT_ESCAPE"),
          ),
      },
    );
    let lastPageLoadAttempts = 0;
    const lastPage = makePage("page:last", {
      events,
      children: [lastRoot],
      load: () => {
        lastPageLoadAttempts += 1;
        return lastPageLoadAttempts === 1
          ? Promise.reject(new Error("INVENTED_TRANSIENT_LOAD_DETAIL"))
          : Promise.resolve();
      },
      rawExport: (callNumber) =>
        callNumber === 1
          ? Promise.reject(
              new Error(
                "INVENTED_TRANSIENT_RAW_STABILIZATION_DETAIL_MUST_NOT_ESCAPE",
              ),
            )
          : Promise.resolve({ id: "page:last", large: "🚲".repeat(30) }),
    });
    const harness = createApi(
      [
        firstPage,
        failedPage,
        collectorFailedPage,
        rawStabilizationFailedPage,
        lastPage,
      ],
      {
        getBytesAsync: () => Promise.resolve(oversizedRaster),
      },
    );
    const messages: ExportProducerMessage[] = [];
    await withGlobalFigma(harness.api, async () => {
      await runtime.runEntireFileExport({
        exportId: "export:entire-file-failure",
        requestId: "request:entire-file-failure",
        snapshotId,
        cancellation: new runtime.ExportCancellationToken(),
        api: harness.api,
        optionalArtifactByteLimit: 128,
        pageArtifactByteLimit: 8192,
        exportedAtUtc: "2026-08-15T00:00:00.000Z",
        postMessage: (message) => {
          messages.push(message);
        },
        onPageReleased: ({ pageIndex }) => {
          events.push(`release:${pageIndex}`);
        },
      });
    });

    expect(events.filter((event) => event.startsWith("load:"))).toEqual([
      "load:page:first",
      "load:page:failed",
      "load:page:collector-failed",
      "load:page:raw-stabilization-failed",
      "load:page:last",
      "load:page:failed",
      "load:page:last",
    ]);
    expect(events.filter((event) => event.startsWith("release:"))).toEqual([
      "release:0",
      "release:1",
      "release:2",
      "release:3",
      "release:4",
    ]);
    expect(events.lastIndexOf("load:page:last")).toBeLessThan(
      events.indexOf("raw:page:first:1"),
    );
    expect(events.filter((event) => event.startsWith("raw:"))).toEqual([
      "raw:page:first:1",
      "raw:page:collector-failed:1",
      "raw:page:raw-stabilization-failed:1",
      "raw:page:last:1",
      "raw:page:raw-stabilization-failed:2",
      "raw:page:last:2",
      "raw:page:first:2",
      "raw:page:collector-failed:2",
      "raw:page:last:3",
    ]);
    expect(events.indexOf("raw:page:last:2")).toBeLessThan(
      events.indexOf("raw:page:first:2"),
    );
    expect(events.indexOf("release:0")).toBeLessThan(
      events.indexOf("release:1"),
    );
    expect(events.indexOf("release:1")).toBeLessThan(
      events.indexOf("raw:page:collector-failed:2"),
    );
    expect(events.indexOf("release:3")).toBeLessThan(
      events.indexOf("raw:page:last:3"),
    );
    const progress = messages.filter(
      (message): message is ProgressMessage => message.type === "progress",
    );
    const rawProgress = progress.filter((message) => message.phase === "raw");
    const rawStabilizationProgress = rawProgress.filter((message) =>
      message.currentLabel?.endsWith("; stabilization"),
    );
    expect(rawStabilizationProgress.map(progressShape)).toEqual(
      Array.from({ length: 5 }, (_, pageIndex) =>
        expectedProgressPair(
          pageIndex,
          5,
          `Page ${pageIndex + 1} of 5; stabilization`,
        ),
      ).flat(),
    );
    const rawRetryProgress = rawProgress.filter((message) =>
      message.currentLabel?.endsWith("; stabilization retry"),
    );
    expect(rawRetryProgress.map(progressShape)).toEqual([
      ...expectedProgressPair(0, 2, "Page 4 of 5; stabilization retry"),
      ...expectedProgressPair(1, 2, "Page 5 of 5; stabilization retry"),
    ]);
    const ordinaryRawProgress = rawProgress.filter((message) =>
      /^Page \d+ of 5$/u.test(message.currentLabel ?? ""),
    );
    expect(ordinaryRawProgress.map(progressShape)).toEqual(
      [0, 2, 3, 4].flatMap((pageIndex) =>
        expectedProgressPair(pageIndex, 5, `Page ${pageIndex + 1} of 5`),
      ),
    );
    expect(rawProgress).toHaveLength(
      rawStabilizationProgress.length +
        rawRetryProgress.length +
        ordinaryRawProgress.length,
    );
    expect(rawProgress.every(hasBoundedDuration)).toBe(true);
    expect(
      rawProgress.every(
        (message) =>
          message.currentLabel === undefined ||
          !/(?:Invented|page:|node:|image:|Орбита)/u.test(message.currentLabel),
      ),
    ).toBe(true);
    const ready = requireReady(messages);
    const failedPaths = [
      archivePaths.rawRestPage(snapshotId, failedPage.id),
      archivePaths.irNodePage(snapshotId, failedPage.id),
    ];
    for (const path of failedPaths) {
      expect(ready.artifacts).toContainEqual(
        expect.objectContaining({ path, status: "unavailable" }),
      );
      expect(archiveEntryPaths(messages)).not.toContain(path);
    }
    const collectorFailedPath = archivePaths.irNodePage(
      snapshotId,
      collectorFailedPage.id,
    );
    expect(ready.artifacts).toContainEqual(
      expect.objectContaining({
        path: collectorFailedPath,
        status: "unavailable",
      }),
    );
    expect(archiveEntryPaths(messages)).not.toContain(collectorFailedPath);
    const rawStabilizationFailedRawPath = archivePaths.rawRestPage(
      snapshotId,
      rawStabilizationFailedPage.id,
    );
    const rawStabilizationFailedCanonicalPath = archivePaths.irNodePage(
      snapshotId,
      rawStabilizationFailedPage.id,
    );
    expect(ready.artifacts).toContainEqual(
      expect.objectContaining({
        path: rawStabilizationFailedRawPath,
        status: "unavailable",
      }),
    );
    expect(archiveEntryPaths(messages)).not.toContain(
      rawStabilizationFailedRawPath,
    );
    expect(archiveEntryPaths(messages)).toContain(
      rawStabilizationFailedCanonicalPath,
    );
    const oversizedPaths = [
      archivePaths.rawRestPage(snapshotId, lastPage.id),
      archivePaths.vectorAsset(snapshotId, oversizedVector.id),
      archivePaths.preview(snapshotId, lastRoot.id),
    ];
    for (const path of oversizedPaths) {
      expect(ready.artifacts).toContainEqual(
        expect.objectContaining({ path, status: "unavailable" }),
      );
      expect(archiveEntryPaths(messages)).not.toContain(path);
    }
    expect(archiveEntryPaths(messages)).toEqual(
      expect.arrayContaining([
        archivePaths.rawRestPage(snapshotId, firstPage.id),
        archivePaths.irNodePage(snapshotId, firstPage.id),
        archivePaths.rawRestPage(snapshotId, collectorFailedPage.id),
        rawStabilizationFailedCanonicalPath,
        archivePaths.irNodePage(snapshotId, lastPage.id),
        archivePaths.vectorAsset(snapshotId, retainedVector.id),
        archivePaths.preview(snapshotId, firstRoot.id),
      ]),
    );
    const diagnostics = parseMessageJson(
      messages,
      archivePaths.diagnostics(snapshotId),
    );
    const diagnosticItems = diagnostics.diagnostics as readonly Record<
      string,
      unknown
    >[];
    expect(
      diagnosticItems.filter(
        (diagnostic) =>
          diagnostic.code === "PAGE_LOAD_FAILED" &&
          (diagnostic.source as Record<string, unknown> | undefined)?.id ===
            failedPage.id,
      ),
    ).toHaveLength(2);
    expect(
      diagnosticItems.filter(
        (diagnostic) =>
          diagnostic.code === "PAGE_LOAD_FAILED" &&
          (diagnostic.source as Record<string, unknown> | undefined)?.id ===
            lastPage.id,
      ),
    ).toHaveLength(0);
    expect(
      diagnosticItems.find(
        (diagnostic) =>
          diagnostic.code === "PAGE_COLLECTION_FAILED" &&
          (diagnostic.source as Record<string, unknown> | undefined)?.id ===
            collectorFailedPage.id,
      ),
    ).toMatchObject({
      artifactPath: collectorFailedPath,
      propertyPath: "$.children",
      causedDataLoss: true,
    });
    expect(
      diagnosticItems.filter(
        (diagnostic) =>
          diagnostic.code === DIAGNOSTIC_CODES.rawExportFailed &&
          (diagnostic.source as Record<string, unknown> | undefined)?.id ===
            rawStabilizationFailedPage.id,
      ),
    ).toEqual([
      expect.objectContaining({
        artifactPath: rawStabilizationFailedRawPath,
        phase: "raw",
        causedDataLoss: true,
      }),
    ]);
    expect(
      diagnosticItems.filter(
        (diagnostic) =>
          diagnostic.code === DIAGNOSTIC_CODES.rawExportFailed &&
          (diagnostic.source as Record<string, unknown> | undefined)?.id ===
            lastPage.id,
      ),
    ).toHaveLength(0);
    const oversizedDiagnostics = diagnosticItems.filter(
      (diagnostic) => diagnostic.code === DIAGNOSTIC_CODES.archiveEntryTooLarge,
    );
    expect(oversizedDiagnostics).toHaveLength(5);
    const lateRawCapacityDiagnostic = oversizedDiagnostics.find(
      (diagnostic) =>
        (diagnostic.source as Record<string, unknown> | undefined)?.id ===
          lastPage.id && diagnostic.phase === "raw",
    );
    expect(lateRawCapacityDiagnostic).toMatchObject({
      artifactPath: archivePaths.rawRestPage(snapshotId, lastPage.id),
    });
    const lastPageArtifact = parseMessageJson(
      messages,
      archivePaths.irNodePage(snapshotId, lastPage.id),
    ) as { readonly diagnosticIds: readonly string[] };
    expect(lastPageArtifact.diagnosticIds).toContain(
      lateRawCapacityDiagnostic?.id,
    );
    const pageCapacityDiagnostic = oversizedDiagnostics.find(
      (diagnostic) =>
        (diagnostic.source as Record<string, unknown> | undefined)?.id ===
          firstPage.id && diagnostic.phase === "serialization",
    );
    expect(pageCapacityDiagnostic).toMatchObject({
      artifactPath: archivePaths.irNodePage(snapshotId, firstPage.id),
      propertyPath: "$.normalizedTrees",
      causedDataLoss: true,
      severity: "error",
    });
    expect(
      oversizedDiagnostics.find(
        (diagnostic) =>
          (diagnostic.source as Record<string, unknown> | undefined)?.id ===
          oversizedVector.id,
      ),
    ).toMatchObject({
      artifactPath: archivePaths.vectorAsset(snapshotId, oversizedVector.id),
      phase: "asset",
    });
    expect(
      oversizedDiagnostics.find(
        (diagnostic) =>
          diagnostic.phase === "asset" &&
          (diagnostic.source as Record<string, unknown> | undefined)?.id ===
            firstRoot.id,
      ),
    ).not.toHaveProperty("artifactPath");
    expect(
      oversizedDiagnostics.find(
        (diagnostic) =>
          (diagnostic.source as Record<string, unknown> | undefined)?.id ===
          lastRoot.id,
      ),
    ).toMatchObject({
      artifactPath: archivePaths.preview(snapshotId, lastRoot.id),
    });
    expect(JSON.stringify(diagnostics)).not.toContain(
      "INVENTED_PAGE_DETAIL_MUST_NOT_ESCAPE",
    );
    expect(JSON.stringify(diagnostics)).not.toContain(
      "INVENTED_TRANSIENT_LOAD_DETAIL",
    );
    expect(JSON.stringify(diagnostics)).not.toContain(
      "INVENTED_PAGE_CHILDREN_DETAIL_MUST_NOT_ESCAPE",
    );
    expect(JSON.stringify(diagnostics)).not.toContain(
      "INVENTED_RAW_STABILIZATION_DETAIL_MUST_NOT_ESCAPE",
    );
    expect(JSON.stringify(diagnostics)).not.toContain(
      "INVENTED_TRANSIENT_RAW_STABILIZATION_DETAIL_MUST_NOT_ESCAPE",
    );
    expect(
      (firstPage.exportAsync as ReturnType<typeof vi.fn>).mock.calls,
    ).toHaveLength(2);
    expect(
      (failedPage.exportAsync as ReturnType<typeof vi.fn>).mock.calls,
    ).toHaveLength(0);
    expect(
      (collectorFailedPage.exportAsync as ReturnType<typeof vi.fn>).mock.calls,
    ).toHaveLength(2);
    expect(
      (rawStabilizationFailedPage.exportAsync as ReturnType<typeof vi.fn>).mock
        .calls,
    ).toHaveLength(2);
    expect(
      (lastPage.exportAsync as ReturnType<typeof vi.fn>).mock.calls,
    ).toHaveLength(3);

    const completed = await finalizeMessages(snapshotId, messages);
    expect(completed.manifest.completeness).toBe("incomplete");
    expect(completed.manifest.diagnosticCounts.error).toBe(9);
    expect(completed.manifest.diagnosticCounts.fatal).toBe(0);
    const files = unzipSync(concatenate(completed.chunks));
    expect(files[archivePaths.manifest(snapshotId)]).toBeDefined();
    expect(files[failedPaths[0]!]).toBeUndefined();
    expect(files[failedPaths[1]!]).toBeUndefined();
    expect(
      files[archivePaths.rawRestPage(snapshotId, collectorFailedPage.id)],
    ).toBeDefined();
    expect(files[collectorFailedPath]).toBeUndefined();
    expect(files[rawStabilizationFailedRawPath]).toBeUndefined();
    expect(files[rawStabilizationFailedCanonicalPath]).toBeDefined();
    expect(files[oversizedPaths[0]!]).toBeUndefined();
    expect(files[oversizedPaths[1]!]).toBeUndefined();
    expect(files[oversizedPaths[2]!]).toBeUndefined();
    const firstPageText = strFromU8(
      files[archivePaths.irNodePage(snapshotId, firstPage.id)]!,
    );
    const firstPageArtifact = JSON.parse(firstPageText) as {
      readonly childNodeIds: readonly string[];
      readonly normalizedTrees: readonly unknown[];
      readonly rawArtifact?: { readonly path: string };
      readonly assets: readonly { readonly archivePath: string }[];
      readonly previews: readonly { readonly archivePath: string }[];
      readonly coverage: {
        readonly textSegments: { readonly status: string };
        readonly annotationsAndAccessibility: { readonly status: string };
      };
      readonly diagnosticIds: readonly string[];
    };
    expect(firstPageArtifact.childNodeIds).toEqual([firstRoot.id]);
    expect(firstPageArtifact.normalizedTrees).toEqual([]);
    expect(firstPageArtifact.rawArtifact?.path).toBe(
      archivePaths.rawRestPage(snapshotId, firstPage.id),
    );
    expect(
      firstPageArtifact.assets.map((asset) => asset.archivePath),
    ).toContain(archivePaths.vectorAsset(snapshotId, retainedVector.id));
    expect(
      firstPageArtifact.previews.map((preview) => preview.archivePath),
    ).toContain(archivePaths.preview(snapshotId, firstRoot.id));
    expect(firstPageArtifact.coverage.textSegments.status).toBe("partial");
    expect(firstPageArtifact.coverage.annotationsAndAccessibility.status).toBe(
      "partial",
    );
    expect(firstPageArtifact.diagnosticIds).toContain(
      pageCapacityDiagnostic?.id,
    );
    const firstPageMarkdown = strFromU8(
      files[archivePaths.agentPage(snapshotId, firstPage.id)]!,
    );
    expect(firstPageMarkdown.replaceAll("\\", "")).toContain(
      String(pageCapacityDiagnostic?.id),
    );
    expect(firstPageMarkdown).toContain(
      "Normalized node count represented here: 0",
    );
    expect(firstPageText).not.toContain(LARGE_UNICODE_TEXT);
    expect(
      files[archivePaths.vectorAsset(snapshotId, retainedVector.id)],
    ).toBeDefined();
    expect(files[archivePaths.preview(snapshotId, firstRoot.id)]).toBeDefined();
    expect(
      files[archivePaths.irNodePage(snapshotId, lastPage.id)],
    ).toBeDefined();
  });

  it("marks the exact component count partial when a root's child traversal is inaccessible", async () => {
    const runtime = await loadEntireFileTestRuntime();
    const snapshotId = requireSnapshotId("entire-file-partial-component-count");
    const events: string[] = [];
    const hiddenDefinition = makeComponent("component:inaccessible-child", []);
    const root = makeNode("node:inaccessible-children", "FRAME", {
      children: [hiddenDefinition],
    });
    const page = makePage("page:inaccessible-children", {
      events,
      children: [root],
    });
    const harness = createApi([page]);
    Object.defineProperty(root, "children", {
      configurable: true,
      get: () => {
        throw new Error("INVENTED_CHILD_DETAIL_MUST_NOT_ESCAPE");
      },
    });
    const messages: ExportProducerMessage[] = [];

    await withGlobalFigma(harness.api, async () => {
      await runtime.runEntireFileExport({
        exportId: "export:partial-component-count",
        requestId: "request:partial-component-count",
        snapshotId,
        cancellation: new runtime.ExportCancellationToken(),
        api: harness.api,
        exportedAtUtc: "2026-08-15T00:00:00.000Z",
        postMessage: (message) => {
          messages.push(message);
        },
      });
    });

    const document = parseMessageJson(
      messages,
      archivePaths.irDocument(snapshotId),
    );
    const counts = document.counts as Record<string, unknown>;
    expect(counts.localComponents).toEqual({
      status: "partial",
      value: 0,
      coverage: "file-local",
      reason:
        "One or more pages could not contribute to the exact file-local component count.",
    });
    const diagnostics = parseMessageJson(
      messages,
      archivePaths.diagnostics(snapshotId),
    );
    expect(JSON.stringify(diagnostics)).not.toContain(
      "INVENTED_CHILD_DETAIL_MUST_NOT_ESCAPE",
    );

    const completed = await finalizeMessages(snapshotId, messages);
    expect(completed.manifest.completeness).toBe("incomplete");
    expect(
      unzipSync(concatenate(completed.chunks))[
        archivePaths.irNodePage(snapshotId, page.id)
      ],
    ).toBeDefined();
  });

  it("cooperatively cancels at page, raw stabilization, raw emission, image, preview, and bounded archive-ack boundaries without finalizing a ZIP", async () => {
    const runtime = await loadEntireFileTestRuntime();
    const scenarios = [
      "page-load",
      "raw-stabilization",
      "component-lookup",
      "raw-emission",
      "image-read",
      "preview-export",
      "archive-ack",
    ] as const;
    for (const scenario of scenarios) {
      const snapshotId = requireSnapshotId(`entire-file-cancel-${scenario}`);
      const events: string[] = [];
      const entered = deferred<void>();
      const pageGate = deferred<void>();
      const rawStabilizationGate =
        deferred<Readonly<Record<string, unknown>>>();
      const rawEmissionGate = deferred<Readonly<Record<string, unknown>>>();
      const componentLookupGate = deferred<FakeNode>();
      const imageGate = deferred<Uint8Array>();
      const previewGate = deferred<Uint8Array>();
      const archiveAckGate = deferred<void>();
      let acknowledgementPreviewExports = 0;
      let rawEmissionImageReads = 0;
      let rawEmissionPreviewExports = 0;
      let previewEntriesPosted = 0;
      let previewEntriesAccepted = 0;
      let archiveEntriesInFlight = 0;
      let maximumArchiveEntriesInFlight = 0;
      const componentLookupDefinition = makeComponent(
        "component:cancel-lookup",
        [],
      );
      const root =
        scenario === "component-lookup"
          ? makeNode("instance:cancel-lookup", "INSTANCE", {
              extra: {
                componentProperties: {},
                componentPropertyReferences: null,
                overrides: [],
                exposedInstances: [],
                isExposedInstance: false,
                scaleFactor: 1,
                getMainComponentAsync: async () => {
                  entered.resolve();
                  return await componentLookupGate.promise;
                },
              },
            })
          : makeNode(`node:${scenario}`, "FRAME", {
              ...(scenario === "image-read" || scenario === "raw-emission"
                ? { fills: imageFill() }
                : {}),
              ...(scenario === "preview-export" || scenario === "raw-emission"
                ? {
                    exportOverride: async (settings) => {
                      if (settings.format === "JSON_REST_V1") {
                        return { id: `node:${scenario}`, invented: true };
                      }
                      if (settings.format === "PNG") {
                        if (scenario === "preview-export") {
                          entered.resolve();
                          return await previewGate.promise;
                        }
                        rawEmissionPreviewExports += 1;
                        return SYNTHETIC_PNG;
                      }
                      throw new Error("Unexpected invented preview format.");
                    },
                  }
                : {}),
            });
      const roots =
        scenario === "archive-ack"
          ? Array.from({ length: 64 }, (_, index) =>
              makeNode(
                `node:archive-ack-${index.toString().padStart(2, "0")}`,
                "FRAME",
                {
                  exportOverride: (settings) => {
                    if (settings.format === "PNG") {
                      acknowledgementPreviewExports += 1;
                      return Promise.resolve(SYNTHETIC_PNG);
                    }
                    return Promise.reject(
                      new Error("Unexpected invented archive-ack format."),
                    );
                  },
                },
              ),
            )
          : [root];
      const page = makePage(`page:${scenario}`, {
        events,
        children: roots,
        ...(scenario === "raw-stabilization"
          ? {
              rawExport: async () => {
                entered.resolve();
                return await rawStabilizationGate.promise;
              },
            }
          : {}),
        ...(scenario === "raw-emission"
          ? {
              rawExport: async (callNumber: number) => {
                if (callNumber === 1) {
                  return { invented: true };
                }
                entered.resolve();
                return await rawEmissionGate.promise;
              },
            }
          : {}),
        ...(scenario === "page-load"
          ? {
              load: async () => {
                entered.resolve();
                await pageGate.promise;
              },
            }
          : {}),
      });
      const harness = createApi([page], {
        ...(scenario === "image-read" || scenario === "raw-emission"
          ? {
              getBytesAsync: async () => {
                if (scenario === "image-read") {
                  entered.resolve();
                  return await imageGate.promise;
                }
                rawEmissionImageReads += 1;
                return SYNTHETIC_PNG;
              },
            }
          : {}),
      });
      const messages: ExportProducerMessage[] = [];
      const cancellation = new runtime.ExportCancellationToken();
      const postMessage = async (
        message: ExportProducerMessage,
      ): Promise<void> => {
        messages.push(message);
        if (scenario !== "archive-ack" || message.type !== "archive-entry") {
          return;
        }
        archiveEntriesInFlight += 1;
        maximumArchiveEntriesInFlight = Math.max(
          maximumArchiveEntriesInFlight,
          archiveEntriesInFlight,
        );
        try {
          if (!message.path.includes("/previews/")) {
            return;
          }
          previewEntriesPosted += 1;
          if (previewEntriesPosted === 33) {
            entered.resolve();
            await archiveAckGate.promise;
            return;
          }
          previewEntriesAccepted += 1;
        } finally {
          archiveEntriesInFlight -= 1;
        }
      };
      const runPromise = withGlobalFigma(harness.api, async () =>
        runtime.runEntireFileExport({
          exportId: `export:${scenario}`,
          requestId: `request:${scenario}`,
          snapshotId,
          cancellation,
          api: harness.api,
          exportedAtUtc: "2026-08-15T00:00:00.000Z",
          postMessage,
        }),
      );

      await entered.promise;
      if (scenario === "raw-emission") {
        expect(
          (page.exportAsync as ReturnType<typeof vi.fn>).mock.calls,
        ).toHaveLength(2);
        expect(rawEmissionImageReads).toBe(1);
        expect(rawEmissionPreviewExports).toBe(1);
        expect(
          archiveEntryPaths(messages).some((path) =>
            path.includes("/assets/raster/"),
          ),
        ).toBe(true);
        expect(archiveEntryPaths(messages)).toContain(
          archivePaths.preview(snapshotId, root.id),
        );
      } else if (scenario === "component-lookup") {
        const pendingProgress = messages.find(
          (message): message is ProgressMessage =>
            message.type === "progress" &&
            message.currentLabel?.includes("instance resolution") === true,
        );
        expect(pendingProgress).toMatchObject({ phase: "collection" });
        expect(pendingProgress?.total).toBeUndefined();
        expect(pendingProgress?.currentLabel).toMatch(
          /^Page 1 of 1; instance resolution; \d+ nodes; \d+\/\d+ instance lookups; \d+\/\d+ dependency lookups; \d+ definitions; \d+ reused; \d+ duplicate queues skipped$/u,
        );
      }
      cancellation.cancel();
      cancellation.cancel();
      if (scenario === "page-load") {
        pageGate.resolve();
      } else if (scenario === "raw-stabilization") {
        rawStabilizationGate.resolve({ invented: true });
      } else if (scenario === "raw-emission") {
        rawEmissionGate.resolve({ invented: true });
      } else if (scenario === "component-lookup") {
        componentLookupGate.resolve(componentLookupDefinition);
      } else if (scenario === "image-read") {
        imageGate.resolve(SYNTHETIC_PNG);
      } else if (scenario === "preview-export") {
        previewGate.resolve(SYNTHETIC_PNG);
      } else {
        archiveAckGate.reject(new runtime.ExportCancelledError());
      }
      await expect(runPromise).rejects.toBeInstanceOf(
        runtime.ExportCancelledError,
      );
      if (scenario === "archive-ack") {
        expect(maximumArchiveEntriesInFlight).toBe(1);
        expect(previewEntriesPosted).toBe(33);
        expect(previewEntriesAccepted).toBe(32);
        expect(acknowledgementPreviewExports).toBe(33);
        expect(archiveEntriesInFlight).toBe(0);
      }
      expect(messages.some((message) => message.type === "export-ready")).toBe(
        false,
      );
      if (
        scenario === "page-load" ||
        scenario === "raw-stabilization" ||
        scenario === "component-lookup"
      ) {
        expect(archiveEntryPaths(messages)).toEqual([]);
      }
      expect(archiveEntryPaths(messages)).not.toContain(
        archivePaths.manifest(snapshotId),
      );
      if (scenario === "raw-emission") {
        expect(archiveEntryPaths(messages)).not.toContain(
          archivePaths.rawRestPage(snapshotId, page.id),
        );
      }

      const partialBuilder = new StreamingArchiveBuilder(
        snapshotId,
        archiveRuntime(),
      );
      for (const message of messages) {
        if (message.type === "archive-entry") {
          await partialBuilder.addEntry(descriptorFromMessage(message));
        }
      }
      if (scenario === "raw-emission") {
        expect(partialBuilder.entryCount).toBeGreaterThan(0);
      }
      expect(partialBuilder.state).toBe("active");
      partialBuilder.cancel();
      expect(partialBuilder.state).toBe("cancelled");
      expect(partialBuilder.entryCount).toBe(0);
    }
  });
});
