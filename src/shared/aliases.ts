import {
  DIAGNOSTIC_CODES,
  type Diagnostic,
  type DiagnosticBag,
  type DiagnosticCode,
  type DiagnosticSeverity,
} from "./diagnostics";
import {
  isVariableAliasValue,
  type JsonObject,
  type JsonValue,
  type SourceRef,
  type UnavailableValue,
  type VariableModeValueIR,
  type VariableResolutionStatus,
} from "./ir";
import { compareSourceRefs } from "./serialization";

export interface AliasVariableInput {
  readonly source: SourceRef & { readonly kind: "variable" };
  readonly collectionId: string;
  readonly valuesByMode: Readonly<Record<string, JsonValue>>;
}

export interface AliasCollectionInput {
  readonly id: string;
  readonly modeOrder: readonly string[];
}

export interface AliasResolutionInput {
  readonly variables: readonly AliasVariableInput[];
  readonly collections: readonly AliasCollectionInput[];
  readonly selectedModesByCollection?: Readonly<Record<string, string>>;
  /** One shared bag must be used for every diagnostic in an export. */
  readonly diagnostics: DiagnosticBag;
}

export interface ResolvedAliasVariable {
  readonly source: SourceRef & { readonly kind: "variable" };
  readonly values: readonly VariableModeValueIR[];
}

export interface AliasResolutionResult {
  readonly variables: readonly ResolvedAliasVariable[];
  readonly diagnostics: readonly Diagnostic[];
}

export class AliasResolutionContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AliasResolutionContractError";
  }
}

interface AliasState {
  readonly variableId: string;
  readonly modeId: string;
}

interface WalkResult {
  readonly status: VariableResolutionStatus;
  readonly resolved?: JsonValue;
  readonly aliasChain: readonly string[];
  readonly missingId?: string;
  readonly cycle?: readonly AliasState[];
  readonly contextCollectionId?: string;
}

interface AliasIssue {
  readonly signature: string;
  readonly code: DiagnosticCode;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly source: SourceRef & { readonly kind: "variable" };
  readonly modeId: string;
  readonly causedDataLoss: boolean;
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function compareStates(left: AliasState, right: AliasState): number {
  return (
    compareStrings(left.variableId, right.variableId) ||
    compareStrings(left.modeId, right.modeId)
  );
}

function stateKey(state: AliasState): string {
  return JSON.stringify([state.variableId, state.modeId]);
}

function contextKey(context: ReadonlyMap<string, string>): string {
  return JSON.stringify(
    [...context.entries()].sort(([left], [right]) =>
      compareStrings(left, right),
    ),
  );
}

function issueSignature(parts: readonly unknown[]): string {
  return JSON.stringify(parts);
}

function orderedModes(requestedOrder: readonly string[]): readonly string[] {
  return [...requestedOrder];
}

function isMissingModeValue(value: JsonValue): value is UnavailableValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const objectValue = value as JsonObject;
  return (
    objectValue.$type === "unavailable" && objectValue.reason === "missing-mode"
  );
}

function canonicalCycle(states: readonly AliasState[]): readonly AliasState[] {
  if (states.length === 0) {
    return states;
  }

  let minimumIndex = 0;
  for (let index = 1; index < states.length; index += 1) {
    const candidate = states[index];
    const minimum = states[minimumIndex];
    if (
      candidate !== undefined &&
      minimum !== undefined &&
      compareStates(candidate, minimum) < 0
    ) {
      minimumIndex = index;
    }
  }

  const rotated = [
    ...states.slice(minimumIndex),
    ...states.slice(0, minimumIndex),
  ];
  const first = rotated[0];
  return first === undefined ? rotated : [...rotated, first];
}

function cycleFromState(
  states: readonly AliasState[],
  startIndex: number,
): readonly string[] {
  const rotated = [...states.slice(startIndex), ...states.slice(0, startIndex)];
  const first = rotated[0];
  return first === undefined
    ? []
    : [...rotated.map((state) => state.variableId), first.variableId];
}

function formatCycle(states: readonly AliasState[]): string {
  return states
    .map((state) => `${state.variableId}@${state.modeId}`)
    .join(" -> ");
}

export function resolveVariableAliases(
  input: AliasResolutionInput,
): AliasResolutionResult {
  const diagnosticStart = input.diagnostics.size();
  const byId = new Map<string, AliasVariableInput>();
  for (const variable of input.variables) {
    if (byId.has(variable.source.id)) {
      throw new AliasResolutionContractError(
        "Alias resolution requires unique variable source IDs.",
      );
    }
    byId.set(variable.source.id, variable);
  }

  const modeOrderByCollection = new Map<string, readonly string[]>();
  for (const collection of input.collections) {
    if (modeOrderByCollection.has(collection.id)) {
      throw new AliasResolutionContractError(
        "Alias resolution requires unique collection IDs.",
      );
    }
    if (
      collection.modeOrder.length === 0 ||
      new Set(collection.modeOrder).size !== collection.modeOrder.length
    ) {
      throw new AliasResolutionContractError(
        "Alias resolution requires each collection to declare a non-empty, duplicate-free mode order.",
      );
    }
    modeOrderByCollection.set(collection.id, collection.modeOrder);
  }

  for (const variable of input.variables) {
    const collectionModes = modeOrderByCollection.get(variable.collectionId);
    if (collectionModes === undefined) {
      throw new AliasResolutionContractError(
        "Alias resolution requires every variable to reference a declared collection.",
      );
    }
    const declaredModes = new Set(collectionModes);
    const valueModes = Object.keys(variable.valuesByMode);
    if (valueModes.some((modeId) => !declaredModes.has(modeId))) {
      throw new AliasResolutionContractError(
        "Alias resolution values must use modes declared by their collection.",
      );
    }
    if (
      collectionModes.some(
        (modeId) => !Object.hasOwn(variable.valuesByMode, modeId),
      )
    ) {
      throw new AliasResolutionContractError(
        "Alias resolution requires an explicit raw or tagged unavailable value for every declared mode.",
      );
    }
  }

  for (const [collectionId, modeId] of Object.entries(
    input.selectedModesByCollection ?? {},
  )) {
    const collectionModes = modeOrderByCollection.get(collectionId);
    if (collectionModes === undefined || !collectionModes.includes(modeId)) {
      throw new AliasResolutionContractError(
        "Alias resolution context must select a declared mode from a declared collection.",
      );
    }
  }

  const issues = new Map<string, AliasIssue>();
  const cachesByContext = new Map<string, Map<string, WalkResult>>();
  const baseModeContext = new Map<string, string>();
  for (const [collectionId, modes] of modeOrderByCollection) {
    if (modes.length === 1 && modes[0] !== undefined) {
      baseModeContext.set(collectionId, modes[0]);
    }
  }
  for (const [collectionId, modeId] of Object.entries(
    input.selectedModesByCollection ?? {},
  )) {
    baseModeContext.set(collectionId, modeId);
  }

  const targetMode = (
    current: AliasVariableInput,
    currentModeId: string,
    target: AliasVariableInput,
    context: ReadonlyMap<string, string>,
  ):
    | { readonly kind: "mode"; readonly modeId: string }
    | { readonly kind: "requires-consumer-context" } => {
    if (target.collectionId === current.collectionId) {
      return { kind: "mode", modeId: currentModeId };
    }

    const contextualMode = context.get(target.collectionId);
    if (contextualMode !== undefined) {
      return { kind: "mode", modeId: contextualMode };
    }

    const modes = modeOrderByCollection.get(target.collectionId);
    const onlyMode = modes?.length === 1 ? modes[0] : undefined;
    return onlyMode === undefined
      ? { kind: "requires-consumer-context" }
      : { kind: "mode", modeId: onlyMode };
  };

  const walk = (
    start: AliasState,
    modeContext: ReadonlyMap<string, string>,
  ): WalkResult => {
    const cacheIdentifier = contextKey(modeContext);
    let cache = cachesByContext.get(cacheIdentifier);
    if (cache === undefined) {
      cache = new Map<string, WalkResult>();
      cachesByContext.set(cacheIdentifier, cache);
    }

    const states: AliasState[] = [];
    const localIndexes = new Map<string, number>();
    let current = start;
    let outcome: WalkResult | undefined;

    for (;;) {
      const currentKey = stateKey(current);
      const cached = cache.get(currentKey);
      if (cached !== undefined) {
        outcome = cached;
        break;
      }

      const cycleStart = localIndexes.get(currentKey);
      if (cycleStart !== undefined) {
        const cycleStates = states.slice(cycleStart);
        const canonical = canonicalCycle(cycleStates);
        for (let index = 0; index < cycleStates.length; index += 1) {
          const cycleState = cycleStates[index];
          if (cycleState !== undefined) {
            cache.set(stateKey(cycleState), {
              status: "cycle",
              aliasChain: cycleFromState(cycleStates, index),
              cycle: canonical,
            });
          }
        }
        outcome = cache.get(currentKey);
        if (outcome === undefined) {
          throw new AliasResolutionContractError(
            "Alias cycle resolution failed to produce a stable result.",
          );
        }
        break;
      }

      localIndexes.set(currentKey, states.length);
      states.push(current);
      const variable = byId.get(current.variableId);
      if (variable === undefined) {
        outcome = {
          status: "missing-reference",
          aliasChain: [current.variableId],
          missingId: current.variableId,
        };
        cache.set(currentKey, outcome);
        break;
      }

      if (!Object.hasOwn(variable.valuesByMode, current.modeId)) {
        outcome = {
          status: "missing-mode",
          aliasChain: [current.variableId],
          missingId: current.variableId,
        };
        cache.set(currentKey, outcome);
        break;
      }

      const rawValue = variable.valuesByMode[current.modeId];
      if (rawValue === undefined) {
        throw new AliasResolutionContractError(
          "Alias resolution values must be canonical JSON values.",
        );
      }

      if (isMissingModeValue(rawValue)) {
        outcome = {
          status: "missing-mode",
          aliasChain: [current.variableId],
          missingId: current.variableId,
        };
        cache.set(currentKey, outcome);
        break;
      }

      if (!isVariableAliasValue(rawValue)) {
        outcome = {
          status: "resolved",
          resolved: rawValue,
          aliasChain: [current.variableId],
        };
        cache.set(currentKey, outcome);
        break;
      }

      const target = byId.get(rawValue.variableId);
      if (target === undefined) {
        current = {
          variableId: rawValue.variableId,
          modeId: current.modeId,
        };
        continue;
      }

      const nextMode = targetMode(
        variable,
        current.modeId,
        target,
        modeContext,
      );
      if (nextMode.kind === "requires-consumer-context") {
        outcome = {
          status: "requires-consumer-context",
          aliasChain: [current.variableId, target.source.id],
          contextCollectionId: target.collectionId,
        };
        cache.set(currentKey, outcome);
        break;
      }

      current = {
        variableId: target.source.id,
        modeId: nextMode.modeId,
      };
    }

    for (let index = states.length - 1; index >= 0; index -= 1) {
      const state = states[index];
      if (state === undefined) {
        continue;
      }
      const key = stateKey(state);
      const stateResult = cache.get(key);
      if (stateResult !== undefined) {
        outcome = stateResult;
        continue;
      }
      if (outcome === undefined) {
        throw new AliasResolutionContractError(
          "Alias resolution failed to retain its terminal result.",
        );
      }
      outcome = {
        ...outcome,
        aliasChain: [state.variableId, ...outcome.aliasChain],
      };
      cache.set(key, outcome);
    }

    const result = cache.get(stateKey(start));
    if (result === undefined) {
      throw new AliasResolutionContractError(
        "Alias resolution failed to produce a result for the starting variable.",
      );
    }
    return result;
  };

  const sortedVariables = [...input.variables].sort((left, right) =>
    compareSourceRefs(left.source, right.source),
  );
  const resolvedVariables = sortedVariables.map((variable) => {
    const values = orderedModes(
      modeOrderByCollection.get(variable.collectionId) ?? [],
    ).map((modeId): VariableModeValueIR => {
      const raw = variable.valuesByMode[modeId];
      if (raw === undefined) {
        throw new AliasResolutionContractError(
          "Alias resolution values must be canonical JSON values.",
        );
      }

      const modeContext = new Map(baseModeContext);
      modeContext.set(variable.collectionId, modeId);
      const result = walk(
        { variableId: variable.source.id, modeId },
        modeContext,
      );

      if (result.status === "requires-consumer-context") {
        const collectionId = result.contextCollectionId ?? "unknown-collection";
        const signature = issueSignature([
          "requires-consumer-context",
          variable.source.id,
          modeId,
          collectionId,
        ]);
        issues.set(signature, {
          signature,
          code: DIAGNOSTIC_CODES.variableAliasRequiresConsumerContext,
          severity: "warning",
          message: `Variable alias resolution for mode "${modeId}" requires a consuming node mode for collection "${collectionId}".`,
          source: variable.source,
          modeId,
          causedDataLoss: false,
        });
      } else if (result.status === "missing-reference") {
        const missingId = result.missingId ?? "unknown";
        const signature = issueSignature([
          "missing-reference",
          variable.source.id,
          modeId,
          missingId,
        ]);
        issues.set(signature, {
          signature,
          code: DIAGNOSTIC_CODES.variableAliasMissingReference,
          severity: "warning",
          message: `Variable alias target "${missingId}" is not accessible for mode "${modeId}".`,
          source: variable.source,
          modeId,
          causedDataLoss: true,
        });
      } else if (result.status === "missing-mode") {
        const missingId = result.missingId ?? "unknown";
        const signature = issueSignature([
          "missing-mode",
          variable.source.id,
          modeId,
          missingId,
        ]);
        issues.set(signature, {
          signature,
          code: DIAGNOSTIC_CODES.variableAliasMissingMode,
          severity: "warning",
          message: `Variable "${missingId}" has no accessible raw value for mode "${modeId}".`,
          source: variable.source,
          modeId,
          causedDataLoss: true,
        });
      } else if (result.status === "cycle") {
        const cycle = result.cycle ?? [];
        const canonicalSourceId = cycle[0]?.variableId ?? variable.source.id;
        const canonicalSource =
          byId.get(canonicalSourceId)?.source ?? variable.source;
        const signature = issueSignature([
          "cycle",
          cycle.map((state) => [state.variableId, state.modeId]),
        ]);
        issues.set(signature, {
          signature,
          code: DIAGNOSTIC_CODES.variableAliasCycle,
          severity: "error",
          message: `Variable alias cycle detected: ${formatCycle(cycle)}.`,
          source: canonicalSource,
          modeId: cycle[0]?.modeId ?? modeId,
          causedDataLoss: true,
        });
      }

      return {
        modeId,
        raw,
        status: result.status,
        ...(result.resolved === undefined ? {} : { resolved: result.resolved }),
        aliasChain: result.aliasChain,
        resolutionContext: [...modeContext.entries()]
          .sort(([left], [right]) => compareStrings(left, right))
          .map(([collectionId, contextModeId]) => ({
            collectionId,
            modeId: contextModeId,
          })),
      };
    });

    return {
      source: variable.source,
      values,
    };
  });

  const sortedIssues = [...issues.values()].sort((left, right) =>
    compareStrings(left.signature, right.signature),
  );
  for (const issue of sortedIssues) {
    input.diagnostics.add({
      code: issue.code,
      severity: issue.severity,
      message: issue.message,
      phase: "alias-resolution",
      source: issue.source,
      propertyPath: `$.valuesByMode[${JSON.stringify(issue.modeId)}]`,
      causedDataLoss: issue.causedDataLoss,
    });
  }

  return {
    variables: resolvedVariables,
    diagnostics: input.diagnostics.listSince(diagnosticStart),
  };
}
