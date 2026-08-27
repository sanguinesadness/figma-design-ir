import {
  ArchiveAssemblyError,
  StreamingArchiveBuilder,
  type ArchiveAssemblyErrorCode,
  type ArchiveBuilderRuntime,
  type ArchiveCapacityLimits,
  type CompletedArchive,
} from "../shared/archive-builder";
import { requireSnapshotId } from "../shared/archive";
import { sha256Hex } from "../shared/sha256";
import type {
  ArchiveEntryAccepted,
  ArchiveEntryMessage,
  ExportCancelled,
  ExportFailed,
  ExportFailureCode,
  ExportId,
  ExportReady,
} from "../shared/protocol";

export interface ArchiveEntryAcceptanceStats {
  readonly acceptedEntryCount: number;
  readonly retainedZipByteLength: number;
}

export interface ExportSessionCallbacks {
  readonly onEntryAccepted: (
    message: ArchiveEntryAccepted,
    stats: ArchiveEntryAcceptanceStats,
  ) => void;
  readonly onArchiveFinalized: (archive: CompletedArchive) => void;
  readonly onArchiveAssemblyFailed: (exportId: ExportId) => void;
  readonly onCancelled: (exportId: ExportId) => void;
  readonly onFailed: (
    exportId: ExportId,
    code: ExportFailureCode,
    archiveCode?: ArchiveAssemblyErrorCode,
  ) => void;
}

export function matchesPendingExportRequest(
  pendingRequestId: string | null,
  responseRequestId: string,
): boolean {
  return pendingRequestId !== null && pendingRequestId === responseRequestId;
}

interface ActiveUiExport {
  readonly exportId: ExportId;
  readonly builder: StreamingArchiveBuilder;
  queue: Promise<void>;
  nextEntrySequence: number;
  entryInFlight: boolean;
  readyReceived: boolean;
}

export function createBrowserArchiveRuntime(): ArchiveBuilderRuntime {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  return {
    encodeUtf8: (text) => encoder.encode(text),
    decodeUtf8: (bytes) => decoder.decode(bytes),
    sha256: (bytes) => Promise.resolve(sha256Hex(bytes)),
  };
}

export function requestArchiveSave(archive: CompletedArchive): void {
  const blob = new Blob(
    archive.chunks.map(
      (chunk) =>
        new Uint8Array(
          chunk.buffer as ArrayBuffer,
          chunk.byteOffset,
          chunk.byteLength,
        ),
    ),
    { type: "application/zip" },
  );
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = archive.filename;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
}

export function formatSaveHandoffMessage(archive: CompletedArchive): string {
  return `Archive assembled (${archive.manifest.completeness}). Local saving was requested for ${archive.filename}. Figma Desktop controls the system save flow; this plugin cannot confirm whether the file was saved or cancelled. Review diagnostics.json after saving.`;
}

export class ExportSessionController {
  readonly #runtime: ArchiveBuilderRuntime;
  readonly #callbacks: ExportSessionCallbacks;
  readonly #capacityLimits: ArchiveCapacityLimits | undefined;
  #active: ActiveUiExport | null = null;

  constructor(
    runtime: ArchiveBuilderRuntime,
    callbacks: ExportSessionCallbacks,
    capacityLimits?: ArchiveCapacityLimits,
  ) {
    this.#runtime = runtime;
    this.#callbacks = callbacks;
    this.#capacityLimits = capacityLimits;
  }

  get activeExportId(): ExportId | null {
    return this.#active?.exportId ?? null;
  }

  start(exportId: ExportId, snapshotId: string): void {
    if (this.#active !== null) {
      return;
    }
    const builder =
      this.#capacityLimits === undefined
        ? new StreamingArchiveBuilder(
            requireSnapshotId(snapshotId),
            this.#runtime,
          )
        : new StreamingArchiveBuilder(
            requireSnapshotId(snapshotId),
            this.#runtime,
            this.#capacityLimits,
          );
    this.#active = {
      exportId,
      builder,
      queue: Promise.resolve(),
      nextEntrySequence: 1,
      entryInFlight: false,
      readyReceived: false,
    };
  }

  #failAssembly(
    active: ActiveUiExport,
    archiveCode?: ArchiveAssemblyErrorCode,
  ): void {
    if (this.#active !== active) {
      return;
    }
    active.builder.cancel();
    this.#active = null;
    this.#callbacks.onArchiveAssemblyFailed(active.exportId);
    const failureCode: ExportFailureCode =
      archiveCode === "archive-capacity-exceeded" ||
      archiveCode === "archive-entry-limit-exceeded"
        ? archiveCode
        : "archive-failed";
    this.#callbacks.onFailed(active.exportId, failureCode, archiveCode);
  }

  #enqueue(
    exportId: ExportId,
    operation: (active: ActiveUiExport) => Promise<void>,
  ): void {
    const active = this.#active;
    if (active === null || active.exportId !== exportId) {
      return;
    }
    active.queue = active.queue
      .then(async () => {
        if (this.#active !== active) {
          return;
        }
        await operation(active);
      })
      .catch((error: unknown) => {
        if (this.#active !== active) {
          return;
        }
        this.#failAssembly(
          active,
          error instanceof ArchiveAssemblyError ? error.code : undefined,
        );
      });
  }

  acceptEntry(message: ArchiveEntryMessage): void {
    const active = this.#active;
    if (active === null || active.exportId !== message.exportId) {
      return;
    }
    if (
      active.entryInFlight ||
      active.readyReceived ||
      message.sequence !== active.nextEntrySequence
    ) {
      this.#failAssembly(active, "invalid-entry");
      return;
    }
    active.entryInFlight = true;
    this.#enqueue(message.exportId, async (active) => {
      await active.builder.addEntry({
        metadata: {
          path: message.path,
          mediaType: message.mediaType,
          compression: message.compression,
          uncompressedByteLength: 0,
        },
        data: message.data,
      });
      if (this.#active !== active) {
        return;
      }
      active.entryInFlight = false;
      active.nextEntrySequence += 1;
      this.#callbacks.onEntryAccepted(
        {
          type: "archive-entry-accepted",
          protocolVersion: message.protocolVersion,
          exportId: message.exportId,
          sequence: message.sequence,
        },
        {
          acceptedEntryCount: active.builder.acceptedEntryCount,
          retainedZipByteLength: active.builder.retainedZipByteLength,
        },
      );
    });
  }

  acceptReady(message: ExportReady): void {
    const active = this.#active;
    if (active === null || active.exportId !== message.exportId) {
      return;
    }
    if (active.entryInFlight || active.readyReceived) {
      this.#failAssembly(active, "invalid-entry");
      return;
    }
    active.readyReceived = true;
    this.#enqueue(message.exportId, async (active) => {
      const archive = await active.builder.finalize(
        message.manifestDraft,
        message.artifacts,
      );
      if (this.#active !== active) {
        return;
      }
      this.#callbacks.onArchiveFinalized(archive);
      this.#active = null;
    });
  }

  acceptCancelled(message: ExportCancelled): void {
    if (this.#active?.exportId !== message.exportId) {
      return;
    }
    const active = this.#active;
    this.#active = null;
    active.builder.cancel();
    this.#callbacks.onCancelled(message.exportId);
  }

  acceptFailed(message: ExportFailed): void {
    if (this.#active?.exportId !== message.exportId) {
      return;
    }
    const active = this.#active;
    this.#active = null;
    active.builder.cancel();
    this.#callbacks.onFailed(message.exportId, message.safeError.code);
  }

  cancelActive(): ExportId | null {
    const active = this.#active;
    if (active === null) {
      return null;
    }
    this.#active = null;
    active.builder.cancel();
    this.#callbacks.onCancelled(active.exportId);
    return active.exportId;
  }
}
