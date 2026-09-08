import { normalizeSafeTechnicalCause } from "../shared/diagnostics";
import {
  ARCHIVE_MAX_PRE_MANIFEST_ENTRY_COUNT,
  ArchiveProducerSafetyError,
  type ArchiveProducerSafetyErrorCode,
} from "../shared/archive";
import {
  PROTOCOL_VERSION,
  parseUiToMainMessage,
  type ArchiveEntryAccepted,
  type ExportComponentScope,
  type ExportFailed,
  type ExportId,
  type ExportProducerMessage,
  type ExportScope,
  type InitializeResult,
  type MainToUiMessage,
} from "../shared/protocol";
import { assertArchiveEntryFits } from "./archive-entry-preflight";
import { ExportCancellationToken, ExportCancelledError } from "./cancellation";
import {
  classifyEntireFileExportFailure,
  runEntireFileExport,
} from "./export-entire-file";
import {
  classifySelectionExportFailure,
  runSelectionExport,
} from "./export-selection";

figma.showUI(__html__, {
  width: 380,
  height: 600,
  title: "Figma Design IR",
  themeColors: true,
});

interface ActiveExport {
  readonly exportId: ExportId;
  readonly requestId: string;
  readonly cancellation: ExportCancellationToken;
  readonly delivery: ExportUiDelivery;
}

interface PendingArchiveEntry {
  readonly sequence: number;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

class ArchiveEntryDeliveryError extends Error {
  constructor() {
    super("Archive entry delivery acknowledgement failed.");
    this.name = "ArchiveEntryDeliveryError";
  }
}

type ExportUiDeliveryFailure =
  ArchiveEntryDeliveryError | ArchiveProducerSafetyError;

class ExportUiDelivery {
  readonly #exportId: ExportId;
  readonly #cancellation: ExportCancellationToken;
  readonly #postMessage: (message: MainToUiMessage) => boolean;
  #expectedSequence = 1;
  #pending: PendingArchiveEntry | null = null;
  #failure: ExportUiDeliveryFailure | null = null;
  #entryPreflightActive = false;
  #readyPosted = false;
  #closed = false;

  constructor(
    exportId: ExportId,
    cancellation: ExportCancellationToken,
    postMessage: (message: MainToUiMessage) => boolean,
  ) {
    this.#exportId = exportId;
    this.#cancellation = cancellation;
    this.#postMessage = postMessage;
  }

  get failure(): ExportUiDeliveryFailure | null {
    return this.#failure;
  }

  #fail(
    requestedFailure: ExportUiDeliveryFailure = new ArchiveEntryDeliveryError(),
  ): ExportUiDeliveryFailure {
    const failure = this.#failure ?? requestedFailure;
    this.#failure = failure;
    this.#entryPreflightActive = false;
    const pending = this.#pending;
    this.#pending = null;
    pending?.reject(failure);
    return failure;
  }

  #failProducerSafety(
    code: ArchiveProducerSafetyErrorCode,
  ): ExportUiDeliveryFailure {
    this.#cancellation.cancel();
    this.#closed = true;
    return this.#fail(new ArchiveProducerSafetyError(code));
  }

  #throwIfPreflightStopped(): void {
    if (this.#failure !== null) {
      throw this.#failure;
    }
    if (this.#closed) {
      throw new ExportCancelledError();
    }
    this.#cancellation.throwIfCancelled();
  }

  async #preflightAndPostEntry(
    message: Extract<ExportProducerMessage, { readonly type: "archive-entry" }>,
  ): Promise<void> {
    try {
      this.#throwIfPreflightStopped();
      if (this.#expectedSequence > ARCHIVE_MAX_PRE_MANIFEST_ENTRY_COUNT) {
        throw this.#failProducerSafety("archive-entry-limit-exceeded");
      }
      try {
        await assertArchiveEntryFits(message.data, {
          checkpoint: () => this.#throwIfPreflightStopped(),
        });
      } catch (error) {
        if (
          error instanceof ArchiveProducerSafetyError &&
          error.code === "archive-capacity-exceeded"
        ) {
          throw this.#failProducerSafety(error.code);
        }
        throw error;
      }
      this.#throwIfPreflightStopped();

      const sequence = this.#expectedSequence;
      const outgoingMessage: MainToUiMessage = { ...message, sequence };
      const acknowledged = new Promise<void>((resolve, reject) => {
        this.#pending = {
          sequence,
          resolve,
          reject,
        };
      });
      void acknowledged.catch(() => undefined);
      this.#entryPreflightActive = false;
      if (!this.#postMessage(outgoingMessage)) {
        this.cancel();
        throw new ExportCancelledError();
      }
      return acknowledged;
    } finally {
      this.#entryPreflightActive = false;
    }
  }

  post(message: ExportProducerMessage): void | Promise<void> {
    if (this.#failure !== null) {
      throw this.#failure;
    }
    if (this.#closed) {
      throw new ExportCancelledError();
    }
    if ("exportId" in message && message.exportId !== this.#exportId) {
      throw this.#fail();
    }
    if (this.#readyPosted) {
      throw this.#fail();
    }

    if (message.type === "archive-entry") {
      if (this.#entryPreflightActive || this.#pending !== null) {
        throw this.#fail();
      }
      this.#entryPreflightActive = true;
      const delivery = this.#preflightAndPostEntry(message);
      void delivery.catch(() => undefined);
      return delivery;
    }

    if (message.type === "export-ready") {
      if (this.#entryPreflightActive || this.#pending !== null) {
        throw this.#fail();
      }
      this.#readyPosted = true;
    }
    if (!this.#postMessage(message)) {
      this.cancel();
      throw new ExportCancelledError();
    }
  }

  accept(message: ArchiveEntryAccepted): boolean {
    if (this.#closed || this.#failure !== null) {
      return true;
    }
    const pending = this.#pending;
    if (
      message.exportId !== this.#exportId ||
      pending === null ||
      message.sequence !== pending.sequence ||
      message.sequence !== this.#expectedSequence
    ) {
      this.#fail();
      return false;
    }
    this.#pending = null;
    this.#expectedSequence += 1;
    pending.resolve();
    return true;
  }

  cancel(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#entryPreflightActive = false;
    const pending = this.#pending;
    this.#pending = null;
    pending?.reject(new ExportCancelledError());
  }
}

let exportSequence = 0;
let activeExport: ActiveExport | null = null;
let pluginClosing = false;

function nextExportId(): ExportId {
  exportSequence += 1;
  return `export-${String(exportSequence).padStart(6, "0")}`;
}

function postToUi(message: MainToUiMessage): boolean {
  if (pluginClosing) {
    return false;
  }
  try {
    figma.ui.postMessage(message);
    return true;
  } catch {
    return false;
  }
}

function sendInitialization(): void {
  if (pluginClosing) {
    return;
  }
  if (figma.editorType !== "figma" || figma.pluginId === undefined) {
    figma.closePlugin("Figma Design IR requires Figma Design.");
    return;
  }

  const message: InitializeResult = {
    type: "initialize-result",
    protocolVersion: PROTOCOL_VERSION,
    document: {
      name: figma.root.name,
      pageCount: figma.root.children.length,
      selectionCount: figma.currentPage.selection.length,
    },
    capabilities: {
      exportAvailable: true,
      supportedScopes: ["current-selection", "entire-file"],
    },
    runtime: {
      editorType: figma.editorType,
      pluginId: figma.pluginId,
    },
  };

  postToUi(message);
}

function postFailure(
  exportId: ExportId,
  requestId: string,
  code: ExportFailed["safeError"]["code"],
  error?: unknown,
): void {
  postToUi({
    type: "export-failed",
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    exportId,
    safeError: {
      code,
      ...(error === undefined
        ? {}
        : { technicalCause: normalizeSafeTechnicalCause(error, "unknown") }),
    },
  });
}

function startExport(
  snapshotId: string,
  requestId: string,
  scope: ExportScope,
  componentScope?: ExportComponentScope,
): void {
  const exportId = nextExportId();
  if (pluginClosing) {
    return;
  }
  if (activeExport !== null) {
    postFailure(exportId, requestId, "export-in-progress");
    return;
  }

  const cancellation = new ExportCancellationToken();
  const delivery = new ExportUiDelivery(exportId, cancellation, postToUi);
  const operation: ActiveExport = {
    exportId,
    requestId,
    cancellation,
    delivery,
  };
  activeExport = operation;
  const runExport =
    scope === "entire-file" ? runEntireFileExport : runSelectionExport;
  void runExport({
    exportId,
    requestId,
    snapshotId,
    cancellation,
    ...(scope === "current-selection" && componentScope !== undefined
      ? { componentScope }
      : {}),
    postMessage: (message) => delivery.post(message),
  })
    .then(() => {
      if (delivery.failure !== null) {
        throw delivery.failure;
      }
      cancellation.throwIfCancelled();
    })
    .catch((error: unknown) => {
      const deliveryFailure = delivery.failure;
      if (deliveryFailure instanceof ArchiveProducerSafetyError) {
        cancellation.cancel();
        postFailure(exportId, requestId, deliveryFailure.code, deliveryFailure);
        return;
      }
      if (deliveryFailure !== null) {
        cancellation.cancel();
        postFailure(exportId, requestId, "archive-failed", deliveryFailure);
        return;
      }
      if (error instanceof ExportCancelledError || cancellation.cancelled) {
        postToUi({
          type: "export-cancelled",
          protocolVersion: PROTOCOL_VERSION,
          exportId,
        });
        return;
      }
      postFailure(
        exportId,
        requestId,
        scope === "entire-file"
          ? classifyEntireFileExportFailure(error)
          : classifySelectionExportFailure(error),
        error,
      );
    })
    .finally(() => {
      delivery.cancel();
      if (activeExport === operation) {
        activeExport = null;
      }
    });
}

figma.ui.onmessage = (rawMessage: unknown): void => {
  const message = parseUiToMainMessage(rawMessage);
  if (message === null) {
    return;
  }

  switch (message.type) {
    case "initialize-request":
      sendInitialization();
      break;
    case "ping-request":
      postToUi({
        type: "pong-result",
        protocolVersion: PROTOCOL_VERSION,
        requestId: message.requestId,
      });
      break;
    case "start-export":
      startExport(
        message.snapshotId,
        message.requestId,
        message.scope,
        message.componentScope,
      );
      break;
    case "cancel-export":
      if (activeExport?.exportId === message.exportId) {
        activeExport.cancellation.cancel();
        activeExport.delivery.cancel();
      }
      break;
    case "archive-entry-accepted":
      if (activeExport?.exportId === message.exportId) {
        if (!activeExport.delivery.accept(message)) {
          activeExport.cancellation.cancel();
        }
      }
      break;
  }
};

figma.on("selectionchange", sendInitialization);
figma.on("close", () => {
  pluginClosing = true;
  activeExport?.cancellation.cancel();
  activeExport?.delivery.cancel();
  activeExport = null;
});
