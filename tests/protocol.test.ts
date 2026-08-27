import { describe, expect, it } from "vitest";

import {
  PROTOCOL_VERSION,
  parseMainToUiMessage,
  parseUiToMainMessage,
} from "../src/shared/protocol";
import {
  ARCHIVE_FORMAT_VERSION,
  DESIGN_IR_SCHEMA_VERSION,
} from "../src/shared/ir";
import { matchesPendingExportRequest } from "../src/ui/export-session";

describe("UI to main protocol validation", () => {
  it("accepts exact initialization and ping messages", () => {
    expect(
      parseUiToMainMessage({
        type: "initialize-request",
        protocolVersion: PROTOCOL_VERSION,
      }),
    ).toEqual({
      type: "initialize-request",
      protocolVersion: PROTOCOL_VERSION,
    });

    expect(
      parseUiToMainMessage({
        type: "ping-request",
        protocolVersion: PROTOCOL_VERSION,
        requestId: "ping-1",
      }),
    ).toEqual({
      type: "ping-request",
      protocolVersion: PROTOCOL_VERSION,
      requestId: "ping-1",
    });
  });

  it("rejects unknown versions, unsafe IDs, and extra fields", () => {
    expect(
      parseUiToMainMessage({
        type: "initialize-request",
        protocolVersion: PROTOCOL_VERSION + 1,
      }),
    ).toBeNull();
    expect(
      parseUiToMainMessage({
        type: "ping-request",
        protocolVersion: PROTOCOL_VERSION,
        requestId: "private value",
      }),
    ).toBeNull();
    expect(
      parseUiToMainMessage({
        type: "initialize-request",
        protocolVersion: PROTOCOL_VERSION,
        unexpected: true,
      }),
    ).toBeNull();
  });
});

describe("main to UI protocol validation", () => {
  it("accepts synthetic initialization metadata and pong messages", () => {
    expect(
      parseMainToUiMessage({
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
      }),
    ).toEqual({
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

    expect(
      parseMainToUiMessage({
        type: "pong-result",
        protocolVersion: PROTOCOL_VERSION,
        requestId: "ping-1",
      }),
    ).not.toBeNull();
  });

  it("rejects invalid counts and unsupported capabilities", () => {
    expect(
      parseMainToUiMessage({
        type: "initialize-result",
        protocolVersion: PROTOCOL_VERSION,
        document: {
          name: "Synthetic Shell Fixture",
          pageCount: -1,
          selectionCount: 0,
        },
        capabilities: {
          exportAvailable: true,
          supportedScopes: ["current-selection", "entire-file"],
        },
        runtime: {
          editorType: "figma",
          pluginId: "1234567890",
        },
      }),
    ).toBeNull();

    expect(
      parseMainToUiMessage({
        type: "initialize-result",
        protocolVersion: PROTOCOL_VERSION,
        document: {
          name: "Synthetic Shell Fixture",
          pageCount: 1,
          selectionCount: 0,
        },
        capabilities: {
          exportAvailable: true,
          supportedScopes: ["entire-file", "current-selection"],
        },
        runtime: {
          editorType: "figma",
          pluginId: "1234567890",
        },
      }),
    ).toBeNull();

    expect(
      parseMainToUiMessage({
        type: "initialize-result",
        protocolVersion: PROTOCOL_VERSION,
        document: {
          name: "Synthetic Shell Fixture",
          pageCount: 1,
          selectionCount: 0,
        },
        capabilities: {
          exportAvailable: true,
          supportedScopes: ["current-selection", "entire-file"],
        },
        runtime: {
          editorType: "figjam",
          pluginId: "1234567890",
        },
      }),
    ).toBeNull();
  });

  it("validates both export scopes and strict archive messages while retaining request and export IDs for stale rejection", () => {
    const activeExportId = "export-000002";
    const staleExportId = "export-000001";
    const pendingRequestId = "export-request-2";
    const staleRequestId = "export-request-1";
    const snapshotId = "archive-protocol";
    const documentPath = `${snapshotId}/ir/document.json`;
    const validStart = {
      type: "start-export",
      protocolVersion: PROTOCOL_VERSION,
      requestId: pendingRequestId,
      snapshotId,
      scope: "current-selection",
      ownerConfirmedCurrent: true,
    } as const;

    expect(parseUiToMainMessage(validStart)).toEqual(validStart);
    expect(
      parseUiToMainMessage({ ...validStart, ownerConfirmedCurrent: false }),
    ).toBeNull();
    expect(
      parseUiToMainMessage({ ...validStart, scope: "entire-file" }),
    ).toEqual({ ...validStart, scope: "entire-file" });
    expect(
      parseUiToMainMessage({ ...validStart, scope: "visible-pages" }),
    ).toBeNull();
    expect(
      parseUiToMainMessage({ ...validStart, requestId: "private value" }),
    ).toBeNull();
    expect(
      parseUiToMainMessage({ ...validStart, unexpected: true }),
    ).toBeNull();

    const acceptedEntry = {
      type: "archive-entry-accepted",
      protocolVersion: PROTOCOL_VERSION,
      exportId: activeExportId,
      sequence: 1,
    } as const;
    expect(parseUiToMainMessage(acceptedEntry)).toEqual(acceptedEntry);
    expect(parseUiToMainMessage({ ...acceptedEntry, sequence: 0 })).toBeNull();
    expect(
      parseUiToMainMessage({ ...acceptedEntry, sequence: 1.5 }),
    ).toBeNull();
    expect(
      parseUiToMainMessage({ ...acceptedEntry, path: documentPath }),
    ).toBeNull();

    const activeEntry = {
      type: "archive-entry",
      protocolVersion: PROTOCOL_VERSION,
      exportId: activeExportId,
      sequence: 1,
      path: documentPath,
      mediaType: "application/json",
      compression: "deflate",
      data: "{}\n",
    } as const;
    expect(parseMainToUiMessage(activeEntry)).toEqual(activeEntry);
    expect(
      parseMainToUiMessage({ ...activeEntry, path: "../document.json" }),
    ).toBeNull();
    expect(
      parseMainToUiMessage({ ...activeEntry, unexpected: true }),
    ).toBeNull();
    expect(
      parseMainToUiMessage({ ...activeEntry, exportId: "export-old" }),
    ).toBeNull();
    expect(parseMainToUiMessage({ ...activeEntry, sequence: 0 })).toBeNull();

    const ready = parseMainToUiMessage({
      type: "export-ready",
      protocolVersion: PROTOCOL_VERSION,
      exportId: activeExportId,
      manifestDraft: {
        archiveVersion: ARCHIVE_FORMAT_VERSION,
        schemaVersion: DESIGN_IR_SCHEMA_VERSION,
        exporter: {
          packageName: "figma-design-ir",
          packageVersion: "0.1.0",
        },
        snapshotId,
        exportedAtUtc: "2026-08-13T12:00:00.000Z",
        editorType: "figma",
        document: { name: "Synthetic Protocol Fixture" },
        scope: {
          kind: "current-selection",
          orderedRootIds: ["node:alpha"],
        },
        ownerConfirmedCurrent: true,
        counts: { pages: 1, roots: 1, artifacts: 1 },
        diagnosticCounts: { info: 0, warning: 0, error: 0, fatal: 0 },
        completeness: "complete",
        capabilities: ["current-selection"],
        pluginApiLimitations: [],
      },
      artifacts: [{ path: documentPath, status: "emitted" }],
    });
    expect(ready).not.toBeNull();
    expect(
      parseMainToUiMessage({
        type: "export-ready",
        protocolVersion: PROTOCOL_VERSION,
        exportId: activeExportId,
        manifestDraft: {
          archiveVersion: ARCHIVE_FORMAT_VERSION,
          schemaVersion: DESIGN_IR_SCHEMA_VERSION,
          exporter: {
            packageName: "figma-design-ir",
            packageVersion: "0.1.0",
          },
          snapshotId,
          exportedAtUtc: "2026-08-13T12:00:00.000Z",
          editorType: "figma",
          document: { name: "Synthetic Protocol Fixture" },
          scope: {
            kind: "entire-file",
            orderedRootIds: ["node:alpha", "node:beta"],
          },
          ownerConfirmedCurrent: true,
          counts: { pages: 2, roots: 2, artifacts: 1 },
          diagnosticCounts: { info: 0, warning: 0, error: 0, fatal: 0 },
          completeness: "complete",
          capabilities: ["entire-file"],
          pluginApiLimitations: [],
        },
        artifacts: [{ path: documentPath, status: "emitted" }],
      }),
    ).not.toBeNull();

    const activeStarted = parseMainToUiMessage({
      type: "export-started",
      protocolVersion: PROTOCOL_VERSION,
      requestId: pendingRequestId,
      exportId: activeExportId,
      scopeSummary: { kind: "current-selection", rootCount: 1 },
    });
    expect(activeStarted).toMatchObject({
      requestId: pendingRequestId,
      exportId: activeExportId,
    });
    expect(
      parseMainToUiMessage({
        type: "export-started",
        protocolVersion: PROTOCOL_VERSION,
        requestId: pendingRequestId,
        exportId: activeExportId,
        scopeSummary: { kind: "entire-file", pageCount: 2 },
      }),
    ).toMatchObject({
      scopeSummary: { kind: "entire-file", pageCount: 2 },
    });
    const pageLoadProgress = {
      type: "progress",
      protocolVersion: PROTOCOL_VERSION,
      exportId: activeExportId,
      phase: "page-loading",
      completed: 1,
      total: 2,
      currentLabel: "Page 2 of 2",
      durationMs: 12.5,
    } as const;
    expect(parseMainToUiMessage(pageLoadProgress)).toEqual(pageLoadProgress);
    expect(
      parseMainToUiMessage({ ...pageLoadProgress, durationMs: -1 }),
    ).toBeNull();
    expect(
      parseMainToUiMessage({ ...pageLoadProgress, completed: 3 }),
    ).toBeNull();

    const staleFailure = parseMainToUiMessage({
      type: "export-failed",
      protocolVersion: PROTOCOL_VERSION,
      requestId: staleRequestId,
      exportId: staleExportId,
      safeError: { code: "collection-failed" },
    });
    expect(staleFailure).toMatchObject({
      requestId: staleRequestId,
      exportId: staleExportId,
    });
    for (const code of [
      "archive-capacity-exceeded",
      "archive-entry-limit-exceeded",
    ] as const) {
      expect(
        parseMainToUiMessage({
          type: "export-failed",
          protocolVersion: PROTOCOL_VERSION,
          requestId: pendingRequestId,
          exportId: activeExportId,
          safeError: { code },
        }),
      ).toMatchObject({ safeError: { code } });
    }
    expect(
      staleFailure !== null &&
        staleFailure.type === "export-failed" &&
        matchesPendingExportRequest(pendingRequestId, staleFailure.requestId),
    ).toBe(false);
    expect(
      matchesPendingExportRequest(pendingRequestId, pendingRequestId),
    ).toBe(true);

    const staleEntry = parseMainToUiMessage({
      ...activeEntry,
      exportId: staleExportId,
    });
    expect(staleEntry).toMatchObject({ exportId: staleExportId });
    expect(
      staleEntry !== null &&
        "exportId" in staleEntry &&
        staleEntry.exportId === activeExportId,
    ).toBe(false);
  });
});
