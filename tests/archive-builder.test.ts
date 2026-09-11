import { createHash } from "node:crypto";

import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";

import {
  ARCHIVE_MAX_PRE_MANIFEST_ENTRY_COUNT,
  ARCHIVE_SINGLE_ENTRY_BYTE_LIMIT,
  ARCHIVE_TOTAL_LIVE_BYTE_LIMIT,
  ArchiveAssemblyError,
  StreamingArchiveBuilder,
  type ArchiveBuilderRuntime,
  type CompletedArchive,
} from "../src/shared/archive-builder";
import {
  archivePaths,
  requireSnapshotId,
  utf8ByteLength,
  type ArchiveArtifactRequirement,
  type ArchiveEntryDescriptor,
  type ArchiveManifest,
  type ArchiveManifestDraft,
  type SnapshotId,
} from "../src/shared/archive";
import type {
  ArchiveCompleteness,
  DiagnosticSummary,
} from "../src/shared/diagnostics";
import {
  ARCHIVE_FORMAT_VERSION,
  DESIGN_IR_SCHEMA_VERSION,
} from "../src/shared/ir";
import { serializeCanonicalJson } from "../src/shared/serialization";
import { sha256Hex } from "../src/shared/sha256";

const SYNTHETIC_UNICODE = "Пример 中文 e\u0301 🚀 “quoted” —";
// Locally generated one-pixel fixture bytes, invented only for this repository;
// they are not derived from Figma or any private design artifact.
const SYNTHETIC_PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ),
);
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });

interface SyntheticDiagnostic {
  readonly id: string;
  readonly code: string;
  readonly severity: "info" | "warning" | "error" | "fatal";
  readonly message: string;
  readonly phase: string;
  readonly causedDataLoss: boolean;
  readonly artifactPath?: string;
  readonly source?: {
    readonly kind: "page" | "node" | "component";
    readonly id: string;
  };
}

interface SyntheticArchiveFixture {
  readonly snapshotId: SnapshotId;
  readonly rootIds: readonly string[];
  readonly entries: readonly ArchiveEntryDescriptor[];
  readonly requirements: readonly ArchiveArtifactRequirement[];
  readonly draft: ArchiveManifestDraft;
}

interface CentralDirectoryEntry {
  readonly path: string;
  readonly compressionMethod: number;
  readonly dosTime: number;
  readonly dosDate: number;
}

function summarizeSyntheticDiagnostics(
  diagnostics: readonly SyntheticDiagnostic[],
): DiagnosticSummary {
  const counts: Record<SyntheticDiagnostic["severity"], number> = {
    info: 0,
    warning: 0,
    error: 0,
    fatal: 0,
  };
  for (const diagnostic of diagnostics) {
    counts[diagnostic.severity] += 1;
  }
  const completeness: ArchiveCompleteness =
    counts.error > 0 || counts.fatal > 0
      ? "incomplete"
      : counts.warning > 0
        ? "complete-with-warnings"
        : "complete";
  return { counts, completeness };
}

function descriptor(
  path: string,
  mediaType: string,
  compression: "deflate" | "store",
  data: string | Uint8Array,
): ArchiveEntryDescriptor {
  return {
    metadata: {
      path,
      mediaType,
      compression,
      uncompressedByteLength:
        typeof data === "string"
          ? TEXT_ENCODER.encode(data).byteLength
          : data.byteLength,
    },
    data,
  };
}

function createFixture(options?: {
  readonly snapshotId?: string;
  readonly rootIds?: readonly string[];
  readonly diagnostics?: readonly SyntheticDiagnostic[];
  readonly unavailablePreviews?: ReadonlyMap<string, string>;
  readonly summaryOverride?: DiagnosticSummary;
  readonly variablesArtifactPathOverride?: string;
  readonly componentDefinitionArtifactPathOverride?: string;
  readonly omitComponentDefinitionIndexEntry?: boolean;
  readonly metadataOnlyComponentDefinition?: boolean;
  readonly previewReferenceHashOverride?: string;
}): SyntheticArchiveFixture {
  const snapshotId = requireSnapshotId(
    options?.snapshotId ?? "archive-fixture",
  );
  const rootIds = options?.rootIds ?? ["node:alpha", "node:beta"];
  const diagnostics = options?.diagnostics ?? [];
  const summary =
    options?.summaryOverride ?? summarizeSyntheticDiagnostics(diagnostics);
  const unavailablePreviews =
    options?.unavailablePreviews ?? new Map<string, string>();
  const entries: ArchiveEntryDescriptor[] = [];
  const requirements: ArchiveArtifactRequirement[] = [];

  const addEmitted = (entry: ArchiveEntryDescriptor): void => {
    entries.push(entry);
    requirements.push({ path: entry.metadata.path, status: "emitted" });
  };

  for (const rootId of rootIds) {
    addEmitted(
      descriptor(
        archivePaths.rawRestRoot(snapshotId, rootId),
        "application/json",
        "deflate",
        serializeCanonicalJson({
          kind: "synthetic-raw-root",
          rootId,
          unicode: SYNTHETIC_UNICODE,
        }),
      ),
    );

    const unavailableDiagnosticId = unavailablePreviews.get(rootId);
    if (unavailableDiagnosticId === undefined) {
      addEmitted(
        descriptor(
          archivePaths.preview(snapshotId, rootId),
          "image/png",
          "store",
          SYNTHETIC_PNG,
        ),
      );
    } else {
      requirements.push({
        path: archivePaths.preview(snapshotId, rootId),
        status: "unavailable",
        diagnosticId: unavailableDiagnosticId,
      });
    }

    addEmitted(
      descriptor(
        archivePaths.irNodeRoot(snapshotId, rootId),
        "application/json",
        "deflate",
        serializeCanonicalJson({
          kind: "design-ir-root-index",
          rootId,
          unicode: SYNTHETIC_UNICODE,
          previews:
            unavailableDiagnosticId === undefined
              ? [
                  {
                    sourceNode: { kind: "node", id: rootId },
                    archivePath: archivePaths.preview(snapshotId, rootId),
                    mediaType: "image/png",
                    sourceBounds: { x: 0, y: 0, width: 1, height: 1 },
                    exportedBounds: { x: 0, y: 0, width: 1, height: 1 },
                    scale: 1,
                    byteLength: SYNTHETIC_PNG.byteLength,
                    contentSha256:
                      options?.previewReferenceHashOverride ??
                      sha256Hex(SYNTHETIC_PNG),
                    diagnosticIds: [],
                  },
                ]
              : [],
        }),
      ),
    );
  }

  const variablesPath = archivePaths.irVariables(snapshotId);
  const stylesPath = archivePaths.irStyles(snapshotId);
  const componentsPath = archivePaths.irComponents(snapshotId);
  const componentId = "component:synthetic/α";
  const componentDefinitionPath = archivePaths.irComponentDefinition(
    snapshotId,
    componentId,
  );
  addEmitted(
    descriptor(
      componentDefinitionPath,
      "application/json",
      "deflate",
      serializeCanonicalJson({
        kind: "design-ir-component-definition",
        schemaVersion: DESIGN_IR_SCHEMA_VERSION,
        source: { kind: "component", id: componentId },
      }),
    ),
  );
  addEmitted(
    descriptor(
      variablesPath,
      "application/json",
      "deflate",
      serializeCanonicalJson({
        kind: "design-ir-variables",
        schemaVersion: DESIGN_IR_SCHEMA_VERSION,
        collections: [],
        variables: [],
      }),
    ),
  );
  addEmitted(
    descriptor(
      stylesPath,
      "application/json",
      "deflate",
      serializeCanonicalJson({
        kind: "design-ir-styles",
        schemaVersion: DESIGN_IR_SCHEMA_VERSION,
        styles: [],
      }),
    ),
  );
  addEmitted(
    descriptor(
      componentsPath,
      "application/json",
      "deflate",
      serializeCanonicalJson({
        kind: "design-ir-components",
        schemaVersion: DESIGN_IR_SCHEMA_VERSION,
        definitions: options?.omitComponentDefinitionIndexEntry
          ? []
          : [
              {
                source: { kind: "component", id: componentId },
                definitionArtifact: {
                  path:
                    options?.componentDefinitionArtifactPathOverride ??
                    componentDefinitionPath,
                  mediaType: "application/json",
                },
              },
              ...(options?.metadataOnlyComponentDefinition
                ? [
                    {
                      componentKind: "component-set",
                      source: {
                        kind: "component",
                        id: "component:metadata-set",
                      },
                      nodeId: "component:metadata-set",
                      variantAxes: [
                        { name: "State", values: ["Idle", "Hover"] },
                      ],
                      propertyDefinitions: [
                        {
                          id: "State",
                          name: "State",
                          propertyType: "VARIANT",
                          defaultValue: "Idle",
                          variantOptions: ["Idle", "Hover"],
                          preferredValues: [],
                          variableBindings: [],
                        },
                      ],
                      diagnosticIds: [],
                    },
                  ]
                : []),
            ],
        dependencies: [],
      }),
    ),
  );

  addEmitted(
    descriptor(
      archivePaths.irDocument(snapshotId),
      "application/json",
      "deflate",
      serializeCanonicalJson({
        kind: "design-ir-document",
        schemaVersion: DESIGN_IR_SCHEMA_VERSION,
        selectedRootIds: rootIds,
        artifacts: {
          variables: {
            path: options?.variablesArtifactPathOverride ?? variablesPath,
            mediaType: "application/json",
          },
          styles: { path: stylesPath, mediaType: "application/json" },
          components: {
            path: componentsPath,
            mediaType: "application/json",
          },
          nodeArtifacts: rootIds.map((rootId) => ({
            path: archivePaths.irNodeRoot(snapshotId, rootId),
            mediaType: "application/json",
          })),
        },
        unicode: SYNTHETIC_UNICODE,
      }),
    ),
  );
  addEmitted(
    descriptor(
      archivePaths.diagnostics(snapshotId),
      "application/json",
      "deflate",
      serializeCanonicalJson({
        kind: "design-ir-diagnostics",
        schemaVersion: DESIGN_IR_SCHEMA_VERSION,
        summary,
        diagnostics,
      }),
    ),
  );
  addEmitted(
    descriptor(
      archivePaths.agentIndex(snapshotId),
      "text/markdown",
      "deflate",
      `# Synthetic archive\n\n${SYNTHETIC_UNICODE}\n`,
    ),
  );

  return {
    snapshotId,
    rootIds,
    entries,
    requirements,
    draft: {
      archiveVersion: ARCHIVE_FORMAT_VERSION,
      schemaVersion: DESIGN_IR_SCHEMA_VERSION,
      exporter: {
        packageName: "figma-design-ir",
        packageVersion: "0.1.0",
      },
      snapshotId,
      exportedAtUtc: "2026-08-13T12:00:00.000Z",
      editorType: "figma",
      document: { name: "Synthetic Архив" },
      scope: { kind: "current-selection", orderedRootIds: rootIds },
      ownerConfirmedCurrent: true,
      counts: { pages: 1, roots: rootIds.length, artifacts: entries.length },
      diagnosticCounts: summary.counts,
      completeness: summary.completeness,
      capabilities: ["current-selection", "synthetic-test"],
      pluginApiLimitations: [],
    },
  };
}

function createEntireFileFixture(): SyntheticArchiveFixture {
  const snapshotId = requireSnapshotId("entire-file-fixture");
  const pageIds = ["page:one", "page:two", "page:unavailable"] as const;
  const rootIds = [
    "node:one-a",
    "node:one-b",
    "node:two-a",
    "node:two-failed",
  ] as const;
  const rawPageTwoPath = archivePaths.rawRestPage(snapshotId, pageIds[1]);
  const pageThreeArtifactPath = archivePaths.irNodePage(snapshotId, pageIds[2]);
  const componentDefinitionPath = archivePaths.irComponentDefinition(
    snapshotId,
    "component:synthetic/α",
  );
  const diagnostics: readonly SyntheticDiagnostic[] = [
    {
      id: "entire-file-raw-000001",
      code: "RAW_EXPORT_FAILED",
      severity: "error",
      message: "Synthetic page raw export failed.",
      phase: "raw",
      causedDataLoss: true,
      artifactPath: rawPageTwoPath,
      source: { kind: "page", id: pageIds[1] },
    },
    {
      id: "entire-file-root-000002",
      code: "PAGE_COLLECTION_FAILED",
      severity: "error",
      message: "Synthetic direct page root collection failed.",
      phase: "collection",
      causedDataLoss: true,
      source: { kind: "node", id: rootIds[3] },
    },
    {
      id: "entire-file-page-000003",
      code: "PAGE_COLLECTION_FAILED",
      severity: "error",
      message: "Synthetic page collection failed.",
      phase: "collection",
      causedDataLoss: true,
      artifactPath: pageThreeArtifactPath,
      source: { kind: "page", id: pageIds[2] },
    },
    {
      id: "entire-file-component-000004",
      code: "COMPONENT_DEFINITION_EXPORT_FAILED",
      severity: "error",
      message: "Synthetic component definition export failed.",
      phase: "collection",
      causedDataLoss: true,
      artifactPath: componentDefinitionPath,
      source: { kind: "component", id: "component:synthetic/α" },
    },
  ];
  const base = createFixture({
    snapshotId,
    rootIds: [],
    diagnostics,
  });

  const rawPageOnePath = archivePaths.rawRestPage(snapshotId, pageIds[0]);
  const pageOneArtifactPath = archivePaths.irNodePage(snapshotId, pageIds[0]);
  const pageTwoArtifactPath = archivePaths.irNodePage(snapshotId, pageIds[1]);
  const rawPageThreePath = archivePaths.rawRestPage(snapshotId, pageIds[2]);
  const pageEntries: readonly ArchiveEntryDescriptor[] = [
    descriptor(
      rawPageOnePath,
      "application/json",
      "deflate",
      serializeCanonicalJson({
        kind: "synthetic-raw-page",
        pageId: pageIds[0],
      }),
    ),
    descriptor(
      pageOneArtifactPath,
      "application/json",
      "deflate",
      serializeCanonicalJson({
        kind: "design-ir-page-index",
        schemaVersion: DESIGN_IR_SCHEMA_VERSION,
        source: { kind: "page", id: pageIds[0] },
        childNodeIds: [rootIds[0], rootIds[1]],
        normalizedTrees: [
          { source: { kind: "node", id: rootIds[0] } },
          { source: { kind: "node", id: rootIds[1] } },
        ],
        rawArtifact: {
          path: rawPageOnePath,
          mediaType: "application/json",
        },
        diagnosticIds: [],
      }),
    ),
    descriptor(
      pageTwoArtifactPath,
      "application/json",
      "deflate",
      serializeCanonicalJson({
        kind: "design-ir-page-index",
        schemaVersion: DESIGN_IR_SCHEMA_VERSION,
        source: { kind: "page", id: pageIds[1] },
        childNodeIds: [rootIds[2], rootIds[3]],
        normalizedTrees: [{ source: { kind: "node", id: rootIds[2] } }],
        diagnosticIds: ["entire-file-raw-000001", "entire-file-root-000002"],
      }),
    ),
    descriptor(
      rawPageThreePath,
      "application/json",
      "deflate",
      serializeCanonicalJson({
        kind: "synthetic-raw-page",
        pageId: pageIds[2],
      }),
    ),
  ];

  const documentEntry = descriptor(
    archivePaths.irDocument(snapshotId),
    "application/json",
    "deflate",
    serializeCanonicalJson({
      kind: "design-ir-document",
      schemaVersion: DESIGN_IR_SCHEMA_VERSION,
      source: { kind: "document", id: "document:synthetic" },
      name: "Synthetic Entire File",
      pages: pageIds.map((pageId) => ({ kind: "page", id: pageId })),
      currentPageId: pageIds[0],
      selectedRootIds: [],
      counts: {
        localVariables: {
          status: "collected",
          value: 0,
          coverage: "file-local",
        },
        localStyles: {
          status: "collected",
          value: 0,
          coverage: "file-local",
        },
        localComponents: {
          status: "collected",
          value: 1,
          coverage: "file-local",
        },
      },
      artifacts: {
        variables: {
          path: archivePaths.irVariables(snapshotId),
          mediaType: "application/json",
        },
        styles: {
          path: archivePaths.irStyles(snapshotId),
          mediaType: "application/json",
        },
        components: {
          path: archivePaths.irComponents(snapshotId),
          mediaType: "application/json",
        },
        nodeArtifacts: [pageOneArtifactPath, pageTwoArtifactPath].map(
          (path) => ({ path, mediaType: "application/json" }),
        ),
      },
      capabilities: ["entire-file"],
      limitations: [],
      diagnosticIds: diagnostics.map((diagnostic) => diagnostic.id),
    }),
  );

  const entries = [
    ...pageEntries,
    ...base.entries
      .filter((entry) => entry.metadata.path !== componentDefinitionPath)
      .map((entry) =>
        entry.metadata.path === archivePaths.irDocument(snapshotId)
          ? documentEntry
          : entry,
      ),
  ];
  const pageRequirements: readonly ArchiveArtifactRequirement[] = [
    { path: rawPageOnePath, status: "emitted" },
    { path: pageOneArtifactPath, status: "emitted" },
    {
      path: rawPageTwoPath,
      status: "unavailable",
      diagnosticId: "entire-file-raw-000001",
    },
    { path: pageTwoArtifactPath, status: "emitted" },
    { path: rawPageThreePath, status: "emitted" },
    {
      path: pageThreeArtifactPath,
      status: "unavailable",
      diagnosticId: "entire-file-page-000003",
    },
  ];
  const requirements = [
    ...pageRequirements,
    ...base.requirements.map((requirement) =>
      requirement.path === componentDefinitionPath
        ? {
            path: componentDefinitionPath,
            status: "unavailable" as const,
            diagnosticId: "entire-file-component-000004",
          }
        : requirement,
    ),
  ];
  const summary = summarizeSyntheticDiagnostics(diagnostics);
  return {
    snapshotId,
    rootIds,
    entries,
    requirements,
    draft: {
      ...base.draft,
      scope: { kind: "entire-file", orderedRootIds: rootIds },
      counts: {
        pages: pageIds.length,
        roots: rootIds.length,
        artifacts: entries.length,
      },
      diagnosticCounts: summary.counts,
      completeness: summary.completeness,
      capabilities: ["entire-file", "synthetic-test"],
    },
  };
}

function createRuntime(
  delay: (hashCall: number) => Promise<void> = () => Promise.resolve(),
): ArchiveBuilderRuntime {
  let hashCall = 0;
  return {
    encodeUtf8: (text) => TEXT_ENCODER.encode(text),
    decodeUtf8: (bytes) => TEXT_DECODER.decode(bytes),
    sha256: async (bytes) => {
      const currentCall = hashCall;
      hashCall += 1;
      await delay(currentCall);
      return sha256Hex(bytes);
    },
  };
}

async function populateBuilder(
  fixture: SyntheticArchiveFixture,
  runtime: ArchiveBuilderRuntime,
): Promise<StreamingArchiveBuilder> {
  const builder = new StreamingArchiveBuilder(fixture.snapshotId, runtime);
  for (const entry of fixture.entries) {
    await builder.addEntry(entry);
  }
  return builder;
}

async function finalizeFixture(
  fixture: SyntheticArchiveFixture,
  runtime: ArchiveBuilderRuntime,
): Promise<CompletedArchive> {
  const builder = await populateBuilder(fixture, runtime);
  return builder.finalize(fixture.draft, fixture.requirements);
}

function concatenate(chunks: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function requireUnzippedFile(
  files: Record<string, Uint8Array>,
  path: string,
): Uint8Array {
  const bytes = files[path];
  if (bytes === undefined) {
    throw new Error(`Missing synthetic ZIP entry: ${path}`);
  }
  return bytes;
}

function independentNodeSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseCentralDirectory(
  bytes: Uint8Array,
): readonly CentralDirectoryEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let endOffset = -1;
  for (let offset = bytes.byteLength - 22; offset >= 0; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) {
    throw new Error("Synthetic ZIP has no end-of-central-directory record.");
  }

  const entryCount = view.getUint16(endOffset + 10, true);
  let offset = view.getUint32(endOffset + 16, true);
  const result: CentralDirectoryEntry[] = [];
  for (let index = 0; index < entryCount; index += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error("Synthetic ZIP central-directory entry is malformed.");
    }
    const fileNameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const fileNameStart = offset + 46;
    result.push({
      path: TEXT_DECODER.decode(
        bytes.subarray(fileNameStart, fileNameStart + fileNameLength),
      ),
      compressionMethod: view.getUint16(offset + 10, true),
      dosTime: view.getUint16(offset + 12, true),
      dosDate: view.getUint16(offset + 14, true),
    });
    offset = fileNameStart + fileNameLength + extraLength + commentLength;
  }
  return result;
}

async function expectArchiveRejection(
  builder: StreamingArchiveBuilder,
  operation: Promise<unknown>,
  expectedCode: ArchiveAssemblyError["code"],
): Promise<void> {
  let resolved = false;
  let caught: unknown;
  try {
    await operation;
    resolved = true;
  } catch (error) {
    caught = error;
  }

  expect(resolved).toBe(false);
  expect(caught).toBeInstanceOf(ArchiveAssemblyError);
  expect(caught).toMatchObject({ code: expectedCode });
  if (builder.state === "active") {
    builder.cancel();
  }
  expect(builder.state).toBe("cancelled");
}

describe("streaming current-selection archive assembly", () => {
  it("round-trips a truthful two-root archive with exact Unicode, JSON, PNG, hashes, and lengths", async () => {
    const hashBacking = new Uint8Array(65_573).fill(0xa5);
    const hashView = hashBacking.subarray(19, hashBacking.byteLength - 23);
    for (let index = 0; index < hashView.byteLength; index += 1) {
      hashView[index] = (index * 37 + 11) & 0xff;
    }
    const hashInputBefore = Uint8Array.from(hashBacking);
    const bundledDigest = sha256Hex(hashView);
    expect(bundledDigest).toBe(independentNodeSha256(hashView));
    expect(bundledDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(hashBacking).toEqual(hashInputBefore);
    for (const byteLength of [0, 1, 55, 56, 63, 64, 65, 1024]) {
      const boundaryInput = Uint8Array.from(
        { length: byteLength },
        (_unused, index) => (index * 13 + byteLength) & 0xff,
      );
      expect(sha256Hex(boundaryInput), `SHA-256 length ${byteLength}`).toBe(
        independentNodeSha256(boundaryInput),
      );
    }

    const fixture = createFixture();
    const completed = await finalizeFixture(fixture, createRuntime());
    const zipBytes = concatenate(completed.chunks);
    const files = unzipSync(zipBytes);
    const manifestPath = archivePaths.manifest(fixture.snapshotId);
    const emittedPaths = fixture.entries.map((entry) => entry.metadata.path);
    const expectedPaths = [...emittedPaths, manifestPath].sort();

    expect(completed.filename).toBe(`${fixture.snapshotId}.design-ir.zip`);
    expect(Object.keys(files).sort()).toEqual(expectedPaths);

    const parsedJson = new Map<string, unknown>();
    for (const path of expectedPaths.filter((path) => path.endsWith(".json"))) {
      const text = strFromU8(requireUnzippedFile(files, path));
      expect(() => {
        JSON.parse(text);
      }, path).not.toThrow();
      parsedJson.set(path, JSON.parse(text) as unknown);
    }

    for (const rootId of fixture.rootIds) {
      const raw = parsedJson.get(
        archivePaths.rawRestRoot(fixture.snapshotId, rootId),
      ) as { readonly unicode: string };
      expect(raw.unicode).toBe(SYNTHETIC_UNICODE);
      expect(
        requireUnzippedFile(
          files,
          archivePaths.preview(fixture.snapshotId, rootId),
        ),
      ).toEqual(SYNTHETIC_PNG);
    }

    const unpackedManifest = parsedJson.get(manifestPath) as ArchiveManifest;
    expect(unpackedManifest).toEqual(completed.manifest);
    const manifestEntryPaths = completed.manifest.entries.map(
      (entry) => entry.path,
    );
    expect(manifestEntryPaths).toEqual([...emittedPaths].sort());
    expect(
      Object.keys(files)
        .filter((path) => path !== manifestPath)
        .sort(),
    ).toEqual(manifestEntryPaths);
    expect(manifestEntryPaths).not.toContain(manifestPath);
    const requiredGlobalPaths = [
      archivePaths.irVariables(fixture.snapshotId),
      archivePaths.irStyles(fixture.snapshotId),
      archivePaths.irComponents(fixture.snapshotId),
    ];
    expect(manifestEntryPaths).toEqual(
      expect.arrayContaining(requiredGlobalPaths),
    );
    expect(
      fixture.requirements
        .filter((requirement) => requirement.status === "emitted")
        .map((requirement) => requirement.path),
    ).toEqual(expect.arrayContaining(requiredGlobalPaths));
    const documentIr = parsedJson.get(
      archivePaths.irDocument(fixture.snapshotId),
    ) as {
      readonly artifacts: {
        readonly variables: { readonly path: string };
        readonly styles: { readonly path: string };
        readonly components: { readonly path: string };
      };
    };
    expect([
      documentIr.artifacts.variables.path,
      documentIr.artifacts.styles.path,
      documentIr.artifacts.components.path,
    ]).toEqual(requiredGlobalPaths);

    for (const metadata of completed.manifest.entries) {
      const unpacked = requireUnzippedFile(files, metadata.path);
      expect(metadata.uncompressedByteLength, metadata.path).toBe(
        unpacked.byteLength,
      );
      expect(metadata.contentSha256, metadata.path).toBe(
        independentNodeSha256(unpacked),
      );
    }
  });

  it("accepts metadata-only component definitions without definition artifacts", async () => {
    const fixture = createFixture({
      snapshotId: "archive-metadata-only",
      metadataOnlyComponentDefinition: true,
    });
    const completed = await finalizeFixture(fixture, createRuntime());
    const definitionArtifacts = completed.manifest.entries.map(
      (entry) => entry.path,
    );
    // The metadata-only record carries no artifact requirement, while the
    // artifact-bearing definition stays mandatory.
    expect(definitionArtifacts).not.toContain(
      archivePaths.irComponentDefinition(
        fixture.snapshotId,
        "component:metadata-set",
      ),
    );
    expect(definitionArtifacts).toContain(
      archivePaths.irComponentDefinition(
        fixture.snapshotId,
        "component:synthetic/α",
      ),
    );
  });

  it("produces deterministic bytes, order, compression, and fixed ZIP time across normalized completion timing", async () => {
    const fixture = createFixture({ snapshotId: "archive-deterministic" });
    const [immediate, delayed] = await Promise.all([
      finalizeFixture(fixture, createRuntime()),
      finalizeFixture(
        fixture,
        createRuntime(
          (hashCall) =>
            new Promise((resolve) => {
              setTimeout(resolve, hashCall % 2);
            }),
        ),
      ),
    ]);
    const immediateBytes = concatenate(immediate.chunks);
    const delayedBytes = concatenate(delayed.chunks);
    expect(delayedBytes).toEqual(immediateBytes);

    const centralEntries = parseCentralDirectory(immediateBytes);
    const manifestPath = archivePaths.manifest(fixture.snapshotId);
    const expectedOrder = [
      ...fixture.entries.map((entry) => entry.metadata.path),
      manifestPath,
    ];
    expect(centralEntries.map((entry) => entry.path)).toEqual(expectedOrder);
    expect(centralEntries.at(-1)?.path).toBe(manifestPath);

    for (const entry of centralEntries) {
      expect(entry.compressionMethod, entry.path).toBe(
        entry.path.endsWith(".png") ? 0 : 8,
      );
      expect(entry.dosTime, entry.path).toBe(0);
      expect(entry.dosDate, entry.path).toBe(33);
    }
  });

  it("allows only truthfully unavailable artifacts and rejects every fatal assembly path without completion", async () => {
    const rootId = "node:truthful";
    const previewDiagnosticId = "archive-preview-000001";
    const previewPath = archivePaths.preview(
      requireSnapshotId("archive-incomplete"),
      rootId,
    );
    const previewError: SyntheticDiagnostic = {
      id: previewDiagnosticId,
      code: "PREVIEW_EXPORT_FAILED",
      severity: "error",
      message: "Synthetic preview export failed.",
      phase: "preview",
      causedDataLoss: true,
      artifactPath: previewPath,
    };
    const incompleteFixture = createFixture({
      snapshotId: "archive-incomplete",
      rootIds: [rootId],
      diagnostics: [previewError],
      unavailablePreviews: new Map([[rootId, previewDiagnosticId]]),
    });
    const incomplete = await finalizeFixture(
      incompleteFixture,
      createRuntime(),
    );
    const incompleteFiles = unzipSync(concatenate(incomplete.chunks));
    expect(incomplete.manifest.completeness).toBe("incomplete");
    expect(incomplete.manifest.diagnosticCounts.error).toBe(1);
    expect(
      incomplete.manifest.entries.map((entry) => entry.path),
    ).not.toContain(previewPath);
    expect(incompleteFiles[previewPath]).toBeUndefined();

    const omittedBuilder = await populateBuilder(
      incompleteFixture,
      createRuntime(),
    );
    await expectArchiveRejection(
      omittedBuilder,
      omittedBuilder.finalize(
        incompleteFixture.draft,
        incompleteFixture.requirements.filter(
          (requirement) => requirement.path !== previewPath,
        ),
      ),
      "missing-required-artifact",
    );

    const missingGlobalRequirementFixture = createFixture({
      snapshotId: "contract-missing-global-requirement",
      rootIds: [rootId],
    });
    const missingGlobalRequirementBuilder = await populateBuilder(
      missingGlobalRequirementFixture,
      createRuntime(),
    );
    const variablesPath = archivePaths.irVariables(
      missingGlobalRequirementFixture.snapshotId,
    );
    await expectArchiveRejection(
      missingGlobalRequirementBuilder,
      missingGlobalRequirementBuilder.finalize(
        missingGlobalRequirementFixture.draft,
        missingGlobalRequirementFixture.requirements.filter(
          (requirement) => requirement.path !== variablesPath,
        ),
      ),
      "missing-required-artifact",
    );

    const mismatchedGlobalRefSnapshot = requireSnapshotId(
      "contract-mismatched-global-ref",
    );
    const mismatchedGlobalRefFixture = createFixture({
      snapshotId: mismatchedGlobalRefSnapshot,
      rootIds: [rootId],
      variablesArtifactPathOverride: archivePaths.irStyles(
        mismatchedGlobalRefSnapshot,
      ),
    });
    const mismatchedGlobalRefBuilder = await populateBuilder(
      mismatchedGlobalRefFixture,
      createRuntime(),
    );
    await expectArchiveRejection(
      mismatchedGlobalRefBuilder,
      mismatchedGlobalRefBuilder.finalize(
        mismatchedGlobalRefFixture.draft,
        mismatchedGlobalRefFixture.requirements,
      ),
      "invalid-manifest",
    );

    const missingComponentDefinitionFixture = createFixture({
      snapshotId: "contract-missing-component-definition",
      rootIds: [rootId],
    });
    const missingComponentDefinitionBuilder = await populateBuilder(
      missingComponentDefinitionFixture,
      createRuntime(),
    );
    const componentDefinitionPath = archivePaths.irComponentDefinition(
      missingComponentDefinitionFixture.snapshotId,
      "component:synthetic/α",
    );
    await expectArchiveRejection(
      missingComponentDefinitionBuilder,
      missingComponentDefinitionBuilder.finalize(
        missingComponentDefinitionFixture.draft,
        missingComponentDefinitionFixture.requirements.filter(
          (requirement) => requirement.path !== componentDefinitionPath,
        ),
      ),
      "missing-required-artifact",
    );

    const mismatchedComponentDefinitionSnapshot = requireSnapshotId(
      "contract-mismatched-component-definition",
    );
    const mismatchedComponentDefinitionFixture = createFixture({
      snapshotId: mismatchedComponentDefinitionSnapshot,
      rootIds: [rootId],
      componentDefinitionArtifactPathOverride: archivePaths.irStyles(
        mismatchedComponentDefinitionSnapshot,
      ),
    });
    const mismatchedComponentDefinitionBuilder = await populateBuilder(
      mismatchedComponentDefinitionFixture,
      createRuntime(),
    );
    await expectArchiveRejection(
      mismatchedComponentDefinitionBuilder,
      mismatchedComponentDefinitionBuilder.finalize(
        mismatchedComponentDefinitionFixture.draft,
        mismatchedComponentDefinitionFixture.requirements,
      ),
      "invalid-manifest",
    );

    const orphanComponentDefinitionFixture = createFixture({
      snapshotId: "contract-orphan-component-definition",
      rootIds: [rootId],
      omitComponentDefinitionIndexEntry: true,
    });
    const orphanComponentDefinitionBuilder = await populateBuilder(
      orphanComponentDefinitionFixture,
      createRuntime(),
    );
    await expectArchiveRejection(
      orphanComponentDefinitionBuilder,
      orphanComponentDefinitionBuilder.finalize(
        orphanComponentDefinitionFixture.draft,
        orphanComponentDefinitionFixture.requirements,
      ),
      "invalid-manifest",
    );

    const mismatchedBinaryReferenceFixture = createFixture({
      snapshotId: "media-mismatched-binary-reference",
      rootIds: [rootId],
      previewReferenceHashOverride: "d".repeat(64),
    });
    const mismatchedBinaryReferenceBuilder = await populateBuilder(
      mismatchedBinaryReferenceFixture,
      createRuntime(),
    );
    await expectArchiveRejection(
      mismatchedBinaryReferenceBuilder,
      mismatchedBinaryReferenceBuilder.finalize(
        mismatchedBinaryReferenceFixture.draft,
        mismatchedBinaryReferenceFixture.requirements,
      ),
      "missing-required-artifact",
    );

    const dishonestSummary: DiagnosticSummary = {
      counts: { info: 0, warning: 0, error: 0, fatal: 0 },
      completeness: "complete",
    };
    const dishonestFixture = createFixture({
      snapshotId: "archive-dishonest",
      rootIds: [rootId],
      diagnostics: [
        {
          ...previewError,
          artifactPath: archivePaths.preview(
            requireSnapshotId("archive-dishonest"),
            rootId,
          ),
        },
      ],
      unavailablePreviews: new Map([[rootId, previewDiagnosticId]]),
      summaryOverride: dishonestSummary,
    });
    const dishonestBuilder = await populateBuilder(
      dishonestFixture,
      createRuntime(),
    );
    await expectArchiveRejection(
      dishonestBuilder,
      dishonestBuilder.finalize(
        dishonestFixture.draft,
        dishonestFixture.requirements,
      ),
      "invalid-manifest",
    );

    const mismatchedPathFixture = createFixture({
      snapshotId: "archive-mismatched-artifact",
      rootIds: [rootId],
      diagnostics: [
        {
          ...previewError,
          artifactPath: archivePaths.irNodeRoot(
            requireSnapshotId("archive-mismatched-artifact"),
            rootId,
          ),
        },
      ],
      unavailablePreviews: new Map([[rootId, previewDiagnosticId]]),
    });
    const mismatchedPathBuilder = await populateBuilder(
      mismatchedPathFixture,
      createRuntime(),
    );
    await expectArchiveRejection(
      mismatchedPathBuilder,
      mismatchedPathBuilder.finalize(
        mismatchedPathFixture.draft,
        mismatchedPathFixture.requirements,
      ),
      "missing-required-artifact",
    );

    const fatalDiagnosticId = "archive-fatal-000001";
    const fatalFixture = createFixture({
      snapshotId: "archive-fatal",
      rootIds: [rootId],
      diagnostics: [
        {
          id: fatalDiagnosticId,
          code: "ARCHIVE_FATAL",
          severity: "fatal",
          message: "Synthetic fatal archive diagnostic.",
          phase: "archive",
          causedDataLoss: true,
        },
      ],
      unavailablePreviews: new Map([[rootId, fatalDiagnosticId]]),
    });
    const fatalBuilder = await populateBuilder(fatalFixture, createRuntime());
    await expectArchiveRejection(
      fatalBuilder,
      fatalBuilder.finalize(fatalFixture.draft, fatalFixture.requirements),
      "invalid-manifest",
    );

    const mismatchSnapshot = requireSnapshotId("archive-media-mismatch");
    const mismatchCases: readonly ArchiveEntryDescriptor[] = [
      descriptor(
        archivePaths.preview(mismatchSnapshot, rootId),
        "image/png",
        "store",
        "synthetic text in a binary entry",
      ),
      descriptor(
        archivePaths.irDocument(mismatchSnapshot),
        "application/json",
        "deflate",
        TEXT_ENCODER.encode("{}\n"),
      ),
    ];
    for (const mismatch of mismatchCases) {
      const mismatchBuilder = new StreamingArchiveBuilder(
        mismatchSnapshot,
        createRuntime(),
      );
      await expectArchiveRejection(
        mismatchBuilder,
        mismatchBuilder.addEntry(mismatch),
        "invalid-entry",
      );
    }

    const invalidJsonBuilder = new StreamingArchiveBuilder(
      mismatchSnapshot,
      createRuntime(),
    );
    await expectArchiveRejection(
      invalidJsonBuilder,
      invalidJsonBuilder.addEntry(
        descriptor(
          archivePaths.irDocument(mismatchSnapshot),
          "application/json",
          "deflate",
          "{invalid-json}\n",
        ),
      ),
      "invalid-json",
    );

    const hashFailureBuilder = new StreamingArchiveBuilder(mismatchSnapshot, {
      ...createRuntime(),
      sha256: () => Promise.reject(new Error("Synthetic hash failure.")),
    });
    await expectArchiveRejection(
      hashFailureBuilder,
      hashFailureBuilder.addEntry(
        descriptor(
          archivePaths.irDocument(mismatchSnapshot),
          "application/json",
          "deflate",
          "{}\n",
        ),
      ),
      "hash-failed",
    );

    const duplicateBuilder = new StreamingArchiveBuilder(
      mismatchSnapshot,
      createRuntime(),
    );
    const duplicateEntry = descriptor(
      archivePaths.irDocument(mismatchSnapshot),
      "application/json",
      "deflate",
      "{}\n",
    );
    await duplicateBuilder.addEntry(duplicateEntry);
    await expectArchiveRejection(
      duplicateBuilder,
      duplicateBuilder.addEntry(duplicateEntry),
      "duplicate-entry",
    );

    expect(ARCHIVE_TOTAL_LIVE_BYTE_LIMIT).toBe(384 * 1024 * 1024);
    expect(ARCHIVE_SINGLE_ENTRY_BYTE_LIMIT).toBe(64 * 1024 * 1024);
    expect(ARCHIVE_MAX_PRE_MANIFEST_ENTRY_COUNT).toBe(65_534);
    expect(utf8ByteLength("aé😀\ud800")).toBe(10);
    expect(utf8ByteLength("aé😀\ud800")).toBe(
      new TextEncoder().encode("aé😀\ud800").byteLength,
    );

    const capacityEntry = descriptor(
      archivePaths.preview(mismatchSnapshot, "node:capacity-one"),
      "image/png",
      "store",
      new Uint8Array(8),
    );
    const capacityProbe = new StreamingArchiveBuilder(
      mismatchSnapshot,
      createRuntime(),
    );
    await capacityProbe.addEntry(capacityEntry);
    const firstEntryRetainedBytes = capacityProbe.retainedZipByteLength;
    expect(capacityProbe.acceptedEntryCount).toBe(1);
    expect(capacityProbe.entryCount).toBe(1);
    expect(firstEntryRetainedBytes).toBeGreaterThan(0);
    capacityProbe.cancel();
    expect(capacityProbe.acceptedEntryCount).toBe(0);
    expect(capacityProbe.retainedZipByteLength).toBe(0);

    const singleEntryCapacityBuilder = new StreamingArchiveBuilder(
      mismatchSnapshot,
      createRuntime(),
      {
        totalLiveByteLimit: 128,
        singleEntryByteLimit: 8,
        preManifestEntryCountLimit: 2,
      },
    );
    await expect(
      singleEntryCapacityBuilder.addEntry({
        ...capacityEntry,
        data: new Uint8Array(9),
      }),
    ).rejects.toMatchObject({ code: "archive-capacity-exceeded" });
    expect(singleEntryCapacityBuilder.acceptedEntryCount).toBe(0);
    expect(singleEntryCapacityBuilder.retainedZipByteLength).toBe(0);
    singleEntryCapacityBuilder.cancel();

    const overlapCapacityBuilder = new StreamingArchiveBuilder(
      mismatchSnapshot,
      createRuntime(),
      {
        totalLiveByteLimit: firstEntryRetainedBytes + 8,
        singleEntryByteLimit: 8,
        preManifestEntryCountLimit: 2,
      },
    );
    await overlapCapacityBuilder.addEntry(capacityEntry);
    expect(overlapCapacityBuilder.acceptedEntryCount).toBe(1);
    expect(overlapCapacityBuilder.retainedZipByteLength).toBe(
      firstEntryRetainedBytes,
    );
    await expect(
      overlapCapacityBuilder.addEntry(
        descriptor(
          archivePaths.preview(mismatchSnapshot, "node:capacity-two"),
          "image/png",
          "store",
          new Uint8Array(8),
        ),
      ),
    ).rejects.toMatchObject({ code: "archive-capacity-exceeded" });
    expect(overlapCapacityBuilder.acceptedEntryCount).toBe(0);
    expect(overlapCapacityBuilder.entryCount).toBe(0);
    expect(overlapCapacityBuilder.retainedZipByteLength).toBe(0);
    overlapCapacityBuilder.cancel();

    const entryLimitBuilder = new StreamingArchiveBuilder(
      mismatchSnapshot,
      createRuntime(),
      {
        totalLiveByteLimit: 1024,
        singleEntryByteLimit: 8,
        preManifestEntryCountLimit: 1,
      },
    );
    await entryLimitBuilder.addEntry(capacityEntry);
    await expect(
      entryLimitBuilder.addEntry(
        descriptor(
          archivePaths.preview(mismatchSnapshot, "node:entry-limit"),
          "image/png",
          "store",
          new Uint8Array(1),
        ),
      ),
    ).rejects.toMatchObject({ code: "archive-entry-limit-exceeded" });
    expect(entryLimitBuilder.acceptedEntryCount).toBe(0);
    expect(entryLimitBuilder.entryCount).toBe(0);
    expect(entryLimitBuilder.retainedZipByteLength).toBe(0);
    entryLimitBuilder.cancel();

    const cancelledBuilder = new StreamingArchiveBuilder(
      incompleteFixture.snapshotId,
      createRuntime(),
    );
    cancelledBuilder.cancel();
    await expectArchiveRejection(
      cancelledBuilder,
      cancelledBuilder.finalize(
        incompleteFixture.draft,
        incompleteFixture.requirements,
      ),
      "cancelled",
    );
    expect(cancelledBuilder.entryCount).toBe(0);
  });
});

describe("streaming entire-file archive validation", () => {
  it("closes ordered page/global artifacts while permitting truthfully isolated losses", async () => {
    const fixture = createEntireFileFixture();
    const completed = await finalizeFixture(fixture, createRuntime());
    const files = unzipSync(concatenate(completed.chunks));
    const componentDefinitionPath = archivePaths.irComponentDefinition(
      fixture.snapshotId,
      "component:synthetic/α",
    );
    const rawPageTwoPath = archivePaths.rawRestPage(
      fixture.snapshotId,
      "page:two",
    );
    const rawPageThreePath = archivePaths.rawRestPage(
      fixture.snapshotId,
      "page:unavailable",
    );
    const pageThreeArtifactPath = archivePaths.irNodePage(
      fixture.snapshotId,
      "page:unavailable",
    );

    expect(completed.manifest.scope).toEqual({
      kind: "entire-file",
      orderedRootIds: fixture.rootIds,
    });
    expect(completed.manifest.counts).toMatchObject({ pages: 3, roots: 4 });
    expect(completed.manifest.completeness).toBe("incomplete");
    expect(files[rawPageTwoPath]).toBeUndefined();
    expect(files[pageThreeArtifactPath]).toBeUndefined();
    expect(files[componentDefinitionPath]).toBeUndefined();
    expect(files[rawPageThreePath]).toBeDefined();

    const document = JSON.parse(
      strFromU8(
        requireUnzippedFile(files, archivePaths.irDocument(fixture.snapshotId)),
      ),
    ) as {
      readonly pages: readonly { readonly id: string }[];
      readonly artifacts: {
        readonly nodeArtifacts: readonly { readonly path: string }[];
      };
    };
    expect(document.pages.map((page) => page.id)).toEqual([
      "page:one",
      "page:two",
      "page:unavailable",
    ]);
    expect(
      document.artifacts.nodeArtifacts.map((artifact) => artifact.path),
    ).toEqual([
      archivePaths.irNodePage(fixture.snapshotId, "page:one"),
      archivePaths.irNodePage(fixture.snapshotId, "page:two"),
    ]);

    const globalPaths = [
      archivePaths.irVariables(fixture.snapshotId),
      archivePaths.irStyles(fixture.snapshotId),
      archivePaths.irComponents(fixture.snapshotId),
    ];
    for (const globalPath of globalPaths) {
      expect(
        completed.manifest.entries.filter((entry) => entry.path === globalPath),
      ).toHaveLength(1);
    }
    const components = JSON.parse(
      strFromU8(
        requireUnzippedFile(
          files,
          archivePaths.irComponents(fixture.snapshotId),
        ),
      ),
    ) as {
      readonly definitions: readonly {
        readonly definitionArtifact: { readonly path: string };
      }[];
    };
    expect(components.definitions[0]?.definitionArtifact.path).toBe(
      componentDefinitionPath,
    );

    const pageTwoPath = archivePaths.irNodePage(fixture.snapshotId, "page:two");
    const invalidEntries = fixture.entries.map((entry) => {
      if (
        entry.metadata.path === archivePaths.diagnostics(fixture.snapshotId) &&
        typeof entry.data === "string"
      ) {
        const diagnosticsArtifact = JSON.parse(entry.data) as {
          readonly diagnostics: readonly Record<string, unknown>[];
          readonly [key: string]: unknown;
        };
        return descriptor(
          entry.metadata.path,
          "application/json",
          "deflate",
          serializeCanonicalJson({
            ...diagnosticsArtifact,
            diagnostics: diagnosticsArtifact.diagnostics.map((diagnostic) =>
              diagnostic.id === "entire-file-raw-000001"
                ? {
                    ...diagnostic,
                    code: "ARCHIVE_ENTRY_TOO_LARGE",
                    propertyPath: "$.normalizedTrees",
                  }
                : diagnostic,
            ),
          }),
        );
      }
      if (
        entry.metadata.path !== pageTwoPath ||
        typeof entry.data !== "string"
      ) {
        return entry;
      }
      const page = JSON.parse(entry.data) as Record<string, unknown>;
      return descriptor(
        pageTwoPath,
        "application/json",
        "deflate",
        serializeCanonicalJson({
          ...page,
          diagnosticIds: ["entire-file-raw-000001"],
        }),
      );
    });
    const invalidFixture: SyntheticArchiveFixture = {
      ...fixture,
      entries: invalidEntries,
    };
    const invalidBuilder = await populateBuilder(
      invalidFixture,
      createRuntime(),
    );
    await expectArchiveRejection(
      invalidBuilder,
      invalidBuilder.finalize(
        invalidFixture.draft,
        invalidFixture.requirements,
      ),
      "missing-required-artifact",
    );
  });
});
