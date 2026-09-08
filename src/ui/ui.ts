import {
  ARCHIVE_TOTAL_LIVE_BYTE_LIMIT,
  parseSnapshotId,
} from "../shared/archive";
import {
  PROTOCOL_VERSION,
  parseMainToUiMessage,
  type ExportComponentScope,
  type ExportFailureCode,
  type ExportId,
  type ExportScope,
  type UiToMainMessage,
} from "../shared/protocol";
import {
  createBrowserArchiveRuntime,
  ExportSessionController,
  formatSaveHandoffMessage,
  matchesPendingExportRequest,
  requestArchiveSave,
} from "./export-session";

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`Missing required UI element: ${id}`);
  }
  return element as T;
}

const exportForm = requireElement<HTMLFormElement>("export-form");
const documentName = requireElement<HTMLElement>("document-name");
const pageCount = requireElement<HTMLElement>("page-count");
const selectionCountElement = requireElement<HTMLElement>("selection-count");
const snapshotInput = requireElement<HTMLInputElement>("snapshot-id");
const ownerConfirmation =
  requireElement<HTMLInputElement>("owner-confirmation");
const exportButton = requireElement<HTMLButtonElement>("export-button");
const cancelButton = requireElement<HTMLButtonElement>("cancel-button");
const validationMessage = requireElement<HTMLElement>("validation-message");
const progressPanel = requireElement<HTMLElement>("progress-panel");
const progressTitle = requireElement<HTMLElement>("progress-title");
const progressCount = requireElement<HTMLElement>("progress-count");
const progressBar = requireElement<HTMLProgressElement>("progress-bar");
const progressItem = requireElement<HTMLElement>("progress-item");
const archiveStats = requireElement<HTMLElement>("archive-stats");
const diagnosticSummary = requireElement<HTMLElement>("diagnostic-summary");
const statusPanel = requireElement<HTMLElement>("status-panel");
const statusBadge = requireElement<HTMLElement>("status-badge");
const resultMessage = requireElement<HTMLElement>("result-message");
const connectionStatus = requireElement<HTMLElement>("connection-status");
const scopeInputs = [
  ...exportForm.querySelectorAll<HTMLInputElement>('input[name="scope"]'),
];
const componentScopeInputs = [
  ...exportForm.querySelectorAll<HTMLInputElement>(
    'input[name="componentScope"]',
  ),
];

function defaultSnapshotId(now = new Date()): string {
  const compactUtc = now
    .toISOString()
    .replaceAll(/[-:.]/g, "")
    .replace("T", "t")
    .replace(/\d{3}Z$/, "z");
  return `snapshot-${compactUtc}`;
}

function postToMain(message: UiToMainMessage): void {
  parent.postMessage({ pluginMessage: message }, "*");
}

function failureMessage(code: ExportFailureCode): string {
  switch (code) {
    case "export-in-progress":
      return "Another export is already in progress.";
    case "invalid-request":
      return "The export request was rejected. Review the form and try again.";
    case "scope-empty":
      return "Select at least one layer on the current page.";
    case "scope-invalid":
      return "The selected scope changed before it could be exported.";
    case "collection-failed":
      return "The local collector stopped before an archive could be completed.";
    case "archive-capacity-exceeded":
      return "Archive export stopped safely (archive-capacity-exceeded): the local archive capacity was reached. No local saving was requested.";
    case "archive-entry-limit-exceeded":
      return "Archive export stopped safely (archive-entry-limit-exceeded): the classic ZIP entry limit was reached. No local saving was requested.";
    case "archive-failed":
      return "Archive assembly failed locally. No local saving was requested.";
  }
}

type StatusState =
  | "connecting"
  | "ready"
  | "working"
  | "complete"
  | "warning"
  | "cancelled"
  | "error";

const defaultStatusLabels: Readonly<Record<StatusState, string>> = {
  connecting: "Starting",
  ready: "Ready",
  working: "Working",
  complete: "Save requested",
  warning: "Review diagnostics",
  cancelled: "Cancelled",
  error: "Export stopped",
};

function setStatus(
  state: StatusState,
  text: string,
  badge = defaultStatusLabels[state],
): void {
  statusPanel.dataset.state = state;
  statusBadge.textContent = badge;
  resultMessage.textContent = text;
}

function formatMebibytes(byteLength: number): string {
  return `${(byteLength / (1024 * 1024)).toFixed(1)} MiB`;
}

function setArchiveStats(
  acceptedEntryCount: number,
  retainedZipByteLength: number,
): void {
  archiveStats.textContent = `Local ZIP buffer: ${acceptedEntryCount} accepted entries; ${formatMebibytes(retainedZipByteLength)} of ${formatMebibytes(ARCHIVE_TOTAL_LIVE_BYTE_LIMIT)} retained-byte limit.`;
}

let initialized = false;
let selectionCount = 0;
let supportedScopes: readonly ExportScope[] = [];
let pendingSnapshotId: string | null = null;
let pendingRequestId: string | null = null;
let pendingScope: ExportScope | null = null;
let activeExportId: ExportId | null = null;
let pingSequence = 0;
let exportRequestSequence = 0;

const session = new ExportSessionController(createBrowserArchiveRuntime(), {
  onEntryAccepted: (message, stats) => {
    setArchiveStats(stats.acceptedEntryCount, stats.retainedZipByteLength);
    postToMain(message);
  },
  onArchiveFinalized: (archive) => {
    requestArchiveSave(archive);
    activeExportId = null;
    pendingScope = null;
    progressPanel.hidden = true;
    setBusy(false);
    const { counts, completeness } = archive.manifest.diagnosticCounts
      ? {
          counts: archive.manifest.diagnosticCounts,
          completeness: archive.manifest.completeness,
        }
      : {
          counts: { info: 0, warning: 0, error: 0, fatal: 0 },
          completeness: "complete" as const,
        };
    diagnosticSummary.textContent = `${completeness}; ${counts.warning} warning(s), ${counts.error} error(s), ${counts.fatal} fatal error(s).`;
    progressTitle.textContent = "Archive assembled";
    progressBar.max = 1;
    progressBar.value = 1;
    progressCount.textContent = "1 / 1";
    progressItem.textContent = "Local saving requested";
    const finalZipByteLength = archive.chunks.reduce(
      (total, chunk) => total + chunk.byteLength,
      0,
    );
    archiveStats.textContent = `Final local ZIP: ${archive.manifest.entries.length + 1} entries; ${formatMebibytes(finalZipByteLength)}.`;
    progressPanel.hidden = false;
    setStatus(
      completeness === "complete" ? "complete" : "warning",
      formatSaveHandoffMessage(archive),
    );
  },
  onArchiveAssemblyFailed: (exportId) => {
    postToMain({
      type: "cancel-export",
      protocolVersion: PROTOCOL_VERSION,
      exportId,
    });
  },
  onCancelled: () => {
    activeExportId = null;
    pendingScope = null;
    progressPanel.hidden = true;
    setBusy(false);
    setStatus("cancelled", "Export cancelled. No local saving was requested.");
  },
  onFailed: (_exportId, code, archiveCode) => {
    activeExportId = null;
    pendingSnapshotId = null;
    pendingRequestId = null;
    pendingScope = null;
    progressPanel.hidden =
      archiveCode === undefined &&
      code !== "archive-capacity-exceeded" &&
      code !== "archive-entry-limit-exceeded";
    setBusy(false);
    setArchiveStats(0, 0);
    const detail =
      archiveCode === undefined || archiveCode === code
        ? ""
        : ` (${archiveCode})`;
    setStatus("error", `${failureMessage(code)}${detail}`);
  },
});

function setBusy(busy: boolean): void {
  const selectedScope = readSelectedScope();
  exportForm.querySelectorAll<HTMLInputElement>("input").forEach((input) => {
    input.disabled =
      busy ||
      (input.name === "scope" &&
        !supportedScopes.includes(input.value as ExportScope)) ||
      (input.name === "componentScope" &&
        selectedScope !== "current-selection");
  });
  exportButton.disabled = busy || !initialized;
  cancelButton.hidden = !busy || activeExportId === null;
}

function showValidation(message: string): void {
  validationMessage.textContent = message;
  validationMessage.hidden = false;
}

function clearValidation(): void {
  validationMessage.textContent = "";
  validationMessage.hidden = true;
}

function readSelectedScope(): ExportScope | null {
  const selected = scopeInputs.find((input) => input.checked)?.value;
  return selected === "current-selection" || selected === "entire-file"
    ? selected
    : null;
}

function readSelectedComponentScope(): ExportComponentScope {
  const selected = componentScopeInputs.find((input) => input.checked)?.value;
  return selected === "reachable" ? "reachable" : "used";
}

function beginPendingExport(snapshotId: string, scope: ExportScope): void {
  exportRequestSequence += 1;
  const requestId = `export-request-${exportRequestSequence}`;
  pendingSnapshotId = snapshotId;
  pendingRequestId = requestId;
  pendingScope = scope;
  // Component scope only affects current-selection exports; the UI control
  // is disabled for entire-file runs, so its value is not sent there.
  const componentScope =
    scope === "current-selection" ? readSelectedComponentScope() : undefined;
  clearValidation();
  setBusy(true);
  progressPanel.hidden = false;
  progressTitle.textContent =
    scope === "entire-file"
      ? "Validating entire-file scope…"
      : "Validating selection…";
  progressCount.textContent = "";
  progressBar.removeAttribute("value");
  progressItem.textContent = "";
  setArchiveStats(0, 0);
  diagnosticSummary.textContent = "";
  setStatus(
    "working",
    scope === "entire-file"
      ? "Preparing a local entire-file export."
      : "Preparing a local current-selection export.",
    "Preparing",
  );
  postToMain({
    type: "start-export",
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    snapshotId,
    scope,
    ...(componentScope === undefined ? {} : { componentScope }),
    ownerConfirmedCurrent: true,
  });
}

exportForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (pendingSnapshotId !== null || activeExportId !== null) {
    return;
  }
  const snapshotId = snapshotInput.value.trim();
  const scope = readSelectedScope();
  if (parseSnapshotId(snapshotId) === null) {
    showValidation(
      "Snapshot ID must start with a lowercase letter or number and contain only lowercase letters, numbers, dots, dashes, or underscores.",
    );
    snapshotInput.focus();
    return;
  }
  if (scope === null || !supportedScopes.includes(scope)) {
    showValidation("Choose an available export scope.");
    return;
  }
  if (scope === "current-selection" && selectionCount === 0) {
    showValidation("Select at least one layer on the current page.");
    return;
  }
  if (!ownerConfirmation.checked) {
    showValidation(
      "Confirm that this source copy is current and you are authorized to export it.",
    );
    ownerConfirmation.focus();
    return;
  }
  beginPendingExport(snapshotId, scope);
});

snapshotInput.addEventListener("input", clearValidation);
ownerConfirmation.addEventListener("change", clearValidation);
for (const input of scopeInputs) {
  input.addEventListener("change", () => {
    clearValidation();
    // Reflect whether the component-scope control currently applies.
    setBusy(false);
  });
}

cancelButton.addEventListener("click", () => {
  const exportId = session.cancelActive();
  if (exportId === null) {
    return;
  }
  postToMain({
    type: "cancel-export",
    protocolVersion: PROTOCOL_VERSION,
    exportId,
  });
});

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (
    typeof event.data !== "object" ||
    event.data === null ||
    !("pluginMessage" in event.data)
  ) {
    return;
  }

  const message = parseMainToUiMessage(event.data.pluginMessage);
  if (message === null) {
    return;
  }

  switch (message.type) {
    case "initialize-result": {
      initialized = true;
      selectionCount = message.document.selectionCount;
      supportedScopes = message.capabilities.supportedScopes;
      documentName.textContent = message.document.name;
      pageCount.textContent = String(message.document.pageCount);
      selectionCountElement.textContent = String(selectionCount);
      setStatus(
        "ready",
        "Ready to export. Choose a scope, confirm this source copy, and start the local archive.",
      );
      if (activeExportId === null && pendingSnapshotId === null) {
        setBusy(false);
      }
      pingSequence += 1;
      postToMain({
        type: "ping-request",
        protocolVersion: PROTOCOL_VERSION,
        requestId: `ping-${pingSequence}`,
      });
      break;
    }
    case "pong-result":
      connectionStatus.dataset.state = "connected";
      connectionStatus.textContent = `Connected · v${PROTOCOL_VERSION}`;
      break;
    case "export-started": {
      if (
        pendingSnapshotId === null ||
        pendingScope === null ||
        activeExportId !== null ||
        !matchesPendingExportRequest(pendingRequestId, message.requestId)
      ) {
        break;
      }
      if (message.scopeSummary.kind !== pendingScope) {
        postToMain({
          type: "cancel-export",
          protocolVersion: PROTOCOL_VERSION,
          exportId: message.exportId,
        });
        pendingSnapshotId = null;
        pendingRequestId = null;
        pendingScope = null;
        setBusy(false);
        progressPanel.hidden = true;
        setStatus(
          "error",
          "The export scope response did not match the request.",
        );
        break;
      }
      activeExportId = message.exportId;
      session.start(message.exportId, pendingSnapshotId);
      pendingSnapshotId = null;
      pendingRequestId = null;
      pendingScope = null;
      setBusy(true);
      setStatus(
        "working",
        "Export is running locally. Detailed progress appears below.",
        "Exporting",
      );
      if (message.scopeSummary.kind === "entire-file") {
        progressTitle.textContent = "Loading pages in document order";
        progressCount.textContent = `0 / ${message.scopeSummary.pageCount}`;
      } else {
        progressTitle.textContent = "Collecting selected roots";
        progressCount.textContent = `0 / ${message.scopeSummary.rootCount}`;
      }
      cancelButton.hidden = false;
      break;
    }
    case "progress": {
      if (message.exportId !== activeExportId) {
        break;
      }
      const phaseLabel = message.phase.replaceAll("-", " ");
      progressTitle.textContent = `${phaseLabel[0]?.toUpperCase()}${phaseLabel.slice(1)}`;
      progressItem.textContent = message.currentLabel ?? "";
      const duration =
        message.durationMs === undefined
          ? ""
          : ` • ${Math.round(message.durationMs)} ms`;
      if (message.total === undefined || message.total === 0) {
        progressBar.removeAttribute("value");
        progressCount.textContent = `${message.completed}${duration}`;
      } else {
        progressBar.max = message.total;
        progressBar.value = Math.min(message.completed, message.total);
        progressCount.textContent = `${message.completed} / ${message.total}${duration}`;
      }
      break;
    }
    case "archive-entry":
      session.acceptEntry(message);
      break;
    case "diagnostic-summary":
      if (message.exportId === activeExportId) {
        diagnosticSummary.textContent = `${message.completeness}; ${message.counts.warning} warning(s), ${message.counts.error} error(s).`;
      }
      break;
    case "export-ready":
      if (message.exportId === activeExportId) {
        setStatus(
          "working",
          "Validating the archive and preparing the local save request.",
          "Finalizing",
        );
        progressTitle.textContent = "Finalizing archive locally";
        progressCount.textContent = "";
        progressBar.removeAttribute("value");
        progressItem.textContent = "Validating entries and manifest";
      }
      session.acceptReady(message);
      break;
    case "export-cancelled":
      session.acceptCancelled(message);
      break;
    case "export-failed":
      if (activeExportId === message.exportId) {
        session.acceptFailed(message);
      } else if (
        pendingSnapshotId !== null &&
        matchesPendingExportRequest(pendingRequestId, message.requestId)
      ) {
        pendingSnapshotId = null;
        pendingRequestId = null;
        pendingScope = null;
        setBusy(false);
        progressPanel.hidden = true;
        setStatus("error", failureMessage(message.safeError.code));
      }
      break;
  }
});

snapshotInput.value = defaultSnapshotId();
setBusy(true);
postToMain({
  type: "initialize-request",
  protocolVersion: PROTOCOL_VERSION,
});
