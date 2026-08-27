import {
  ArchiveProducerSafetyError,
  archivePaths,
  type SnapshotId,
} from "../shared/archive";
import {
  DIAGNOSTIC_CODES,
  normalizeSafeTechnicalCause,
  type DiagnosticBag,
} from "../shared/diagnostics";
import type { PreviewRefIR } from "../shared/ir";
import { planPreviewExport, readPngDimensions } from "../shared/png";
import { sha256Hex } from "../shared/sha256";
import { assertArchiveEntryFits } from "./archive-entry-preflight";
import { ExportCancellationToken, ExportCancelledError } from "./cancellation";

interface PreviewBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface PreviewExportSettings {
  readonly format: "PNG";
  readonly constraint:
    | { readonly type: "SCALE"; readonly value: 1 }
    | { readonly type: "WIDTH" | "HEIGHT"; readonly value: 4096 };
}

export interface PreviewExportNode {
  readonly id: string;
  readonly name: string;
  readonly absoluteRenderBounds?: PreviewBounds | null;
  readonly absoluteBoundingBox?: PreviewBounds | null;
  exportAsync(settings: PreviewExportSettings): Promise<Uint8Array>;
}

/**
 * Narrow, structural adapter used to select whole-file previews without
 * depending on Figma globals or recursively walking the supplied tree.
 */
export interface EntireFilePreviewSelectorNode extends PreviewExportNode {
  readonly type: string;
  readonly visible: boolean;
  readonly width: number;
  readonly height: number;
  readonly children?: readonly EntireFilePreviewSelectorNode[];
  readonly sectionContentsHidden?: boolean;
}

export interface EntireFilePreviewSelectorPage {
  readonly children: readonly EntireFilePreviewSelectorNode[];
}

const ENTIRE_FILE_PREVIEW_NODE_TYPES = new Set([
  "FRAME",
  "COMPONENT",
  "COMPONENT_SET",
]);

function isEligibleEntireFilePreviewNode(
  node: EntireFilePreviewSelectorNode,
): boolean {
  return (
    ENTIRE_FILE_PREVIEW_NODE_TYPES.has(node.type) &&
    node.visible &&
    Number.isFinite(node.width) &&
    Number.isFinite(node.height) &&
    node.width > 0 &&
    node.height > 0
  );
}

/**
 * Implements the exact Section 10 whole-file preview rule in source order:
 * eligible direct page children, followed in place by eligible direct
 * children of a visible page-child section. It intentionally does not descend
 * through groups, instances, nested sections, or any deeper container.
 */
export function selectEntireFilePreviewCandidates(
  page: EntireFilePreviewSelectorPage,
): readonly PreviewExportNode[] {
  const candidates: PreviewExportNode[] = [];
  for (const pageChild of page.children) {
    if (isEligibleEntireFilePreviewNode(pageChild)) {
      candidates.push(pageChild);
      continue;
    }
    if (
      pageChild.type !== "SECTION" ||
      !pageChild.visible ||
      pageChild.sectionContentsHidden === true
    ) {
      continue;
    }
    for (const sectionChild of pageChild.children ?? []) {
      if (isEligibleEntireFilePreviewNode(sectionChild)) {
        candidates.push(sectionChild);
      }
    }
  }
  return candidates;
}

function previewBounds(root: PreviewExportNode): PreviewBounds {
  const bounds = root.absoluteRenderBounds ?? root.absoluteBoundingBox ?? null;
  if (
    bounds === null ||
    !Number.isFinite(bounds.x) ||
    !Number.isFinite(bounds.y) ||
    !Number.isFinite(bounds.width) ||
    !Number.isFinite(bounds.height) ||
    bounds.width <= 0 ||
    bounds.height <= 0
  ) {
    throw new Error("Preview bounds are unavailable.");
  }
  return bounds;
}

export async function exportNodePreview(
  node: PreviewExportNode,
  snapshotId: SnapshotId,
  diagnostics: DiagnosticBag,
  cancellation: ExportCancellationToken,
  entryByteLimit?: number,
): Promise<
  | {
      readonly bytes: Uint8Array;
      readonly preview: PreviewRefIR;
    }
  | {
      readonly diagnosticId: string;
    }
> {
  const path = archivePaths.preview(snapshotId, node.id);
  try {
    cancellation.throwIfCancelled();
    const bounds = previewBounds(node);
    const plan = planPreviewExport(bounds.width, bounds.height);
    cancellation.throwIfCancelled();
    const bytes = await node.exportAsync({
      format: "PNG",
      constraint: plan.constraint,
    });
    cancellation.throwIfCancelled();
    await assertArchiveEntryFits(bytes, {
      byteLimit: entryByteLimit,
      checkpoint: () => cancellation.throwIfCancelled(),
    });
    const dimensions = readPngDimensions(bytes);
    if (Math.max(dimensions.width, dimensions.height) > 4096) {
      throw new Error("The bounded preview exceeded its maximum dimension.");
    }
    cancellation.throwIfCancelled();
    const contentSha256 = sha256Hex(bytes);
    cancellation.throwIfCancelled();
    return {
      bytes,
      preview: {
        sourceNode: { kind: "node", id: node.id, name: node.name },
        archivePath: path,
        mediaType: "image/png",
        sourceBounds: {
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
        },
        exportedBounds: {
          x: 0,
          y: 0,
          width: dimensions.width,
          height: dimensions.height,
        },
        scale: plan.scale,
        byteLength: bytes.length,
        contentSha256,
        diagnosticIds: [],
      },
    };
  } catch (error) {
    if (error instanceof ExportCancelledError) {
      throw error;
    }
    cancellation.throwIfCancelled();
    if (
      error instanceof ArchiveProducerSafetyError &&
      error.code === "archive-capacity-exceeded"
    ) {
      const diagnostic = diagnostics.add({
        code: DIAGNOSTIC_CODES.archiveEntryTooLarge,
        severity: "error",
        message:
          "A preview exceeded the safe single-entry archive limit and is absent.",
        phase: "preview",
        source: { kind: "node", id: node.id, name: node.name },
        artifactPath: path,
        causedDataLoss: true,
      });
      return { diagnosticId: diagnostic.id };
    }
    const diagnostic = diagnostics.add({
      code: DIAGNOSTIC_CODES.previewExportFailed,
      severity: "error",
      message: "A required preview could not be exported and is absent.",
      phase: "preview",
      source: { kind: "node", id: node.id, name: node.name },
      artifactPath: path,
      causedDataLoss: true,
      technicalCause: normalizeSafeTechnicalCause(error, "unknown"),
    });
    return { diagnosticId: diagnostic.id };
  }
}

// Retain the selection-facing name for archive compatibility while whole-file
// orchestration uses the generic exporter above.
export const exportSelectedRootPreview = exportNodePreview;
