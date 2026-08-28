import { describe, expect, it, vi } from "vitest";

import { ExportCancellationToken } from "../src/main/cancellation";
import {
  AssetCollectionSession,
  detectRasterFormat,
  isStructurallyValidSvg,
  selectVectorAssetCandidates,
  type AssetArchiveEmitter,
  type AssetExportNode,
} from "../src/main/collect-assets";
import { exportSelectedRootPreview } from "../src/main/export-preview";
import { requireSnapshotId } from "../src/shared/archive";
import {
  DIAGNOSTIC_CODES,
  DiagnosticBag,
  summarizeDiagnostics,
} from "../src/shared/diagnostics";
import type {
  AssetRefIR,
  ContainerNodeIR,
  NodeIR,
  PaintIR,
  StylesIndexIR,
  VectorNodeIR,
} from "../src/shared/ir";
import { planPreviewExport } from "../src/shared/png";
import { sha256Hex } from "../src/shared/sha256";

const SNAPSHOT_ID = requireSnapshotId("synthetic-media");

function imagePaint(imageHash: string | null): PaintIR {
  return {
    paintType: "IMAGE",
    imageHash,
    scaleMode: "FILL",
  };
}

function containerNode(
  id: string,
  children: readonly NodeIR[] = [],
  imageHashes: readonly (string | null)[] = [],
  exportSettings?: ContainerNodeIR["exportSettings"],
): ContainerNodeIR {
  return {
    family: "container",
    source: { kind: "node", id, name: `Invented ${id}` },
    nodeType: "FRAME",
    children,
    ...(imageHashes.length === 0
      ? {}
      : { visual: { fills: imageHashes.map((hash) => imagePaint(hash)) } }),
    ...(exportSettings === undefined ? {} : { exportSettings }),
    assetRefs: [],
    diagnosticIds: [],
  };
}

function vectorNode(
  id: string,
  children: readonly NodeIR[] = [],
  exportSettings?: VectorNodeIR["exportSettings"],
): VectorNodeIR {
  return {
    family: "vector",
    source: { kind: "node", id, name: `Invented ${id}` },
    nodeType: "VECTOR",
    vector: {
      vectorPaths: [
        { data: `M0 0 L${id.length} ${id.length} Z`, windingRule: "NONZERO" },
      ],
    },
    children,
    ...(exportSettings === undefined ? {} : { exportSettings }),
    assetRefs: [],
    diagnosticIds: [],
  };
}

interface EmittedAsset {
  readonly path: string;
  readonly mediaType: string;
  readonly compression: "deflate" | "store";
  readonly data: string | Uint8Array;
}

function emitterHarness(): {
  readonly emitted: EmittedAsset[];
  readonly unavailable: {
    readonly path: string;
    readonly diagnosticId: string;
  }[];
  readonly emitter: AssetArchiveEmitter;
} {
  const emitted: EmittedAsset[] = [];
  const unavailable: {
    readonly path: string;
    readonly diagnosticId: string;
  }[] = [];
  return {
    emitted,
    unavailable,
    emitter: {
      emit: (path, mediaType, compression, data) => {
        emitted.push({ path, mediaType, compression, data });
      },
      unavailable: (path, diagnosticId) => {
        unavailable.push({ path, diagnosticId });
      },
    },
  };
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

describe("Raster, vector, and preview fidelity", () => {
  it("detects PNG, JPEG, both GIF signatures, WebP, and unknown bytes by magic only", () => {
    const cases = [
      {
        bytes: Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10, 91),
        expected: { extension: "png", mediaType: "image/png", known: true },
      },
      {
        bytes: Uint8Array.of(255, 216, 255, 224, 41),
        expected: { extension: "jpg", mediaType: "image/jpeg", known: true },
      },
      {
        bytes: Uint8Array.of(71, 73, 70, 56, 55, 97, 17),
        expected: { extension: "gif", mediaType: "image/gif", known: true },
      },
      {
        bytes: Uint8Array.of(71, 73, 70, 56, 57, 97, 23),
        expected: { extension: "gif", mediaType: "image/gif", known: true },
      },
      {
        bytes: Uint8Array.of(82, 73, 70, 70, 4, 0, 0, 0, 87, 69, 66, 80),
        expected: { extension: "webp", mediaType: "image/webp", known: true },
      },
      {
        bytes: Uint8Array.of(10, 20, 30, 40),
        expected: {
          extension: "bin",
          mediaType: "application/octet-stream",
          known: false,
        },
      },
    ] as const;
    for (const fixture of cases) {
      expect(detectRasterFormat(fixture.bytes)).toEqual(fixture.expected);
    }
  });

  it("deduplicates image reads by Figma hash and entries by SHA-256 across roots and paint-style definitions", async () => {
    const originalBytes = Uint8Array.of(
      137,
      80,
      78,
      71,
      13,
      10,
      26,
      10,
      101,
      202,
    );
    const getBytesAsync = vi.fn(() => Promise.resolve(originalBytes));
    const getImageByHash = vi.fn((hash: string) => ({
      getBytesAsync,
      syntheticHash: hash,
    }));
    const diagnostics = new DiagnosticBag("media-dedup");
    const harness = emitterHarness();
    const session = new AssetCollectionSession({
      snapshotId: SNAPSHOT_ID,
      diagnostics,
      cancellation: new ExportCancellationToken(),
      emitter: harness.emitter,
      api: { getImageByHash },
    });
    const tree = containerNode("node:root", [
      containerNode("node:first", [], ["image:one", "image:one"]),
      containerNode("node:second", [], ["image:one"]),
      containerNode("node:third", [], ["image:two"]),
    ]);
    const collected = await session.collectTree(tree, new Map());
    const styleArtifact: StylesIndexIR = {
      kind: "design-ir-styles",
      schemaVersion: "1.0.0",
      styles: [
        {
          styleType: "paint",
          source: {
            kind: "style",
            id: "style:synthetic-image",
            name: "Invented image paint",
          },
          paints: [imagePaint("image:style")],
          assetRefs: [],
          variableBindings: [],
          referencedBy: [{ kind: "node", id: "node:first" }],
          diagnosticIds: [],
        },
      ],
      diagnosticIds: [],
    };
    const styles = await session.collectStyles(styleArtifact);

    expect(getImageByHash.mock.calls.map(([hash]) => hash)).toEqual([
      "image:one",
      "image:two",
      "image:style",
    ]);
    expect(getBytesAsync).toHaveBeenCalledTimes(3);
    expect(harness.emitted).toHaveLength(1);
    expect(harness.emitted[0]).toMatchObject({
      mediaType: "image/png",
      compression: "store",
      path: `${SNAPSHOT_ID}/assets/raster/${sha256Hex(originalBytes)}.png`,
    });
    expect(harness.emitted[0]?.data).toEqual(originalBytes);
    expect(collected.assets).toHaveLength(2);
    expect(new Set(collected.assets.map((asset) => asset.archivePath))).toEqual(
      new Set([harness.emitted[0]?.path]),
    );
    const paintStyle = styles.artifact.styles.find(
      (style) => style.styleType === "paint",
    );
    expect(paintStyle?.styleType).toBe("paint");
    if (paintStyle?.styleType === "paint") {
      expect(paintStyle.assetRefs).toHaveLength(1);
      expect(paintStyle.assetRefs[0]).toMatchObject({
        imageHash: "image:style",
        contentSha256: sha256Hex(originalBytes),
        byteLength: originalBytes.byteLength,
        archivePath: harness.emitted[0]?.path,
      });
    }
    expect(
      diagnostics
        .list()
        .filter(
          (diagnostic) =>
            diagnostic.code === DIAGNOSTIC_CODES.rasterContentDeduplicated,
        ),
    ).toHaveLength(2);
    expect(JSON.stringify({ tree: collected.tree, styles })).not.toContain(
      "base64",
    );
  });

  it("exports only eligible vector roots, preserves nested geometry, and applies explicit SVG options exactly", async () => {
    const nested = vectorNode("node:nested");
    const explicitNested = vectorNode(
      "node:explicit-nested",
      [],
      [
        {
          format: "SVG",
          contentsOnly: false,
          useAbsoluteBounds: true,
          colorProfile: "SRGB",
          svgOutlineText: false,
          svgIdAttribute: true,
          svgSimplifyStroke: false,
        },
      ],
    );
    const automaticRoot = vectorNode("node:automatic", [
      nested,
      explicitNested,
    ]);
    const nestedUnderExplicitFrame = vectorNode("node:frame-child");
    const explicitFrame = containerNode(
      "node:explicit-frame",
      [nestedUnderExplicitFrame],
      [],
      [{ format: "SVG", contentsOnly: true }],
    );
    const tree = containerNode("node:root", [automaticRoot, explicitFrame]);
    expect(
      selectVectorAssetCandidates(tree).map((item) => item.nodeId),
    ).toEqual([
      "node:automatic",
      "node:explicit-nested",
      "node:explicit-frame",
    ]);

    const exports = new Map<string, ReturnType<typeof vi.fn>>();
    const nodesById = new Map<string, AssetExportNode>();
    for (const id of [
      "node:automatic",
      "node:explicit-nested",
      "node:explicit-frame",
    ]) {
      const exportAsync = vi.fn(() =>
        Promise.resolve(
          `<svg aria-label="Синтетика 图标 🚀" data-node="${id}"></svg>\n\n`,
        ),
      );
      exports.set(id, exportAsync);
      nodesById.set(id, { exportAsync });
    }
    const diagnostics = new DiagnosticBag("media-vector");
    const harness = emitterHarness();
    const session = new AssetCollectionSession({
      snapshotId: SNAPSHOT_ID,
      diagnostics,
      cancellation: new ExportCancellationToken(),
      emitter: harness.emitter,
      api: { getImageByHash: () => null },
    });
    const originalGeometry = structuredClone(automaticRoot.vector);
    const collected = await session.collectTree(tree, nodesById);

    expect(harness.emitted).toHaveLength(3);
    expect(
      harness.emitted.every(
        (entry) =>
          entry.mediaType === "image/svg+xml" &&
          entry.compression === "deflate" &&
          typeof entry.data === "string" &&
          entry.data.endsWith("\n") &&
          !entry.data.endsWith("\n\n"),
      ),
    ).toBe(true);
    expect(exports.get("node:explicit-nested")).toHaveBeenCalledWith({
      format: "SVG_STRING",
      contentsOnly: false,
      useAbsoluteBounds: true,
      colorProfile: "SRGB",
      svgOutlineText: false,
      svgIdAttribute: true,
      svgSimplifyStroke: false,
    });
    expect(collected.assets.map((asset) => asset.assetKind)).toEqual([
      "vector",
      "vector",
      "vector",
    ]);
    const explicitReference = collected.assets.find(
      (asset): asset is Extract<AssetRefIR, { assetKind: "vector" }> =>
        asset.assetKind === "vector" &&
        asset.node.id === "node:explicit-nested",
    );
    expect(explicitReference).toMatchObject({
      eligibility: "explicit-svg-setting",
      mediaType: "image/svg+xml",
      exportSettings: { format: "SVG_STRING", colorProfile: "SRGB" },
    });
    const explicitEntry = harness.emitted.find((entry) =>
      entry.path.endsWith("node%3Aexplicit-nested.svg"),
    );
    if (typeof explicitEntry?.data !== "string") {
      throw new Error("Expected invented SVG text.");
    }
    const explicitBytes = new TextEncoder().encode(explicitEntry.data);
    expect(explicitReference?.byteLength).toBe(explicitBytes.byteLength);
    expect(explicitReference?.contentSha256).toBe(sha256Hex(explicitBytes));
    expect(automaticRoot.vector).toEqual(originalGeometry);
    expect(JSON.stringify(collected.tree)).toContain("node:nested");
    expect(JSON.stringify(collected.tree)).toContain("node:frame-child");
    expect(diagnostics.list()).toEqual([]);
  });

  it("rejects malformed SVG API output as an isolated diagnosed asset failure", async () => {
    const malformedVector = vectorNode("node:malformed-vector");
    const diagnostics = new DiagnosticBag("media-malformed-svg");
    const harness = emitterHarness();
    const session = new AssetCollectionSession({
      snapshotId: SNAPSHOT_ID,
      diagnostics,
      cancellation: new ExportCancellationToken(),
      emitter: harness.emitter,
      api: { getImageByHash: () => null },
    });

    expect(isStructurallyValidSvg("<svg><g></g></svg>\n")).toBe(true);
    expect(isStructurallyValidSvg("<svg><g></svg>\n")).toBe(false);
    const collected = await session.collectTree(
      malformedVector,
      new Map<string, AssetExportNode>([
        [
          malformedVector.source.id,
          {
            exportAsync: () => Promise.resolve("<svg><g></svg>"),
          },
        ],
      ]),
    );

    expect(collected.complete).toBe(false);
    expect(collected.assets).toEqual([]);
    expect(harness.emitted).toEqual([]);
    expect(harness.unavailable).toEqual([
      expect.objectContaining({
        path: `${SNAPSHOT_ID}/assets/vector/node%3Amalformed-vector.svg`,
      }),
    ]);
    expect(diagnostics.list()).toHaveLength(1);
    expect(diagnostics.list()[0]).toMatchObject({
      code: DIAGNOSTIC_CODES.vectorExportFailed,
      severity: "error",
      source: { id: "node:malformed-vector" },
      causedDataLoss: true,
    });
    expect(JSON.stringify(diagnostics.list())).not.toContain(
      "SVG export returned malformed XML.",
    );
  });

  it("plans 1x and longest-dimension-bounded previews deterministically", () => {
    expect(planPreviewExport(640, 480)).toEqual({
      constraint: { type: "SCALE", value: 1 },
      scale: 1,
    });
    expect(planPreviewExport(6000, 3000)).toEqual({
      constraint: { type: "WIDTH", value: 4096 },
      scale: 4096 / 6000,
    });
    expect(planPreviewExport(1200, 9600)).toEqual({
      constraint: { type: "HEIGHT", value: 4096 },
      scale: 4096 / 9600,
    });
    expect(() => planPreviewExport(0, 50)).toThrow();
  });

  it("continues past isolated raster and vector failures with source-attributed loss diagnostics", async () => {
    const goodRaster = Uint8Array.of(255, 216, 255, 224, 67, 89, 123);
    const oversizedRaster = new Uint8Array(41);
    const goodVector = vectorNode("node:good-vector");
    const badVector = vectorNode("node:bad-vector");
    const oversizedVector = vectorNode("node:oversized-vector");
    const tree = containerNode("node:failure-root", [
      containerNode("node:good-raster", [], ["image:good"]),
      containerNode("node:bad-raster", [], ["image:bad"]),
      containerNode("node:oversized-raster", [], ["image:oversized"]),
      containerNode("node:missing-hash", [], [null]),
      goodVector,
      badVector,
      oversizedVector,
    ]);
    const diagnostics = new DiagnosticBag("media-failures");
    const harness = emitterHarness();
    const session = new AssetCollectionSession({
      snapshotId: SNAPSHOT_ID,
      diagnostics,
      cancellation: new ExportCancellationToken(),
      entryByteLimit: 40,
      emitter: harness.emitter,
      api: {
        getImageByHash: (hash) => ({
          getBytesAsync: () => {
            if (hash === "image:good") {
              return Promise.resolve(goodRaster);
            }
            if (hash === "image:oversized") {
              return Promise.resolve(oversizedRaster);
            }
            return Promise.reject(
              new Error("INVENTED_RASTER_DETAIL_MUST_NOT_ESCAPE"),
            );
          },
        }),
      },
    });
    const nodesById = new Map<string, AssetExportNode>([
      [
        goodVector.source.id,
        {
          exportAsync: () => Promise.resolve('<svg><path d="M0 0Z" /></svg>'),
        },
      ],
      [
        badVector.source.id,
        {
          exportAsync: () =>
            Promise.reject(new Error("INVENTED_SVG_DETAIL_MUST_NOT_ESCAPE")),
        },
      ],
      [
        oversizedVector.source.id,
        {
          exportAsync: () => Promise.resolve(`<svg>${"x".repeat(40)}</svg>`),
        },
      ],
    ]);
    const collected = await session.collectTree(tree, nodesById);

    expect(collected.complete).toBe(false);
    expect(
      collected.assets.some(
        (asset) =>
          asset.assetKind === "raster" && asset.imageHash === "image:good",
      ),
    ).toBe(true);
    expect(
      collected.assets.some(
        (asset) =>
          asset.assetKind === "vector" && asset.node.id === "node:good-vector",
      ),
    ).toBe(true);
    expect(JSON.stringify(collected.assets)).not.toContain("image:oversized");
    expect(JSON.stringify(collected.assets)).not.toContain(
      "node:oversized-vector",
    );
    expect(harness.emitted).toHaveLength(2);
    expect(harness.unavailable).toHaveLength(2);
    expect(
      diagnostics
        .list()
        .map((diagnostic) => [diagnostic.code, diagnostic.source?.id]),
    ).toEqual(
      expect.arrayContaining([
        [DIAGNOSTIC_CODES.rasterReadFailed, "node:bad-raster"],
        [DIAGNOSTIC_CODES.rasterImageHashMissing, "node:missing-hash"],
        [DIAGNOSTIC_CODES.vectorExportFailed, "node:bad-vector"],
        [DIAGNOSTIC_CODES.archiveEntryTooLarge, "node:oversized-raster"],
        [DIAGNOSTIC_CODES.archiveEntryTooLarge, "node:oversized-vector"],
      ]),
    );
    expect(
      diagnostics
        .list()
        .find(
          (diagnostic) => diagnostic.source?.id === "node:oversized-raster",
        ),
    ).not.toHaveProperty("artifactPath");
    expect(harness.unavailable).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: `${SNAPSHOT_ID}/assets/vector/node%3Aoversized-vector.svg`,
        }),
      ]),
    );
    expect(JSON.stringify(diagnostics.list())).not.toContain(
      "INVENTED_RASTER_DETAIL_MUST_NOT_ESCAPE",
    );
    expect(JSON.stringify(diagnostics.list())).not.toContain(
      "INVENTED_SVG_DETAIL_MUST_NOT_ESCAPE",
    );
  });

  it("records an isolated preview failure and still exports a later oversized preview with exact bounds, scale, and hash", async () => {
    const diagnostics = new DiagnosticBag("media-preview");
    const cancellation = new ExportCancellationToken();
    const failedRoot = {
      id: "node:preview-failed",
      name: "Invented failed preview",
      absoluteRenderBounds: { x: 5, y: 7, width: 300, height: 200 },
      exportAsync: () =>
        Promise.reject(new Error("INVENTED_PREVIEW_DETAIL_MUST_NOT_ESCAPE")),
    };
    const failed = await exportSelectedRootPreview(
      failedRoot,
      SNAPSHOT_ID,
      diagnostics,
      cancellation,
    );
    expect(failed).toHaveProperty("diagnosticId");

    const png = generatedPngHeader(4096, 2048);
    const exportAsync = vi.fn(() => Promise.resolve(png));
    const oversizedRoot = {
      id: "node:preview-wide",
      name: "Invented oversized preview",
      absoluteRenderBounds: { x: 11, y: 13, width: 8192, height: 4096 },
      exportAsync,
    };
    const succeeded = await exportSelectedRootPreview(
      oversizedRoot,
      SNAPSHOT_ID,
      diagnostics,
      cancellation,
    );
    expect(exportAsync).toHaveBeenCalledWith({
      format: "PNG",
      constraint: { type: "WIDTH", value: 4096 },
    });
    expect(succeeded).toMatchObject({
      bytes: png,
      preview: {
        sourceBounds: { x: 11, y: 13, width: 8192, height: 4096 },
        exportedBounds: { x: 0, y: 0, width: 4096, height: 2048 },
        scale: 0.5,
        byteLength: png.byteLength,
        contentSha256: sha256Hex(png),
      },
    });
    const tooLargePng = new Uint8Array(41);
    tooLargePng.set(png);
    const skipped = await exportSelectedRootPreview(
      {
        id: "node:preview-too-large",
        name: "Invented over-limit preview",
        absoluteRenderBounds: { x: 0, y: 0, width: 100, height: 100 },
        exportAsync: () => Promise.resolve(tooLargePng),
      },
      SNAPSHOT_ID,
      diagnostics,
      cancellation,
      40,
    );
    expect(skipped).toHaveProperty("diagnosticId");
    expect(summarizeDiagnostics(diagnostics.list()).completeness).toBe(
      "incomplete",
    );
    expect(diagnostics.list()[0]).toMatchObject({
      code: DIAGNOSTIC_CODES.previewExportFailed,
      source: { kind: "node", id: "node:preview-failed" },
      causedDataLoss: true,
    });
    expect(
      diagnostics
        .list()
        .find(
          (diagnostic) => diagnostic.source?.id === "node:preview-too-large",
        ),
    ).toMatchObject({
      code: DIAGNOSTIC_CODES.archiveEntryTooLarge,
      source: { kind: "node", id: "node:preview-too-large" },
      artifactPath: `${SNAPSHOT_ID}/previews/node%3Apreview-too-large.png`,
      causedDataLoss: true,
    });
    expect(JSON.stringify(diagnostics.list())).not.toContain(
      "INVENTED_PREVIEW_DETAIL_MUST_NOT_ESCAPE",
    );
  });
});
