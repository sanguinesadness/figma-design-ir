import {
  DIAGNOSTIC_CODES,
  normalizeSafeTechnicalCause,
  type DiagnosticBag,
} from "../shared/diagnostics";
import {
  DESIGN_IR_SCHEMA_VERSION,
  type AnnotationIR,
  type ConditionalBlockIR,
  type InteractionActionIR,
  type InteractionTriggerIR,
  type JsonObject,
  type JsonValue,
  type ReactionIR,
  type SourceRef,
  type TransitionIR,
} from "../shared/ir";
import { normalizeJsonSafeValue } from "../shared/normalization";

export interface CollectedNodeInteractions {
  readonly annotations: readonly AnnotationIR[];
  readonly reactions: readonly ReactionIR[];
  readonly annotationsAvailable: boolean;
  readonly reactionsAvailable: boolean;
  readonly dependencyRefs: readonly SourceRef[];
  readonly complete: boolean;
}

function nodeSource(node: SceneNode): SourceRef & { readonly kind: "node" } {
  let id = "unavailable-node";
  let name: string | undefined;
  try {
    id = node.id;
  } catch {
    // The property-access diagnostic is emitted by the caller's common reader.
  }
  try {
    name = node.name;
  } catch {
    // The property-access diagnostic is emitted by the caller's common reader.
  }
  return { kind: "node", id, ...(name === undefined ? {} : { name }) };
}

function normalizeRuntimeValue(
  node: SceneNode,
  propertyPath: readonly (string | number)[],
  value: unknown,
  diagnostics: DiagnosticBag,
): JsonValue {
  return normalizeJsonSafeValue(value, {
    diagnostics,
    phase: "collection",
    source: nodeSource(node),
    propertyPath,
    classifySpecialValue: (candidate) =>
      candidate === figma.mixed ? { $type: "figma-mixed" } : undefined,
  }).value;
}

function objectValue(value: JsonValue | undefined): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | null | undefined {
  if (value === null) {
    return null;
  }
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function isNumberArray(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.every((candidate: unknown) => typeof candidate === "number")
  );
}

function transitionFromAction(
  node: SceneNode,
  action: Record<string, unknown>,
  propertyPath: readonly (string | number)[],
  diagnostics: DiagnosticBag,
): TransitionIR | undefined {
  const transition = action.transition;
  if (transition === null || typeof transition !== "object") {
    return undefined;
  }
  const record = transition as Record<string, unknown>;
  const transitionType = stringValue(record.type);
  if (transitionType === undefined) {
    return undefined;
  }
  const easing = normalizeRuntimeValue(
    node,
    [...propertyPath, "transition", "easing"],
    record.easing,
    diagnostics,
  );
  const durationSeconds = numberValue(record.duration);
  return {
    transitionType,
    ...(easing === undefined ? {} : { easing }),
    ...(durationSeconds === undefined ? {} : { durationSeconds }),
    ...(typeof record.direction === "string"
      ? { direction: record.direction }
      : {}),
    ...(typeof record.matchLayers === "boolean"
      ? { matchLayers: record.matchLayers }
      : {}),
  };
}

function destinationRef(
  destinationId: unknown,
): (SourceRef & { readonly kind: "node" }) | undefined {
  return typeof destinationId === "string" && destinationId.length > 0
    ? { kind: "node", id: destinationId }
    : undefined;
}

function variableRefsFromJson(value: JsonValue): readonly SourceRef[] {
  const references: SourceRef[] = [];
  const visit = (candidate: JsonValue): void => {
    if (Array.isArray(candidate)) {
      for (const item of candidate as readonly JsonValue[]) {
        visit(item);
      }
      return;
    }
    if (typeof candidate !== "object" || candidate === null) {
      return;
    }
    const object = candidate as JsonObject;
    if (
      (object.type === "VARIABLE_ALIAS" || object.$type === "variable-alias") &&
      typeof (object.id ?? object.variableId) === "string"
    ) {
      references.push({
        kind: "variable",
        id: (object.id ?? object.variableId) as string,
      });
    }
    for (const child of Object.values(object)) {
      if (child !== undefined) {
        visit(child);
      }
    }
  };
  visit(value);
  return references;
}

function collectUnknownAction(
  node: SceneNode,
  action: unknown,
  propertyPath: readonly (string | number)[],
  diagnostics: DiagnosticBag,
): InteractionActionIR {
  const raw = normalizeRuntimeValue(node, propertyPath, action, diagnostics);
  const diagnostic = diagnostics.add({
    code: DIAGNOSTIC_CODES.interactionUnsupportedAction,
    severity: "warning",
    message:
      "An unsupported interaction action was retained as canonical raw data.",
    phase: "collection",
    source: nodeSource(node),
    propertyPath: `$.${propertyPath.join(".")}`,
    causedDataLoss: false,
  });
  return {
    actionType: "unknown",
    raw:
      objectValue(raw) ??
      ({
        $type: "unsupported",
        runtimeType: typeof action,
        reason: "unknown",
      } as const),
    diagnosticIds: [diagnostic.id],
  };
}

function collectAction(
  node: SceneNode,
  action: unknown,
  propertyPath: readonly (string | number)[],
  diagnostics: DiagnosticBag,
  dependencyRefs: SourceRef[],
): InteractionActionIR {
  if (typeof action !== "object" || action === null) {
    return collectUnknownAction(node, action, propertyPath, diagnostics);
  }
  const record = action as Record<string, unknown>;
  const actionType = stringValue(record.type);
  const normalizedAction = objectValue(
    normalizeRuntimeValue(node, propertyPath, action, diagnostics),
  );
  if (actionType === "BACK") {
    return {
      actionType: "back",
      ...(normalizedAction === undefined ? {} : { raw: normalizedAction }),
    };
  }
  if (actionType === "CLOSE") {
    return {
      actionType: "close-overlay",
      ...(normalizedAction === undefined ? {} : { raw: normalizedAction }),
    };
  }
  if (actionType === "URL") {
    if (typeof record.url !== "string") {
      return collectUnknownAction(node, action, propertyPath, diagnostics);
    }
    return {
      actionType: "url",
      url: record.url,
      ...(typeof record.openInNewTab === "boolean"
        ? { openInNewTab: record.openInNewTab }
        : {}),
      ...(normalizedAction === undefined ? {} : { raw: normalizedAction }),
    };
  }
  if (actionType === "UPDATE_MEDIA_RUNTIME") {
    const destination = destinationRef(record.destinationId);
    if (destination !== undefined) {
      dependencyRefs.push(destination);
    }
    if (typeof record.mediaAction !== "string") {
      return collectUnknownAction(node, action, propertyPath, diagnostics);
    }
    return {
      actionType: "update-media-runtime",
      ...(destination === undefined ? {} : { destination }),
      mediaAction: record.mediaAction,
      ...(numberValue(record.amountToSkip) === undefined
        ? {}
        : { amountToSkip: numberValue(record.amountToSkip)! }),
      ...(numberValue(record.newTimestamp) === undefined
        ? {}
        : { newTimestamp: numberValue(record.newTimestamp)! }),
      ...(normalizedAction === undefined ? {} : { raw: normalizedAction }),
    };
  }
  if (actionType === "NODE") {
    const destination = destinationRef(record.destinationId);
    if (destination !== undefined) {
      dependencyRefs.push(destination);
    }
    const navigation = stringValue(record.navigation) ?? "UNKNOWN";
    const transition = transitionFromAction(
      node,
      record,
      propertyPath,
      diagnostics,
    );
    if (navigation === "OVERLAY" || navigation === "SWAP") {
      const relative = record.overlayRelativePosition;
      const relativePosition =
        typeof relative === "object" && relative !== null
          ? {
              x: numberValue((relative as Record<string, unknown>).x) ?? null,
              y: numberValue((relative as Record<string, unknown>).y) ?? null,
            }
          : undefined;
      return {
        actionType: navigation === "OVERLAY" ? "open-overlay" : "swap-overlay",
        ...(destination === undefined ? {} : { destination }),
        ...(relativePosition === undefined ? {} : { relativePosition }),
        ...(transition === undefined ? {} : { transition }),
        ...(normalizedAction === undefined ? {} : { raw: normalizedAction }),
      };
    }
    if (navigation === "SCROLL_TO") {
      return {
        actionType: "scroll-to",
        ...(destination === undefined ? {} : { destination }),
        ...(transition === undefined ? {} : { transition }),
        ...(normalizedAction === undefined ? {} : { raw: normalizedAction }),
      };
    }
    return {
      actionType: "navigate",
      ...(destination === undefined ? {} : { destination }),
      navigation,
      ...(transition === undefined ? {} : { transition }),
      ...(typeof record.preserveScrollPosition === "boolean"
        ? { preserveScrollPosition: record.preserveScrollPosition }
        : {}),
      ...(typeof record.resetScrollPosition === "boolean"
        ? { resetScrollPosition: record.resetScrollPosition }
        : {}),
      ...(typeof record.resetVideoPosition === "boolean"
        ? { resetVideoPosition: record.resetVideoPosition }
        : {}),
      ...(typeof record.resetInteractiveComponents === "boolean"
        ? { resetInteractiveComponents: record.resetInteractiveComponents }
        : {}),
      ...(normalizedAction === undefined ? {} : { raw: normalizedAction }),
    };
  }
  if (actionType === "SET_VARIABLE") {
    const variable =
      typeof record.variableId === "string"
        ? ({ kind: "variable", id: record.variableId } as const)
        : undefined;
    if (variable !== undefined) {
      dependencyRefs.push(variable);
    }
    const value =
      record.variableValue === undefined
        ? undefined
        : normalizeRuntimeValue(
            node,
            [...propertyPath, "variableValue"],
            record.variableValue,
            diagnostics,
          );
    if (value !== undefined) {
      dependencyRefs.push(...variableRefsFromJson(value));
    }
    return {
      actionType: "set-variable",
      ...(variable === undefined ? {} : { variable }),
      ...(value === undefined ? {} : { value }),
      ...(normalizedAction === undefined ? {} : { raw: normalizedAction }),
    };
  }
  if (actionType === "SET_VARIABLE_MODE") {
    const collection =
      typeof record.variableCollectionId === "string"
        ? ({ kind: "collection", id: record.variableCollectionId } as const)
        : undefined;
    if (collection !== undefined) {
      dependencyRefs.push(collection);
    }
    return {
      actionType: "set-variable-mode",
      ...(collection === undefined ? {} : { collection }),
      ...(typeof record.variableModeId === "string"
        ? { modeId: record.variableModeId }
        : {}),
      ...(normalizedAction === undefined ? {} : { raw: normalizedAction }),
    };
  }
  if (actionType === "CONDITIONAL") {
    const raw = normalizeRuntimeValue(node, propertyPath, action, diagnostics);
    dependencyRefs.push(...variableRefsFromJson(raw));
    const rawBlocks = Array.isArray(record.conditionalBlocks)
      ? record.conditionalBlocks
      : [];
    const conditionalBlocks: ConditionalBlockIR[] = rawBlocks.map(
      (block, blockIndex) => {
        const normalizedBlock = normalizeRuntimeValue(
          node,
          [...propertyPath, "conditionalBlocks", blockIndex],
          block,
          diagnostics,
        );
        const blockRecord =
          typeof block === "object" && block !== null
            ? (block as Record<string, unknown>)
            : {};
        const blockActions = Array.isArray(blockRecord.actions)
          ? blockRecord.actions.map((nestedAction, nestedIndex) =>
              collectAction(
                node,
                nestedAction,
                [
                  ...propertyPath,
                  "conditionalBlocks",
                  blockIndex,
                  "actions",
                  nestedIndex,
                ],
                diagnostics,
                dependencyRefs,
              ),
            )
          : [];
        const condition =
          blockRecord.condition === undefined
            ? undefined
            : normalizeRuntimeValue(
                node,
                [...propertyPath, "conditionalBlocks", blockIndex, "condition"],
                blockRecord.condition,
                diagnostics,
              );
        return {
          ...(condition === undefined ? {} : { condition }),
          actions: blockActions,
          ...(objectValue(normalizedBlock) === undefined
            ? {}
            : { raw: objectValue(normalizedBlock)! }),
        };
      },
    );
    return {
      actionType: "conditional",
      actions: conditionalBlocks.flatMap((block) => block.actions),
      conditionalBlocks,
      ...(normalizedAction === undefined ? {} : { raw: normalizedAction }),
    };
  }
  return collectUnknownAction(node, action, propertyPath, diagnostics);
}

function collectTrigger(
  node: SceneNode,
  trigger: unknown,
  propertyPath: readonly (string | number)[],
  diagnostics: DiagnosticBag,
): InteractionTriggerIR | null {
  if (trigger === null) {
    return null;
  }
  if (typeof trigger !== "object") {
    const raw = objectValue(
      normalizeRuntimeValue(node, propertyPath, trigger, diagnostics),
    );
    return {
      triggerType: "UNKNOWN",
      ...(raw === undefined ? {} : { raw }),
    };
  }
  const record = trigger as Record<string, unknown>;
  const triggerType = stringValue(record.type) ?? "UNKNOWN";
  const raw = objectValue(
    normalizeRuntimeValue(node, propertyPath, trigger, diagnostics),
  );
  return {
    triggerType,
    ...(numberValue(record.timeout) === undefined
      ? {}
      : { delaySeconds: numberValue(record.timeout)! }),
    ...(numberValue(record.delay) === undefined
      ? {}
      : { delaySeconds: numberValue(record.delay)! }),
    ...(typeof record.device === "string" ? { device: record.device } : {}),
    ...(isNumberArray(record.keyCodes) ? { keyCodes: record.keyCodes } : {}),
    ...(numberValue(record.mediaHitTime) === undefined
      ? {}
      : { mediaHitTime: numberValue(record.mediaHitTime)! }),
    ...(raw === undefined ? {} : { raw }),
  };
}

function readProperty(
  node: SceneNode,
  property: "annotations" | "reactions",
  diagnostics: DiagnosticBag,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  try {
    if (!(property in node)) {
      return { ok: true, value: [] };
    }
    return {
      ok: true,
      value: (node as unknown as Record<string, unknown>)[property],
    };
  } catch (error) {
    diagnostics.add({
      code: DIAGNOSTIC_CODES.collectionPropertyAccessFailed,
      severity: "warning",
      message:
        "A supported interaction or annotation property could not be read.",
      phase: "collection",
      source: nodeSource(node),
      propertyPath: `$.${property}`,
      causedDataLoss: true,
      technicalCause: normalizeSafeTechnicalCause(error, "property-access"),
    });
    return { ok: false };
  }
}

function diagnoseInteractionShape(
  node: SceneNode,
  propertyPath: string,
  diagnostics: DiagnosticBag,
): void {
  diagnostics.add({
    code: DIAGNOSTIC_CODES.collectionPropertyAccessFailed,
    severity: "warning",
    message:
      "Supported interaction or annotation data had an unexpected runtime shape.",
    phase: "collection",
    source: nodeSource(node),
    propertyPath,
    causedDataLoss: true,
  });
}

export function collectNodeInteractions(
  node: SceneNode,
  diagnostics: DiagnosticBag,
): CollectedNodeInteractions {
  const dependencyRefs: SourceRef[] = [];
  let complete = true;
  const annotationRead = readProperty(node, "annotations", diagnostics);
  const annotations: AnnotationIR[] = [];
  if (!annotationRead.ok) {
    complete = false;
  } else if (Array.isArray(annotationRead.value)) {
    for (const [index, annotation] of annotationRead.value.entries()) {
      const normalized = objectValue(
        normalizeRuntimeValue(
          node,
          ["annotations", index],
          annotation,
          diagnostics,
        ),
      );
      if (normalized === undefined) {
        diagnoseInteractionShape(node, `$.annotations[${index}]`, diagnostics);
        complete = false;
        continue;
      }
      let properties: readonly { readonly type: string }[] | undefined;
      if (normalized.properties !== undefined) {
        if (!Array.isArray(normalized.properties)) {
          diagnoseInteractionShape(
            node,
            `$.annotations[${index}].properties`,
            diagnostics,
          );
          complete = false;
        } else {
          const collectedProperties: { readonly type: string }[] = [];
          for (const [propertyIndex, property] of (
            normalized.properties as readonly JsonValue[]
          ).entries()) {
            const object = objectValue(property);
            if (object === undefined || typeof object.type !== "string") {
              diagnoseInteractionShape(
                node,
                `$.annotations[${index}].properties[${propertyIndex}]`,
                diagnostics,
              );
              complete = false;
            } else {
              collectedProperties.push({ type: object.type });
            }
          }
          properties = collectedProperties;
        }
      }
      annotations.push({
        ...(typeof normalized.label === "string"
          ? { label: normalized.label }
          : {}),
        ...(typeof normalized.labelMarkdown === "string"
          ? { labelMarkdown: normalized.labelMarkdown }
          : {}),
        ...(typeof normalized.categoryId === "string"
          ? { categoryId: normalized.categoryId }
          : {}),
        ...(properties === undefined ? {} : { properties }),
        raw: normalized,
      });
    }
  } else {
    diagnoseInteractionShape(node, "$.annotations", diagnostics);
    complete = false;
  }

  const reactionRead = readProperty(node, "reactions", diagnostics);
  const reactions: ReactionIR[] = [];
  if (!reactionRead.ok) {
    complete = false;
  } else if (Array.isArray(reactionRead.value)) {
    for (const [reactionIndex, reaction] of reactionRead.value.entries()) {
      if (typeof reaction !== "object" || reaction === null) {
        diagnoseInteractionShape(
          node,
          `$.reactions[${reactionIndex}]`,
          diagnostics,
        );
        complete = false;
        continue;
      }
      const record = reaction as Record<string, unknown>;
      const actionInputs = Array.isArray(record.actions)
        ? record.actions
        : record.action === undefined
          ? []
          : [record.action];
      const diagnosticStart = diagnostics.size();
      const actions = actionInputs.map((action, actionIndex) =>
        collectAction(
          node,
          action,
          ["reactions", reactionIndex, "actions", actionIndex],
          diagnostics,
          dependencyRefs,
        ),
      );
      reactions.push({
        id: `${nodeSource(node).id}:reaction:${String(reactionIndex).padStart(6, "0")}`,
        sourceNode: nodeSource(node),
        order: reactionIndex,
        trigger: collectTrigger(
          node,
          record.trigger,
          ["reactions", reactionIndex, "trigger"],
          diagnostics,
        ),
        actions,
        diagnosticIds: diagnostics
          .listSince(diagnosticStart)
          .map((diagnostic) => diagnostic.id),
      });
    }
  } else {
    diagnoseInteractionShape(node, "$.reactions", diagnostics);
    complete = false;
  }

  return {
    annotations,
    reactions,
    annotationsAvailable: annotationRead.ok,
    reactionsAvailable: reactionRead.ok,
    dependencyRefs,
    complete,
  };
}

export const INTERACTION_COLLECTOR_SCHEMA_VERSION = DESIGN_IR_SCHEMA_VERSION;
