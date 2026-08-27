/// <reference lib="dom" />

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type {
  ArchiveAssemblyErrorCode,
  ArchiveBuilderRuntime,
  CompletedArchive,
} from "../src/shared/archive-builder";
import {
  archivePaths,
  requireSnapshotId,
  type ArchiveManifestDraft,
  type SnapshotId,
} from "../src/shared/archive";
import {
  ARCHIVE_FORMAT_VERSION,
  DESIGN_IR_SCHEMA_VERSION,
} from "../src/shared/ir";
import {
  PROTOCOL_VERSION,
  type ArchiveEntryAccepted,
  type ArchiveEntryMessage,
  type ExportFailureCode,
  type ExportId,
  type ExportReady,
} from "../src/shared/protocol";
import { serializeCanonicalJson } from "../src/shared/serialization";
import { sha256Hex } from "../src/shared/sha256";
import {
  ExportSessionController,
  formatSaveHandoffMessage,
} from "../src/ui/export-session";

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder("utf-8", { fatal: true });

interface SessionFixture {
  readonly snapshotId: SnapshotId;
  readonly entries: readonly ArchiveEntryMessage[];
  readonly ready: ExportReady;
}

function createEntry(
  exportId: ExportId,
  sequence: number,
  path: string,
  mediaType: string,
  compression: "deflate" | "store",
  data: string | Uint8Array,
): ArchiveEntryMessage {
  return {
    type: "archive-entry",
    protocolVersion: PROTOCOL_VERSION,
    exportId,
    sequence,
    path,
    mediaType,
    compression,
    data,
  };
}

function createSessionFixture(
  exportId: ExportId,
  snapshotValue: string,
  rootId: string,
): SessionFixture {
  const snapshotId = requireSnapshotId(snapshotValue);
  const previewBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 67]);
  const zeroCounts = { info: 0, warning: 0, error: 0, fatal: 0 } as const;
  let entrySequence = 0;
  const fixtureEntry = (
    path: string,
    mediaType: string,
    compression: "deflate" | "store",
    data: string | Uint8Array,
  ): ArchiveEntryMessage => {
    entrySequence += 1;
    return createEntry(
      exportId,
      entrySequence,
      path,
      mediaType,
      compression,
      data,
    );
  };
  const entries: readonly ArchiveEntryMessage[] = [
    fixtureEntry(
      archivePaths.rawRestRoot(snapshotId, rootId),
      "application/json",
      "deflate",
      serializeCanonicalJson({
        kind: "invented-raw-root",
        rootId,
        label: "Синтетический узел 🚲",
      }),
    ),
    fixtureEntry(
      archivePaths.preview(snapshotId, rootId),
      "image/png",
      "store",
      previewBytes,
    ),
    fixtureEntry(
      archivePaths.irNodeRoot(snapshotId, rootId),
      "application/json",
      "deflate",
      serializeCanonicalJson({
        kind: "design-ir-root-index",
        rootId,
        previews: [
          {
            sourceNode: { kind: "node", id: rootId },
            archivePath: archivePaths.preview(snapshotId, rootId),
            mediaType: "image/png",
            sourceBounds: { x: 0, y: 0, width: 1, height: 1 },
            exportedBounds: { x: 0, y: 0, width: 1, height: 1 },
            scale: 1,
            byteLength: previewBytes.byteLength,
            contentSha256: sha256Hex(previewBytes),
            diagnosticIds: [],
          },
        ],
      }),
    ),
    fixtureEntry(
      archivePaths.irVariables(snapshotId),
      "application/json",
      "deflate",
      serializeCanonicalJson({
        kind: "design-ir-variables",
        schemaVersion: DESIGN_IR_SCHEMA_VERSION,
        collections: [],
        variables: [],
      }),
    ),
    fixtureEntry(
      archivePaths.irStyles(snapshotId),
      "application/json",
      "deflate",
      serializeCanonicalJson({
        kind: "design-ir-styles",
        schemaVersion: DESIGN_IR_SCHEMA_VERSION,
        styles: [],
      }),
    ),
    fixtureEntry(
      archivePaths.irComponents(snapshotId),
      "application/json",
      "deflate",
      serializeCanonicalJson({
        kind: "design-ir-components",
        schemaVersion: DESIGN_IR_SCHEMA_VERSION,
        definitions: [],
        dependencies: [],
      }),
    ),
    fixtureEntry(
      archivePaths.irDocument(snapshotId),
      "application/json",
      "deflate",
      serializeCanonicalJson({
        kind: "design-ir-document",
        schemaVersion: DESIGN_IR_SCHEMA_VERSION,
        selectedRootIds: [rootId],
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
          nodeArtifacts: [
            {
              path: archivePaths.irNodeRoot(snapshotId, rootId),
              mediaType: "application/json",
            },
          ],
        },
      }),
    ),
    fixtureEntry(
      archivePaths.diagnostics(snapshotId),
      "application/json",
      "deflate",
      serializeCanonicalJson({
        kind: "design-ir-diagnostics",
        schemaVersion: DESIGN_IR_SCHEMA_VERSION,
        summary: { counts: zeroCounts, completeness: "complete" },
        diagnostics: [],
      }),
    ),
    fixtureEntry(
      archivePaths.agentIndex(snapshotId),
      "text/markdown",
      "deflate",
      "# Invented session fixture\n",
    ),
  ];
  const manifestDraft: ArchiveManifestDraft = {
    archiveVersion: ARCHIVE_FORMAT_VERSION,
    schemaVersion: DESIGN_IR_SCHEMA_VERSION,
    exporter: {
      packageName: "figma-design-ir",
      packageVersion: "0.1.0",
    },
    snapshotId,
    exportedAtUtc: "2026-08-13T13:00:00.000Z",
    editorType: "figma",
    document: { name: "Invented Session Document" },
    scope: { kind: "current-selection", orderedRootIds: [rootId] },
    ownerConfirmedCurrent: true,
    counts: { pages: 1, roots: 1, artifacts: entries.length },
    diagnosticCounts: zeroCounts,
    completeness: "complete",
    capabilities: ["current-selection", "invented-session-test"],
    pluginApiLimitations: [],
  };

  return {
    snapshotId,
    entries,
    ready: {
      type: "export-ready",
      protocolVersion: PROTOCOL_VERSION,
      exportId,
      manifestDraft,
      artifacts: entries.map((entry) => ({
        path: entry.path,
        status: "emitted" as const,
      })),
    },
  };
}

function requireEntry(
  fixture: SessionFixture,
  index: number,
): ArchiveEntryMessage {
  const entry = fixture.entries[index];
  if (entry === undefined) {
    throw new Error("The invented session fixture is incomplete.");
  }
  return entry;
}

async function drainQueuedOperations(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("ExportSessionController", () => {
  it("acknowledges only accepted entries, rejects overtaking and stale work, and recovers", async () => {
    const exportA = "export-000101";
    const exportB = "export-000102";
    const exportC = "export-000103";
    const exportD = "export-000104";
    const exportE = "export-000105";
    const fixtureA = createSessionFixture(exportA, "session-a", "node:a");
    const fixtureB = createSessionFixture(exportB, "session-b", "node:b");
    const fixtureC = createSessionFixture(exportC, "session-c", "node:c");
    const fixtureD = createSessionFixture(exportD, "session-d", "node:d");
    const fixtureE = createSessionFixture(exportE, "session-e", "node:e");
    let releaseDelayedHash = (): void => {
      throw new Error("The delayed hash was not initialized.");
    };
    const delayedHash = new Promise<void>((resolve) => {
      releaseDelayedHash = resolve;
    });
    let reportHashStarted = (): void => {
      throw new Error("The hash-start signal was not initialized.");
    };
    const hashStarted = new Promise<void>((resolve) => {
      reportHashStarted = resolve;
    });
    let hashCalls = 0;
    const runtime: ArchiveBuilderRuntime = {
      encodeUtf8: (text) => ENCODER.encode(text),
      decodeUtf8: (bytes) => DECODER.decode(bytes),
      sha256: async (bytes) => {
        hashCalls += 1;
        if (hashCalls === 1) {
          reportHashStarted();
          await delayedHash;
        }
        return createHash("sha256").update(bytes).digest("hex");
      },
    };
    const finalizedArchives: CompletedArchive[] = [];
    const archiveFailureCancellations: ExportId[] = [];
    const cancellations: ExportId[] = [];
    const failures: Array<{
      readonly exportId: ExportId;
      readonly code: ExportFailureCode;
    }> = [];
    const acceptedEntries: Array<{
      readonly message: ArchiveEntryAccepted;
      readonly acceptedEntryCount: number;
      readonly retainedZipByteLength: number;
    }> = [];
    const controller = new ExportSessionController(runtime, {
      onEntryAccepted: (message, stats) =>
        acceptedEntries.push({
          message,
          acceptedEntryCount: stats.acceptedEntryCount,
          retainedZipByteLength: stats.retainedZipByteLength,
        }),
      onArchiveFinalized: (archive) => finalizedArchives.push(archive),
      onArchiveAssemblyFailed: (exportId) =>
        archiveFailureCancellations.push(exportId),
      onCancelled: (exportId) => cancellations.push(exportId),
      onFailed: (exportId, code) => failures.push({ exportId, code }),
    });

    controller.start(exportA, fixtureA.snapshotId);
    controller.acceptEntry(requireEntry(fixtureA, 0));
    await hashStarted;
    expect(controller.activeExportId).toBe(exportA);
    expect(hashCalls).toBe(1);

    expect(controller.cancelActive()).toBe(exportA);
    expect(controller.activeExportId).toBeNull();
    expect(cancellations).toEqual([exportA]);
    expect(failures).toEqual([]);
    expect(finalizedArchives).toEqual([]);
    expect(archiveFailureCancellations).toEqual([]);
    expect(acceptedEntries).toEqual([]);
    releaseDelayedHash();
    await drainQueuedOperations();
    expect(controller.activeExportId).toBeNull();
    expect(failures).toEqual([]);
    expect(finalizedArchives).toEqual([]);
    expect(acceptedEntries).toEqual([]);

    controller.start(exportB, fixtureB.snapshotId);
    controller.acceptEntry(requireEntry(fixtureA, 1));
    controller.acceptReady(fixtureA.ready);
    controller.acceptCancelled({
      type: "export-cancelled",
      protocolVersion: PROTOCOL_VERSION,
      exportId: exportA,
    });
    controller.acceptFailed({
      type: "export-failed",
      protocolVersion: PROTOCOL_VERSION,
      requestId: "export-request-a",
      exportId: exportA,
      safeError: { code: "collection-failed" },
    });
    await drainQueuedOperations();
    expect(controller.activeExportId).toBe(exportB);
    expect(hashCalls).toBe(1);
    expect(cancellations).toEqual([exportA]);
    expect(failures).toEqual([]);
    expect(finalizedArchives).toEqual([]);

    controller.acceptEntry({
      ...requireEntry(fixtureB, 0),
      data: '{"invented":',
    });
    await drainQueuedOperations();
    expect(controller.activeExportId).toBeNull();
    expect(cancellations).toEqual([exportA]);
    expect(failures).toEqual([{ exportId: exportB, code: "archive-failed" }]);
    expect(archiveFailureCancellations).toEqual([exportB]);
    expect(finalizedArchives).toEqual([]);
    expect(acceptedEntries).toEqual([]);

    controller.start(exportC, fixtureC.snapshotId);
    controller.acceptEntry(requireEntry(fixtureC, 0));
    controller.acceptReady(fixtureC.ready);
    await drainQueuedOperations();
    expect(controller.activeExportId).toBeNull();
    expect(archiveFailureCancellations).toEqual([exportB, exportC]);
    expect(acceptedEntries).toEqual([]);

    controller.start(exportD, fixtureD.snapshotId);
    controller.acceptEntry(requireEntry(fixtureD, 1));
    await drainQueuedOperations();
    expect(controller.activeExportId).toBeNull();
    expect(archiveFailureCancellations).toEqual([exportB, exportC, exportD]);
    expect(acceptedEntries).toEqual([]);

    controller.start(exportE, fixtureE.snapshotId);
    for (const entry of fixtureE.entries) {
      controller.acceptEntry(entry);
      await drainQueuedOperations();
    }
    controller.acceptReady(fixtureE.ready);
    await drainQueuedOperations();

    expect(controller.activeExportId).toBeNull();
    expect(finalizedArchives).toHaveLength(1);
    expect(finalizedArchives[0]?.filename).toBe("session-e.design-ir.zip");
    expect(finalizedArchives[0]?.manifest.snapshotId).toBe("session-e");
    expect(
      acceptedEntries.map(({ message, acceptedEntryCount }) => ({
        message,
        acceptedEntryCount,
      })),
    ).toEqual(
      fixtureE.entries.map((entry, index) => ({
        message: {
          type: "archive-entry-accepted",
          protocolVersion: PROTOCOL_VERSION,
          exportId: exportE,
          sequence: entry.sequence,
        },
        acceptedEntryCount: index + 1,
      })),
    );
    expect(
      acceptedEntries.every(
        (entry, index) =>
          Number.isSafeInteger(entry.retainedZipByteLength) &&
          entry.retainedZipByteLength >= 0 &&
          (index === 0 ||
            entry.retainedZipByteLength >=
              (acceptedEntries[index - 1]?.retainedZipByteLength ?? 0)),
      ),
    ).toBe(true);
    expect(acceptedEntries.at(-1)?.retainedZipByteLength).toBeGreaterThan(0);
    const saveHandoff = formatSaveHandoffMessage(finalizedArchives[0]!);
    expect(saveHandoff).toContain("Archive assembled (complete)");
    expect(saveHandoff).toContain(
      "Local saving was requested for session-e.design-ir.zip",
    );
    expect(saveHandoff).toContain(
      "cannot confirm whether the file was saved or cancelled",
    );
    expect(saveHandoff).not.toContain("Downloaded");
    expect(cancellations).toEqual([exportA]);
    expect(failures).toEqual([
      { exportId: exportB, code: "archive-failed" },
      { exportId: exportC, code: "archive-failed" },
      { exportId: exportD, code: "archive-failed" },
    ]);
    expect(archiveFailureCancellations).toEqual([exportB, exportC, exportD]);

    const safetyFailures: Array<{
      readonly exportId: ExportId;
      readonly code: ExportFailureCode;
      readonly archiveCode: ArchiveAssemblyErrorCode | undefined;
    }> = [];
    const safetyFailureCancellations: ExportId[] = [];
    const safetyCallbacks = {
      onEntryAccepted: () => undefined,
      onArchiveFinalized: () => undefined,
      onArchiveAssemblyFailed: (exportId: ExportId) =>
        safetyFailureCancellations.push(exportId),
      onCancelled: () => undefined,
      onFailed: (
        exportId: ExportId,
        code: ExportFailureCode,
        archiveCode?: ArchiveAssemblyErrorCode,
      ) => safetyFailures.push({ exportId, code, archiveCode }),
    };

    const capacityExport = "export-000106";
    const capacityFixture = createSessionFixture(
      capacityExport,
      "session-capacity",
      "node:capacity",
    );
    const capacityController = new ExportSessionController(
      runtime,
      safetyCallbacks,
      {
        totalLiveByteLimit: 1024,
        singleEntryByteLimit: 8,
        preManifestEntryCountLimit: 10,
      },
    );
    capacityController.start(capacityExport, capacityFixture.snapshotId);
    capacityController.acceptEntry(requireEntry(capacityFixture, 0));
    await drainQueuedOperations();

    const entryLimitExport = "export-000107";
    const entryLimitFixture = createSessionFixture(
      entryLimitExport,
      "session-entry-limit",
      "node:entry-limit",
    );
    const entryLimitController = new ExportSessionController(
      runtime,
      safetyCallbacks,
      {
        totalLiveByteLimit: 1024 * 1024,
        singleEntryByteLimit: 512 * 1024,
        preManifestEntryCountLimit: 1,
      },
    );
    entryLimitController.start(entryLimitExport, entryLimitFixture.snapshotId);
    entryLimitController.acceptEntry(requireEntry(entryLimitFixture, 0));
    await drainQueuedOperations();
    entryLimitController.acceptEntry(requireEntry(entryLimitFixture, 1));
    await drainQueuedOperations();

    expect(safetyFailureCancellations).toEqual([
      capacityExport,
      entryLimitExport,
    ]);
    expect(safetyFailures).toEqual([
      {
        exportId: capacityExport,
        code: "archive-capacity-exceeded",
        archiveCode: "archive-capacity-exceeded",
      },
      {
        exportId: entryLimitExport,
        code: "archive-entry-limit-exceeded",
        archiveCode: "archive-entry-limit-exceeded",
      },
    ]);
  });
});
