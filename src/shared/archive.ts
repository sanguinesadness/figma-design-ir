import type { ArchiveCompleteness, DiagnosticCounts } from "./diagnostics";
import { ARCHIVE_FORMAT_VERSION, DESIGN_IR_SCHEMA_VERSION } from "./ir";

declare const snapshotIdBrand: unique symbol;

export type SnapshotId = string & {
  readonly [snapshotIdBrand]: true;
};

export const SNAPSHOT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,95}$/;

export type ArchiveCompression = "deflate" | "store";

export const ARCHIVE_TOTAL_LIVE_BYTE_LIMIT = 384 * 1024 * 1024;
export const ARCHIVE_SINGLE_ENTRY_BYTE_LIMIT = 64 * 1024 * 1024;
// fflate's streaming Zip writer is non-ZIP64. Reserve the final slot for the
// manifest so the total entry count never exceeds the classic ZIP maximum.
export const ARCHIVE_MAX_PRE_MANIFEST_ENTRY_COUNT = 65_534;

export type ArchiveProducerSafetyErrorCode =
  "archive-capacity-exceeded" | "archive-entry-limit-exceeded";

export class ArchiveProducerSafetyError extends Error {
  readonly code: ArchiveProducerSafetyErrorCode;

  constructor(code: ArchiveProducerSafetyErrorCode) {
    super(
      code === "archive-capacity-exceeded"
        ? "An archive entry exceeded the safe local capacity."
        : "The archive exceeded the safe classic-ZIP entry limit.",
    );
    this.name = "ArchiveProducerSafetyError";
    this.code = code;
  }
}

/** Counts the exact TextEncoder-compatible UTF-8 length without allocating. */
export function utf8ByteLength(value: string): number {
  let byteLength = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x7f) {
      byteLength += 1;
    } else if (codeUnit <= 0x7ff) {
      byteLength += 2;
    } else if (
      codeUnit >= 0xd800 &&
      codeUnit <= 0xdbff &&
      index + 1 < value.length
    ) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
        byteLength += 4;
        index += 1;
      } else {
        byteLength += 3;
      }
    } else {
      byteLength += 3;
    }
  }
  return byteLength;
}

export interface ArchiveEntryMetadata {
  readonly path: string;
  readonly mediaType: string;
  readonly compression: ArchiveCompression;
  readonly uncompressedByteLength: number;
  readonly contentSha256?: string;
}

export interface ArchiveEntryDescriptor {
  readonly metadata: ArchiveEntryMetadata;
  readonly data: string | Uint8Array;
}

export type ExportScopeManifest =
  | {
      readonly kind: "entire-file";
      readonly orderedRootIds: readonly string[];
    }
  | {
      readonly kind: "current-selection";
      readonly orderedRootIds: readonly string[];
    };

export interface ArchiveManifest {
  readonly archiveVersion: typeof ARCHIVE_FORMAT_VERSION;
  readonly schemaVersion: typeof DESIGN_IR_SCHEMA_VERSION;
  readonly exporter: {
    readonly packageName: "figma-design-ir";
    readonly packageVersion: string;
  };
  readonly snapshotId: string;
  readonly exportedAtUtc: string;
  readonly editorType: "figma";
  readonly document: {
    readonly name: string;
  };
  readonly scope: ExportScopeManifest;
  readonly ownerConfirmedCurrent: true;
  readonly counts: {
    readonly pages: number;
    readonly roots: number;
    readonly artifacts: number;
  };
  readonly diagnosticCounts: DiagnosticCounts;
  readonly completeness: ArchiveCompleteness;
  readonly entries: readonly ArchiveEntryMetadata[];
  readonly capabilities: readonly string[];
  readonly pluginApiLimitations: readonly string[];
}

/** The manifest describes every preceding entry and intentionally excludes itself. */
export type ArchiveManifestDraft = Omit<ArchiveManifest, "entries">;

export type ArchiveArtifactRequirement =
  | {
      readonly path: string;
      readonly status: "emitted";
    }
  | {
      readonly path: string;
      readonly status: "unavailable";
      readonly diagnosticId: string;
    };

export class ArchivePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchivePathError";
  }
}

export class DuplicateArchivePathError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`Duplicate archive path rejected: ${path}`);
    this.name = "DuplicateArchivePathError";
    this.path = path;
  }
}

export function parseSnapshotId(value: string): SnapshotId | null {
  return SNAPSHOT_ID_PATTERN.test(value) ? (value as SnapshotId) : null;
}

export function requireSnapshotId(value: string): SnapshotId {
  const snapshotId = parseSnapshotId(value);
  if (snapshotId === null) {
    throw new ArchivePathError(
      "Snapshot IDs must match ^[a-z0-9][a-z0-9._-]{0,95}$.",
    );
  }
  return snapshotId;
}

export function encodeSourceId(sourceId: string): string {
  if (sourceId.length === 0) {
    throw new ArchivePathError(
      "Source IDs used in archive paths cannot be empty.",
    );
  }
  try {
    return encodeURIComponent(sourceId);
  } catch {
    throw new ArchivePathError(
      "A source ID could not be encoded safely for an archive path.",
    );
  }
}

export function assertSafeArchivePath(path: string): void {
  const containsControlCharacter = (value: string): boolean => {
    for (let index = 0; index < value.length; index += 1) {
      const codeUnit = value.charCodeAt(index);
      if (codeUnit <= 0x1f || codeUnit === 0x7f) {
        return true;
      }
    }
    return false;
  };

  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.includes("\\") ||
    containsControlCharacter(path)
  ) {
    throw new ArchivePathError("Archive path is not a safe relative ZIP path.");
  }

  const segments = path.split("/");
  for (const segment of segments) {
    let decodedSegment: string;
    try {
      decodedSegment = decodeURIComponent(segment);
    } catch {
      throw new ArchivePathError(
        "Archive path contains a malformed encoded segment.",
      );
    }
    if (
      segment.length === 0 ||
      segment === "." ||
      segment === ".." ||
      decodedSegment === "." ||
      decodedSegment === ".."
    ) {
      throw new ArchivePathError("Archive path contains an unsafe segment.");
    }
  }

  if (!SNAPSHOT_ID_PATTERN.test(segments[0] ?? "")) {
    throw new ArchivePathError(
      "Archive path must be rooted at a validated snapshot ID.",
    );
  }
}

function archivePath(
  snapshotId: SnapshotId,
  ...controlledSegments: readonly string[]
): string {
  const path = [snapshotId, ...controlledSegments].join("/");
  assertSafeArchivePath(path);
  return path;
}

function sourceJsonPath(
  snapshotId: SnapshotId,
  directory: readonly string[],
  sourceId: string,
): string {
  return archivePath(
    snapshotId,
    ...directory,
    `${encodeSourceId(sourceId)}.json`,
  );
}

function sourceMarkdownPath(
  snapshotId: SnapshotId,
  directory: readonly string[],
  sourceId: string,
): string {
  return archivePath(
    snapshotId,
    ...directory,
    `${encodeSourceId(sourceId)}.md`,
  );
}

export const archivePaths = {
  manifest: (snapshotId: SnapshotId): string =>
    archivePath(snapshotId, "manifest.json"),
  diagnostics: (snapshotId: SnapshotId): string =>
    archivePath(snapshotId, "diagnostics.json"),
  rawRestPage: (snapshotId: SnapshotId, pageId: string): string =>
    sourceJsonPath(snapshotId, ["raw", "rest-v1", "pages"], pageId),
  rawRestRoot: (snapshotId: SnapshotId, nodeId: string): string =>
    sourceJsonPath(snapshotId, ["raw", "rest-v1", "roots"], nodeId),
  irDocument: (snapshotId: SnapshotId): string =>
    archivePath(snapshotId, "ir", "document.json"),
  irVariables: (snapshotId: SnapshotId): string =>
    archivePath(snapshotId, "ir", "variables.json"),
  irStyles: (snapshotId: SnapshotId): string =>
    archivePath(snapshotId, "ir", "styles.json"),
  irComponents: (snapshotId: SnapshotId): string =>
    archivePath(snapshotId, "ir", "components.json"),
  irComponentDefinition: (
    snapshotId: SnapshotId,
    componentId: string,
  ): string =>
    sourceJsonPath(
      snapshotId,
      ["ir", "components", "definitions"],
      componentId,
    ),
  rawRestComponent: (snapshotId: SnapshotId, componentId: string): string =>
    sourceJsonPath(snapshotId, ["raw", "rest-v1", "components"], componentId),
  irNodePage: (snapshotId: SnapshotId, pageId: string): string =>
    sourceJsonPath(snapshotId, ["ir", "nodes", "pages"], pageId),
  irNodeRoot: (snapshotId: SnapshotId, nodeId: string): string =>
    sourceJsonPath(snapshotId, ["ir", "nodes", "roots"], nodeId),
  agentIndex: (snapshotId: SnapshotId): string =>
    archivePath(snapshotId, "agent", "index.md"),
  agentTokens: (snapshotId: SnapshotId): string =>
    archivePath(snapshotId, "agent", "tokens.md"),
  agentStyles: (snapshotId: SnapshotId): string =>
    archivePath(snapshotId, "agent", "styles.md"),
  agentComponentIndex: (snapshotId: SnapshotId): string =>
    archivePath(snapshotId, "agent", "component-index.md"),
  agentComponent: (snapshotId: SnapshotId, componentId: string): string =>
    sourceMarkdownPath(snapshotId, ["agent", "components"], componentId),
  agentPageIndex: (snapshotId: SnapshotId): string =>
    archivePath(snapshotId, "agent", "page-index.md"),
  agentPage: (snapshotId: SnapshotId, pageId: string): string =>
    sourceMarkdownPath(snapshotId, ["agent", "pages"], pageId),
  rasterAsset: (
    snapshotId: SnapshotId,
    contentSha256: string,
    extension: "png" | "jpg" | "gif" | "webp" | "bin",
  ): string => {
    if (!/^[a-f0-9]{64}$/.test(contentSha256)) {
      throw new ArchivePathError(
        "Raster asset paths require a lowercase hexadecimal SHA-256.",
      );
    }
    return archivePath(
      snapshotId,
      "assets",
      "raster",
      `${contentSha256}.${extension}`,
    );
  },
  vectorAsset: (snapshotId: SnapshotId, nodeId: string): string =>
    archivePath(
      snapshotId,
      "assets",
      "vector",
      `${encodeSourceId(nodeId)}.svg`,
    ),
  preview: (snapshotId: SnapshotId, nodeId: string): string =>
    archivePath(snapshotId, "previews", `${encodeSourceId(nodeId)}.png`),
} as const;

function validateEntryMetadata(metadata: ArchiveEntryMetadata): void {
  assertSafeArchivePath(metadata.path);
  if (
    metadata.mediaType.length === 0 ||
    metadata.mediaType.includes("\r") ||
    metadata.mediaType.includes("\n") ||
    metadata.mediaType.includes("\u0000")
  ) {
    throw new ArchivePathError("Archive entry media type is invalid.");
  }
  if (
    !Number.isSafeInteger(metadata.uncompressedByteLength) ||
    metadata.uncompressedByteLength < 0
  ) {
    throw new ArchivePathError(
      "Archive entry byte length must be a non-negative safe integer.",
    );
  }
  if (
    metadata.contentSha256 !== undefined &&
    !/^[a-f0-9]{64}$/.test(metadata.contentSha256)
  ) {
    throw new ArchivePathError(
      "Archive entry content hash must be a lowercase hexadecimal SHA-256.",
    );
  }
}

function compareArchivePaths(
  left: ArchiveEntryMetadata,
  right: ArchiveEntryMetadata,
): number {
  if (left.path < right.path) {
    return -1;
  }
  if (left.path > right.path) {
    return 1;
  }
  return 0;
}

function snapshotEntryMetadata(
  metadata: ArchiveEntryMetadata,
): ArchiveEntryMetadata {
  return Object.freeze({
    path: metadata.path,
    mediaType: metadata.mediaType,
    compression: metadata.compression,
    uncompressedByteLength: metadata.uncompressedByteLength,
    ...(metadata.contentSha256 === undefined
      ? {}
      : { contentSha256: metadata.contentSha256 }),
  });
}

export class ArchiveEntryRegistry {
  readonly #entries = new Map<string, ArchiveEntryMetadata>();

  register(metadata: ArchiveEntryMetadata): void {
    validateEntryMetadata(metadata);
    if (this.#entries.has(metadata.path)) {
      throw new DuplicateArchivePathError(metadata.path);
    }
    this.#entries.set(metadata.path, snapshotEntryMetadata(metadata));
  }

  get(path: string): ArchiveEntryMetadata | undefined {
    return this.#entries.get(path);
  }

  list(): readonly ArchiveEntryMetadata[] {
    return [...this.#entries.values()].sort(compareArchivePaths);
  }

  clear(): void {
    this.#entries.clear();
  }
}
