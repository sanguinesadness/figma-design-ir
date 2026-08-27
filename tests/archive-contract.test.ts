import { describe, expect, it } from "vitest";

import {
  ArchiveEntryRegistry,
  ArchivePathError,
  DuplicateArchivePathError,
  archivePaths,
  assertSafeArchivePath,
  encodeSourceId,
  requireSnapshotId,
  type ArchiveManifest,
} from "../src/shared/archive";
import {
  ARCHIVE_FORMAT_VERSION,
  DESIGN_IR_SCHEMA_VERSION,
} from "../src/shared/ir";
import { serializeCanonicalJson } from "../src/shared/serialization";

describe("archive contracts", () => {
  it("uses exact encoded opaque IDs, forward slashes, and no display names", () => {
    const snapshotId = requireSnapshotId("archive-contract");
    const sourceIds = ["12:34/56", "узел:中文", "punctuation !'()*", "%2F"];

    for (const sourceId of sourceIds) {
      const path = archivePaths.irNodeRoot(snapshotId, sourceId);
      expect(path).toBe(
        `archive-contract/ir/nodes/roots/${encodeURIComponent(sourceId)}.json`,
      );
      expect(encodeSourceId(sourceId)).toBe(encodeURIComponent(sourceId));
      expect(path).not.toContain("Invented display name");
      expect(path).not.toContain("\\");
    }
  });

  it("rejects invalid roots, traversal, malformed IDs, and invalid asset hashes", () => {
    expect(() => requireSnapshotId("../escape")).toThrow(ArchivePathError);
    expect(() => assertSafeArchivePath("archive/../manifest.json")).toThrow(
      ArchivePathError,
    );
    expect(() => assertSafeArchivePath("archive\\manifest.json")).toThrow(
      ArchivePathError,
    );
    expect(() => assertSafeArchivePath("archive/%2e%2e/manifest.json")).toThrow(
      ArchivePathError,
    );
    expect(() => assertSafeArchivePath("archive/line\nbreak.json")).toThrow(
      ArchivePathError,
    );
    expect(() => encodeSourceId("")).toThrow(ArchivePathError);
    expect(() => encodeSourceId("\ud800")).toThrow(ArchivePathError);
    expect(() =>
      archivePaths.rasterAsset(
        requireSnapshotId("archive"),
        "not-a-hash",
        "png",
      ),
    ).toThrow(ArchivePathError);
  });

  it("rejects duplicate entries before overwrite and exposes truthful manifest metadata", () => {
    const snapshotId = requireSnapshotId("archive");
    const path = archivePaths.irDocument(snapshotId);
    const registry = new ArchiveEntryRegistry();
    const mutableMetadata = {
      path,
      mediaType: "application/json",
      compression: "deflate",
      uncompressedByteLength: 128,
      contentSha256: "b".repeat(64),
    } as const;
    registry.register(mutableMetadata);
    Object.assign(mutableMetadata, {
      path: archivePaths.diagnostics(snapshotId),
      uncompressedByteLength: 777,
    });

    expect(() =>
      registry.register({
        path,
        mediaType: "application/json",
        compression: "deflate",
        uncompressedByteLength: 999,
      }),
    ).toThrow(DuplicateArchivePathError);
    expect(registry.list()).toHaveLength(1);
    expect(registry.get(path)?.uncompressedByteLength).toBe(128);

    registry.register({
      path: archivePaths.diagnostics(snapshotId),
      mediaType: "application/json",
      compression: "deflate",
      uncompressedByteLength: 64,
    });
    expect(registry.list().map((entry) => entry.path)).toEqual([
      archivePaths.diagnostics(snapshotId),
      path,
    ]);

    const manifest = {
      archiveVersion: ARCHIVE_FORMAT_VERSION,
      schemaVersion: DESIGN_IR_SCHEMA_VERSION,
      exporter: {
        packageName: "figma-design-ir",
        packageVersion: "0.1.0",
      },
      snapshotId,
      exportedAtUtc: "2026-08-13T00:00:00.000Z",
      editorType: "figma",
      document: { name: "Synthetic archive contract" },
      scope: {
        kind: "current-selection",
        orderedRootIds: ["node:z", "node:a"],
      },
      ownerConfirmedCurrent: true,
      counts: { pages: 1, roots: 2, artifacts: 2 },
      diagnosticCounts: { info: 0, warning: 0, error: 0, fatal: 0 },
      completeness: "complete",
      entries: registry.list(),
      capabilities: ["canonical-ir"],
      pluginApiLimitations: ["Synthetic contract only."],
    } as const satisfies ArchiveManifest;
    const serialized = serializeCanonicalJson(manifest);

    expect(JSON.parse(serialized)).toMatchObject({
      archiveVersion: ARCHIVE_FORMAT_VERSION,
      entries: [
        { path: archivePaths.diagnostics(snapshotId) },
        { path, uncompressedByteLength: 128 },
      ],
      ownerConfirmedCurrent: true,
      scope: { orderedRootIds: ["node:z", "node:a"] },
    });
    expect(serialized).not.toMatch(/file:\/\/|figma\.com|accessToken/i);
  });
});
