import { strToU8 } from "fflate";

import {
  ArchiveProducerSafetyError,
  archivePaths,
  type SnapshotId,
} from "../shared/archive";
import {
  DIAGNOSTIC_CODES,
  normalizeSafeTechnicalCause,
  type DiagnosticBag,
  type SafeTechnicalCause,
} from "../shared/diagnostics";
import {
  type AssetRefIR,
  type ExportSettingIR,
  type NodeIR,
  type PaintIR,
  type PaintStyleIR,
  type RasterAssetRefIR,
  type SourceRef,
  type StylesIndexIR,
  type SvgStringExportSettingIR,
  type VectorAssetRefIR,
} from "../shared/ir";
import { ensureOneFinalNewline } from "../shared/serialization";
import { sha256Hex } from "../shared/sha256";
import {
  ExportCancellationToken,
  ExportCancelledError,
  yieldToFigma,
} from "./cancellation";
import { assertArchiveEntryFits } from "./archive-entry-preflight";

export type RasterExtension = "png" | "jpg" | "gif" | "webp" | "bin";
export type RasterMediaType = RasterAssetRefIR["mediaType"];

export interface DetectedRasterFormat {
  readonly extension: RasterExtension;
  readonly mediaType: RasterMediaType;
  readonly known: boolean;
}

export interface AssetArchiveEmitter {
  readonly emit: (
    path: string,
    mediaType: RasterMediaType | "image/svg+xml",
    compression: "deflate" | "store",
    data: string | Uint8Array,
  ) => void | Promise<void>;
  readonly unavailable: (path: string, diagnosticId: string) => void;
}

interface ReadableImage {
  getBytesAsync(): Promise<Uint8Array>;
}

export interface AssetCollectorApi {
  getImageByHash(hash: string): ReadableImage | null;
}

export interface AssetExportNode {
  exportAsync(settings: SvgStringExportSettingIR): Promise<string>;
}

export interface AssetCollectionSessionOptions {
  readonly snapshotId: SnapshotId;
  readonly diagnostics: DiagnosticBag;
  readonly cancellation: ExportCancellationToken;
  readonly emitter: AssetArchiveEmitter;
  readonly api?: AssetCollectorApi;
  readonly entryByteLimit?: number | undefined;
}

export interface CollectedTreeAssets {
  readonly tree: NodeIR;
  readonly assets: readonly AssetRefIR[];
  readonly complete: boolean;
  readonly diagnosticIds: readonly string[];
}

export interface CollectedStyleAssets {
  readonly artifact: StylesIndexIR;
  readonly complete: boolean;
  readonly diagnosticIds: readonly string[];
}

export interface AssetCollectionStats {
  readonly imageHashes: number;
  readonly rasterContents: number;
  readonly vectorNodes: number;
}

export interface VectorAssetCandidate {
  readonly nodeId: string;
  readonly eligibility: VectorAssetRefIR["eligibility"];
  readonly exportSettings: SvgStringExportSettingIR;
}

type RasterResolution =
  | {
      readonly status: "available";
      readonly reference: RasterAssetRefIR;
    }
  | {
      readonly status: "unavailable";
      readonly code:
        | typeof DIAGNOSTIC_CODES.archiveEntryTooLarge
        | typeof DIAGNOSTIC_CODES.rasterImageUnavailable
        | typeof DIAGNOSTIC_CODES.rasterReadFailed;
      readonly message: string;
      readonly artifactPath?: string;
      readonly technicalCause?: SafeTechnicalCause;
    };

type VectorResolution =
  | {
      readonly status: "available";
      readonly reference: VectorAssetRefIR;
    }
  | {
      readonly status: "unavailable";
      readonly diagnosticId: string;
    };

interface RasterReferenceSite {
  readonly imageHash: string | null;
  readonly propertyPath: string;
}

interface ContentAsset {
  readonly imageHash: string;
  readonly archivePath: string;
  readonly mediaType: RasterMediaType;
}

const VECTOR_PRIMITIVE_NODE_TYPES = new Set([
  "BOOLEAN_OPERATION",
  "ELLIPSE",
  "LINE",
  "POLYGON",
  "RECTANGLE",
  "STAR",
  "VECTOR",
]);

function hasPrefix(bytes: Uint8Array, signature: readonly number[]): boolean {
  return (
    bytes.length >= signature.length &&
    signature.every((byte, index) => bytes[index] === byte)
  );
}

export function detectRasterFormat(bytes: Uint8Array): DetectedRasterFormat {
  if (hasPrefix(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { extension: "png", mediaType: "image/png", known: true };
  }
  if (hasPrefix(bytes, [0xff, 0xd8, 0xff])) {
    return { extension: "jpg", mediaType: "image/jpeg", known: true };
  }
  if (
    hasPrefix(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
    hasPrefix(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
  ) {
    return { extension: "gif", mediaType: "image/gif", known: true };
  }
  if (
    bytes.length >= 12 &&
    hasPrefix(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return { extension: "webp", mediaType: "image/webp", known: true };
  }
  return {
    extension: "bin",
    mediaType: "application/octet-stream",
    known: false,
  };
}

function explicitSvgSettings(
  setting: ExportSettingIR,
): SvgStringExportSettingIR {
  const supportedColorProfile =
    setting.colorProfile === "DOCUMENT" ||
    setting.colorProfile === "SRGB" ||
    setting.colorProfile === "DISPLAY_P3_V4"
      ? setting.colorProfile
      : undefined;
  return {
    format: "SVG_STRING",
    ...(setting.suffix === undefined ? {} : { suffix: setting.suffix }),
    ...(setting.contentsOnly === undefined
      ? {}
      : { contentsOnly: setting.contentsOnly }),
    ...(setting.useAbsoluteBounds === undefined
      ? {}
      : { useAbsoluteBounds: setting.useAbsoluteBounds }),
    ...(supportedColorProfile === undefined
      ? {}
      : { colorProfile: supportedColorProfile }),
    ...(setting.svgOutlineText === undefined
      ? {}
      : { svgOutlineText: setting.svgOutlineText }),
    ...(setting.svgIdAttribute === undefined
      ? {}
      : { svgIdAttribute: setting.svgIdAttribute }),
    ...(setting.svgSimplifyStroke === undefined
      ? {}
      : { svgSimplifyStroke: setting.svgSimplifyStroke }),
  };
}

/**
 * Selects the Section 10 SVG roots in source-tree order. Explicit SVG settings
 * always win; automatic primitive exports stop beneath any SVG-exported root.
 */
export function selectVectorAssetCandidates(
  tree: NodeIR,
): readonly VectorAssetCandidate[] {
  const candidates: VectorAssetCandidate[] = [];
  const work: {
    readonly node: NodeIR;
    readonly hasExportedAncestor: boolean;
  }[] = [{ node: tree, hasExportedAncestor: false }];

  while (work.length > 0) {
    const item = work.pop();
    if (item === undefined) {
      continue;
    }
    const explicitSetting = item.node.exportSettings?.find(
      (setting) => setting.format === "SVG",
    );
    const automatic =
      explicitSetting === undefined &&
      VECTOR_PRIMITIVE_NODE_TYPES.has(item.node.nodeType) &&
      !item.hasExportedAncestor;
    const eligible = explicitSetting !== undefined || automatic;
    if (eligible) {
      candidates.push({
        nodeId: item.node.source.id,
        eligibility:
          explicitSetting === undefined
            ? "top-level-vector-root"
            : "explicit-svg-setting",
        exportSettings:
          explicitSetting === undefined
            ? { format: "SVG_STRING" }
            : explicitSvgSettings(explicitSetting),
      });
    }
    if ("children" in item.node) {
      for (let index = item.node.children.length - 1; index >= 0; index -= 1) {
        const child = item.node.children[index];
        if (child !== undefined) {
          work.push({
            node: child,
            hasExportedAncestor: item.hasExportedAncestor || eligible,
          });
        }
      }
    }
  }
  return candidates;
}

function appendPaintSites(
  sites: RasterReferenceSite[],
  paints: readonly PaintIR[] | undefined,
  propertyPath: string,
): void {
  if (paints === undefined) {
    return;
  }
  for (const [index, paint] of paints.entries()) {
    if (paint.paintType !== "IMAGE") {
      continue;
    }
    sites.push({
      imageHash:
        typeof paint.imageHash === "string" && paint.imageHash.length > 0
          ? paint.imageHash
          : null,
      propertyPath: `${propertyPath}[${index}].imageHash`,
    });
  }
}

function paintsOrUndefined(
  value: readonly PaintIR[] | object | undefined,
): readonly PaintIR[] | undefined {
  return Array.isArray(value) ? (value as readonly PaintIR[]) : undefined;
}

function rasterSitesForNode(node: NodeIR): readonly RasterReferenceSite[] {
  const sites: RasterReferenceSite[] = [];
  appendPaintSites(
    sites,
    paintsOrUndefined(node.visual?.fills),
    "$.visual.fills",
  );
  appendPaintSites(
    sites,
    paintsOrUndefined(node.visual?.strokes),
    "$.visual.strokes",
  );
  appendPaintSites(
    sites,
    paintsOrUndefined(node.visual?.backgrounds),
    "$.visual.backgrounds",
  );
  if (node.family === "text") {
    for (const [segmentIndex, segment] of node.text.segments.entries()) {
      appendPaintSites(
        sites,
        paintsOrUndefined(segment.fills),
        `$.text.segments[${segmentIndex}].fills`,
      );
    }
  }
  const seen = new Set<string>();
  return sites.filter((site) => {
    const key = site.imageHash ?? "\u0000missing";
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function rasterSitesForStyle(
  style: PaintStyleIR,
): readonly RasterReferenceSite[] {
  const sites: RasterReferenceSite[] = [];
  appendPaintSites(sites, style.paints, "$.paints");
  const seen = new Set<string>();
  return sites.filter((site) => {
    const key = site.imageHash ?? "\u0000missing";
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function assetIdentity(asset: AssetRefIR): string {
  return asset.assetKind === "raster"
    ? `raster\u0000${asset.imageHash}`
    : `vector\u0000${asset.node.id}`;
}

function deduplicateAssets(
  assets: readonly AssetRefIR[],
): readonly AssetRefIR[] {
  const byIdentity = new Map<string, AssetRefIR>();
  for (const asset of assets) {
    byIdentity.set(assetIdentity(asset), asset);
  }
  return [...byIdentity.values()].sort((left, right) => {
    const leftKey = `${left.assetKind}\u0000${left.source.id}\u0000${left.archivePath}`;
    const rightKey = `${right.assetKind}\u0000${right.source.id}\u0000${right.archivePath}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

async function cloneTreeWithAssets(
  tree: NodeIR,
  refsByNodeId: ReadonlyMap<string, readonly AssetRefIR[]>,
  diagnosticIdsByNodeId: ReadonlyMap<string, readonly string[]>,
  cancellation: ExportCancellationToken,
): Promise<NodeIR> {
  const work: { readonly node: NodeIR; readonly exiting: boolean }[] = [
    { node: tree, exiting: false },
  ];
  const built = new Map<NodeIR, NodeIR>();
  let visited = 0;
  while (work.length > 0) {
    cancellation.throwIfCancelled();
    const item = work.pop();
    if (item === undefined) {
      continue;
    }
    if (!item.exiting) {
      work.push({ node: item.node, exiting: true });
      if ("children" in item.node) {
        for (
          let index = item.node.children.length - 1;
          index >= 0;
          index -= 1
        ) {
          const child = item.node.children[index];
          if (child !== undefined) {
            work.push({ node: child, exiting: false });
          }
        }
      }
      continue;
    }
    const assetRefs = deduplicateAssets([
      ...item.node.assetRefs,
      ...(refsByNodeId.get(item.node.source.id) ?? []),
    ]);
    const diagnosticIds = [
      ...new Set([
        ...item.node.diagnosticIds,
        ...(diagnosticIdsByNodeId.get(item.node.source.id) ?? []),
      ]),
    ];
    if ("children" in item.node) {
      const children = item.node.children.map((child) => {
        const builtChild = built.get(child);
        if (builtChild === undefined) {
          throw new Error("Asset enrichment lost a collected child node.");
        }
        return builtChild;
      });
      built.set(item.node, {
        ...item.node,
        assetRefs,
        diagnosticIds,
        children,
      });
    } else {
      built.set(item.node, {
        ...item.node,
        assetRefs,
        diagnosticIds,
      });
    }
    visited += 1;
    if (visited % 50 === 0) {
      await yieldToFigma();
      cancellation.throwIfCancelled();
    }
  }
  const enriched = built.get(tree);
  if (enriched === undefined) {
    throw new Error("Asset enrichment did not produce a root node.");
  }
  return enriched;
}

function defaultApi(): AssetCollectorApi {
  const runtimeApi: unknown = figma;
  return runtimeApi as AssetCollectorApi;
}

export class AssetCollectionSession {
  readonly #snapshotId: SnapshotId;
  readonly #diagnostics: DiagnosticBag;
  readonly #cancellation: ExportCancellationToken;
  readonly #emitter: AssetArchiveEmitter;
  readonly #api: AssetCollectorApi;
  readonly #entryByteLimit: number | undefined;
  readonly #rasterByImageHash = new Map<string, RasterResolution>();
  readonly #contentAssets = new Map<string, ContentAsset>();
  readonly #vectorByNodeId = new Map<string, VectorResolution>();
  readonly #unavailablePaths = new Set<string>();

  constructor(options: AssetCollectionSessionOptions) {
    this.#snapshotId = options.snapshotId;
    this.#diagnostics = options.diagnostics;
    this.#cancellation = options.cancellation;
    this.#emitter = options.emitter;
    this.#api = options.api ?? defaultApi();
    this.#entryByteLimit = options.entryByteLimit;
  }

  stats(): AssetCollectionStats {
    return {
      imageHashes: this.#rasterByImageHash.size,
      rasterContents: this.#contentAssets.size,
      vectorNodes: this.#vectorByNodeId.size,
    };
  }

  #missingHashDiagnostic(source: SourceRef, propertyPath: string): string {
    return this.#diagnostics.add({
      code: DIAGNOSTIC_CODES.rasterImageHashMissing,
      severity: "error",
      message:
        "A reachable image fill has no usable image hash, so its original bytes are unavailable.",
      phase: "asset",
      source,
      propertyPath,
      causedDataLoss: true,
    }).id;
  }

  #markUnavailable(path: string, diagnosticId: string): void {
    if (this.#unavailablePaths.has(path)) {
      return;
    }
    this.#unavailablePaths.add(path);
    this.#emitter.unavailable(path, diagnosticId);
  }

  #unavailableRasterDiagnostic(
    resolution: Extract<RasterResolution, { readonly status: "unavailable" }>,
    source: SourceRef,
    propertyPath: string,
  ): string {
    return this.#diagnostics.add({
      code: resolution.code,
      severity: "error",
      message: resolution.message,
      phase: "asset",
      source,
      propertyPath,
      ...(resolution.artifactPath === undefined
        ? {}
        : { artifactPath: resolution.artifactPath }),
      causedDataLoss: true,
      ...(resolution.technicalCause === undefined
        ? {}
        : { technicalCause: resolution.technicalCause }),
    }).id;
  }

  async #resolveRaster(
    imageHash: string,
    source: SourceRef,
    propertyPath: string,
  ): Promise<
    { readonly reference: RasterAssetRefIR } | { readonly diagnosticId: string }
  > {
    const cached = this.#rasterByImageHash.get(imageHash);
    if (cached !== undefined) {
      return cached.status === "available"
        ? { reference: cached.reference }
        : {
            diagnosticId: this.#unavailableRasterDiagnostic(
              cached,
              source,
              propertyPath,
            ),
          };
    }

    this.#cancellation.throwIfCancelled();
    let image: ReadableImage | null;
    try {
      image = this.#api.getImageByHash(imageHash);
    } catch (error) {
      const resolution: RasterResolution = {
        status: "unavailable",
        code: DIAGNOSTIC_CODES.rasterReadFailed,
        message:
          "A reachable raster image handle could not be read through the Plugin API.",
        technicalCause: normalizeSafeTechnicalCause(error, "property-access"),
      };
      this.#rasterByImageHash.set(imageHash, resolution);
      return {
        diagnosticId: this.#unavailableRasterDiagnostic(
          resolution,
          source,
          propertyPath,
        ),
      };
    }
    this.#cancellation.throwIfCancelled();
    if (image === null) {
      const resolution: RasterResolution = {
        status: "unavailable",
        code: DIAGNOSTIC_CODES.rasterImageUnavailable,
        message:
          "A reachable raster image hash is not accessible through the Plugin API.",
      };
      this.#rasterByImageHash.set(imageHash, resolution);
      return {
        diagnosticId: this.#unavailableRasterDiagnostic(
          resolution,
          source,
          propertyPath,
        ),
      };
    }

    let bytes: Uint8Array;
    try {
      this.#cancellation.throwIfCancelled();
      bytes = await image.getBytesAsync();
      this.#cancellation.throwIfCancelled();
      if (!(bytes instanceof Uint8Array)) {
        throw new TypeError("Image bytes are not a Uint8Array.");
      }
    } catch (error) {
      if (error instanceof ExportCancelledError) {
        throw error;
      }
      this.#cancellation.throwIfCancelled();
      const resolution: RasterResolution = {
        status: "unavailable",
        code: DIAGNOSTIC_CODES.rasterReadFailed,
        message:
          "Original raster bytes could not be read through the Plugin API.",
        technicalCause: normalizeSafeTechnicalCause(error, "unknown"),
      };
      this.#rasterByImageHash.set(imageHash, resolution);
      return {
        diagnosticId: this.#unavailableRasterDiagnostic(
          resolution,
          source,
          propertyPath,
        ),
      };
    }

    try {
      await assertArchiveEntryFits(bytes, {
        byteLimit: this.#entryByteLimit,
        checkpoint: () => this.#cancellation.throwIfCancelled(),
      });
    } catch (error) {
      if (
        error instanceof ArchiveProducerSafetyError &&
        error.code === "archive-capacity-exceeded"
      ) {
        const resolution: RasterResolution = {
          status: "unavailable",
          code: DIAGNOSTIC_CODES.archiveEntryTooLarge,
          message:
            "Original raster bytes exceeded the safe single-entry archive limit and are absent.",
        };
        this.#rasterByImageHash.set(imageHash, resolution);
        const diagnosticId = this.#unavailableRasterDiagnostic(
          resolution,
          source,
          propertyPath,
        );
        return { diagnosticId };
      }
      throw error;
    }
    this.#cancellation.throwIfCancelled();
    const contentSha256 = sha256Hex(bytes);
    this.#cancellation.throwIfCancelled();
    const detected = detectRasterFormat(bytes);
    const archivePath = archivePaths.rasterAsset(
      this.#snapshotId,
      contentSha256,
      detected.extension,
    );
    if (!detected.known) {
      this.#diagnostics.add({
        code: DIAGNOSTIC_CODES.rasterUnknownFormat,
        severity: "warning",
        message:
          "Raster magic bytes are not PNG, JPEG, GIF, or WebP; original bytes were preserved as .bin.",
        phase: "asset",
        source: { kind: "asset", id: imageHash },
        artifactPath: archivePath,
        causedDataLoss: false,
      });
    }

    const existingContent = this.#contentAssets.get(contentSha256);
    if (existingContent === undefined) {
      await this.#emitter.emit(archivePath, detected.mediaType, "store", bytes);
      this.#cancellation.throwIfCancelled();
      this.#contentAssets.set(contentSha256, {
        imageHash,
        archivePath,
        mediaType: detected.mediaType,
      });
    } else if (existingContent.imageHash !== imageHash) {
      this.#diagnostics.add({
        code: DIAGNOSTIC_CODES.rasterContentDeduplicated,
        severity: "info",
        message:
          "Distinct Figma image hashes resolved to identical original bytes and share one raster archive entry.",
        phase: "asset",
        source: { kind: "asset", id: imageHash },
        artifactPath: existingContent.archivePath,
        causedDataLoss: false,
      });
    }
    const contentAsset = this.#contentAssets.get(contentSha256)!;
    const reference: RasterAssetRefIR = {
      assetKind: "raster",
      source: { kind: "asset", id: imageHash },
      imageHash,
      contentSha256,
      mediaType: contentAsset.mediaType,
      byteLength: bytes.byteLength,
      archivePath: contentAsset.archivePath,
    };
    this.#rasterByImageHash.set(imageHash, {
      status: "available",
      reference,
    });
    await yieldToFigma();
    this.#cancellation.throwIfCancelled();
    return { reference };
  }

  #vectorFailure(
    node: NodeIR,
    path: string,
    error?: unknown,
  ): VectorResolution {
    const diagnostic = this.#diagnostics.add({
      code: DIAGNOSTIC_CODES.vectorExportFailed,
      severity: "error",
      message:
        "An eligible standalone SVG asset could not be exported and is absent.",
      phase: "asset",
      source: node.source,
      artifactPath: path,
      causedDataLoss: true,
      ...(error === undefined
        ? {}
        : { technicalCause: normalizeSafeTechnicalCause(error, "unknown") }),
    });
    this.#markUnavailable(path, diagnostic.id);
    const resolution: VectorResolution = {
      status: "unavailable",
      diagnosticId: diagnostic.id,
    };
    this.#vectorByNodeId.set(node.source.id, resolution);
    return resolution;
  }

  async #resolveVector(
    node: NodeIR,
    sceneNode: AssetExportNode | undefined,
    candidate: VectorAssetCandidate,
  ): Promise<VectorResolution> {
    const cached = this.#vectorByNodeId.get(node.source.id);
    if (cached !== undefined) {
      return cached;
    }
    const path = archivePaths.vectorAsset(this.#snapshotId, node.source.id);
    if (sceneNode === undefined) {
      return this.#vectorFailure(node, path);
    }
    let rawSvg: string;
    try {
      this.#cancellation.throwIfCancelled();
      rawSvg = await sceneNode.exportAsync(candidate.exportSettings);
      this.#cancellation.throwIfCancelled();
      if (typeof rawSvg !== "string" || rawSvg.length === 0) {
        throw new TypeError("SVG export did not return text.");
      }
    } catch (error) {
      if (error instanceof ExportCancelledError) {
        throw error;
      }
      this.#cancellation.throwIfCancelled();
      return this.#vectorFailure(node, path, error);
    }
    const svg = ensureOneFinalNewline(rawSvg);
    try {
      await assertArchiveEntryFits(svg, {
        byteLimit: this.#entryByteLimit,
        checkpoint: () => this.#cancellation.throwIfCancelled(),
      });
    } catch (error) {
      if (
        error instanceof ArchiveProducerSafetyError &&
        error.code === "archive-capacity-exceeded"
      ) {
        const diagnostic = this.#diagnostics.add({
          code: DIAGNOSTIC_CODES.archiveEntryTooLarge,
          severity: "error",
          message:
            "An SVG asset exceeded the safe single-entry archive limit and is absent.",
          phase: "asset",
          source: node.source,
          artifactPath: path,
          causedDataLoss: true,
        });
        this.#markUnavailable(path, diagnostic.id);
        const resolution: VectorResolution = {
          status: "unavailable",
          diagnosticId: diagnostic.id,
        };
        this.#vectorByNodeId.set(node.source.id, resolution);
        return resolution;
      }
      throw error;
    }
    const bytes = strToU8(svg);
    this.#cancellation.throwIfCancelled();
    const reference: VectorAssetRefIR = {
      assetKind: "vector",
      source: {
        kind: "asset",
        id: node.source.id,
        ...(node.source.name === undefined ? {} : { name: node.source.name }),
      },
      node: node.source,
      archivePath: path,
      mediaType: "image/svg+xml",
      byteLength: bytes.byteLength,
      contentSha256: sha256Hex(bytes),
      eligibility: candidate.eligibility,
      exportSettings: candidate.exportSettings,
    };
    this.#cancellation.throwIfCancelled();
    await this.#emitter.emit(path, "image/svg+xml", "deflate", svg);
    this.#cancellation.throwIfCancelled();
    const resolution: VectorResolution = {
      status: "available",
      reference,
    };
    this.#vectorByNodeId.set(node.source.id, resolution);
    await yieldToFigma();
    this.#cancellation.throwIfCancelled();
    return resolution;
  }

  async collectTree(
    tree: NodeIR,
    nodesById: ReadonlyMap<string, AssetExportNode>,
  ): Promise<CollectedTreeAssets> {
    const diagnosticStart = this.#diagnostics.size();
    const refsByNodeId = new Map<string, AssetRefIR[]>();
    const diagnosticIdsByNodeId = new Map<string, string[]>();
    const candidateByNodeId = new Map(
      selectVectorAssetCandidates(tree).map((candidate) => [
        candidate.nodeId,
        candidate,
      ]),
    );
    const work: NodeIR[] = [tree];
    let visited = 0;
    let complete = true;
    while (work.length > 0) {
      this.#cancellation.throwIfCancelled();
      const node = work.pop();
      if (node === undefined) {
        continue;
      }
      const refs = refsByNodeId.get(node.source.id) ?? [];
      const nodeDiagnosticIds = diagnosticIdsByNodeId.get(node.source.id) ?? [];
      for (const site of rasterSitesForNode(node)) {
        if (site.imageHash === null) {
          complete = false;
          nodeDiagnosticIds.push(
            this.#missingHashDiagnostic(node.source, site.propertyPath),
          );
          continue;
        }
        const result = await this.#resolveRaster(
          site.imageHash,
          node.source,
          site.propertyPath,
        );
        if ("reference" in result) {
          refs.push(result.reference);
        } else {
          complete = false;
          nodeDiagnosticIds.push(result.diagnosticId);
        }
      }
      const candidate = candidateByNodeId.get(node.source.id);
      if (candidate !== undefined) {
        const result = await this.#resolveVector(
          node,
          nodesById.get(node.source.id),
          candidate,
        );
        if (result.status === "available") {
          refs.push(result.reference);
        } else {
          complete = false;
          nodeDiagnosticIds.push(result.diagnosticId);
        }
      }
      refsByNodeId.set(node.source.id, refs);
      diagnosticIdsByNodeId.set(node.source.id, nodeDiagnosticIds);
      if ("children" in node) {
        for (let index = node.children.length - 1; index >= 0; index -= 1) {
          const child = node.children[index];
          if (child !== undefined) {
            work.push(child);
          }
        }
      }
      visited += 1;
      if (visited % 25 === 0) {
        await yieldToFigma();
        this.#cancellation.throwIfCancelled();
      }
    }
    const enrichedTree = await cloneTreeWithAssets(
      tree,
      refsByNodeId,
      diagnosticIdsByNodeId,
      this.#cancellation,
    );
    const assets: AssetRefIR[] = [];
    const assetWork: NodeIR[] = [enrichedTree];
    let assetScanCount = 0;
    while (assetWork.length > 0) {
      this.#cancellation.throwIfCancelled();
      const node = assetWork.pop();
      if (node === undefined) {
        continue;
      }
      assets.push(...node.assetRefs);
      if ("children" in node) {
        for (const child of node.children) {
          assetWork.push(child);
        }
      }
      assetScanCount += 1;
      if (assetScanCount % 50 === 0) {
        await yieldToFigma();
        this.#cancellation.throwIfCancelled();
      }
    }
    const diagnostics = this.#diagnostics.listSince(diagnosticStart);
    const diagnosticIds = [
      ...new Set([
        ...diagnostics.map((diagnostic) => diagnostic.id),
        ...[...diagnosticIdsByNodeId.values()].flat(),
      ]),
    ];
    return {
      tree: enrichedTree,
      assets: deduplicateAssets(assets),
      complete:
        complete &&
        diagnostics.every((diagnostic) => !diagnostic.causedDataLoss),
      diagnosticIds,
    };
  }

  async collectStyles(artifact: StylesIndexIR): Promise<CollectedStyleAssets> {
    const diagnosticStart = this.#diagnostics.size();
    const styles = [];
    for (const style of artifact.styles) {
      this.#cancellation.throwIfCancelled();
      if (style.styleType !== "paint") {
        styles.push(style);
        continue;
      }
      const styleDiagnosticStart = this.#diagnostics.size();
      const assetRefs: RasterAssetRefIR[] = [];
      for (const site of rasterSitesForStyle(style)) {
        const diagnosticSources = [style.source, ...style.referencedBy];
        if (site.imageHash === null) {
          for (const source of diagnosticSources) {
            this.#missingHashDiagnostic(source, site.propertyPath);
          }
          continue;
        }
        const firstSource = diagnosticSources[0] ?? style.source;
        const result = await this.#resolveRaster(
          site.imageHash,
          firstSource,
          site.propertyPath,
        );
        if ("reference" in result) {
          assetRefs.push(result.reference);
          continue;
        }
        for (const source of diagnosticSources.slice(1)) {
          await this.#resolveRaster(site.imageHash, source, site.propertyPath);
        }
      }
      styles.push({
        ...style,
        assetRefs: deduplicateAssets(assetRefs).filter(
          (asset): asset is RasterAssetRefIR => asset.assetKind === "raster",
        ),
        diagnosticIds: [
          ...new Set([
            ...style.diagnosticIds,
            ...this.#diagnostics
              .listSince(styleDiagnosticStart)
              .map((diagnostic) => diagnostic.id),
          ]),
        ],
      });
      await yieldToFigma();
      this.#cancellation.throwIfCancelled();
    }
    const diagnostics = this.#diagnostics.listSince(diagnosticStart);
    return {
      artifact: {
        ...artifact,
        styles,
        diagnosticIds: [
          ...new Set([
            ...artifact.diagnosticIds,
            ...diagnostics.map((diagnostic) => diagnostic.id),
          ]),
        ],
      },
      complete: diagnostics.every((diagnostic) => !diagnostic.causedDataLoss),
      diagnosticIds: diagnostics.map((diagnostic) => diagnostic.id),
    };
  }
}
