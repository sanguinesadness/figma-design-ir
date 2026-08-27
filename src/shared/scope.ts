import {
  DIAGNOSTIC_CODES,
  type Diagnostic,
  type DiagnosticBag,
} from "./diagnostics";
import type { SourceRef } from "./ir";

export interface ScopeTreeNode {
  readonly id: string;
  readonly name?: string;
  readonly parent: ScopeTreeParent | null;
}

export interface ScopeTreeParent extends ScopeTreeNode {
  readonly children: readonly ScopeTreeNode[];
}

export interface SelectionResolution<T extends ScopeTreeNode> {
  readonly roots: readonly T[];
  readonly diagnostics: readonly Diagnostic[];
}

export class SelectionScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SelectionScopeError";
  }
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

function compareTreePaths(
  left: readonly number[],
  right: readonly number[],
): number {
  const sharedLength = Math.min(left.length, right.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const leftIndex = left[index];
    const rightIndex = right[index];
    if (leftIndex === undefined || rightIndex === undefined) {
      throw new SelectionScopeError(
        "A selected node has an invalid document tree path.",
      );
    }
    if (leftIndex !== rightIndex) {
      return leftIndex - rightIndex;
    }
  }
  return left.length - right.length;
}

function documentTreePath(node: ScopeTreeNode): readonly number[] {
  const reversedPath: number[] = [];
  const visited = new Set<ScopeTreeNode>();
  let current: ScopeTreeNode = node;

  while (current.parent !== null) {
    if (visited.has(current)) {
      throw new SelectionScopeError(
        "A selected node has a cyclic document ancestry.",
      );
    }
    visited.add(current);

    const childIndex = current.parent.children.indexOf(current);
    if (childIndex < 0) {
      throw new SelectionScopeError(
        "A selected node is absent from its parent child order.",
      );
    }
    reversedPath.push(childIndex);
    current = current.parent;
  }

  return reversedPath.reverse();
}

function nodeSource(node: ScopeTreeNode): SourceRef {
  return {
    kind: "node",
    id: node.id,
    ...(node.name === undefined ? {} : { name: node.name }),
  };
}

function selectedAncestor(
  node: ScopeTreeNode,
  selectedIds: ReadonlySet<string>,
): ScopeTreeNode | undefined {
  let current = node.parent;
  const visited = new Set<ScopeTreeNode>();
  while (current !== null) {
    if (visited.has(current)) {
      throw new SelectionScopeError(
        "A selected node has a cyclic document ancestry.",
      );
    }
    visited.add(current);
    if (selectedIds.has(current.id)) {
      return current;
    }
    current = current.parent;
  }
  return undefined;
}

/**
 * Resolves Plugin API selection input into deterministic document/canvas order.
 * Duplicate and nested inputs are defensive adapter guards: current Figma typings
 * guarantee that PageNode.selection itself never contains an ancestor and child.
 */
export function resolveSelectionRoots<T extends ScopeTreeNode>(
  selection: readonly T[],
  diagnostics: DiagnosticBag,
): SelectionResolution<T> {
  if (selection.length === 0) {
    throw new SelectionScopeError("Current selection is empty.");
  }

  const diagnosticStart = diagnostics.size();
  const paths = new Map<T, readonly number[]>();
  for (const node of selection) {
    paths.set(node, documentTreePath(node));
  }

  const ordered = [...selection].sort((left, right) => {
    const leftPath = paths.get(left);
    const rightPath = paths.get(right);
    if (leftPath === undefined || rightPath === undefined) {
      throw new SelectionScopeError(
        "A selected node path could not be resolved.",
      );
    }
    return (
      compareTreePaths(leftPath, rightPath) || compareStrings(left.id, right.id)
    );
  });

  const allSelectedIds = new Set(ordered.map((node) => node.id));
  const retainedIds = new Set<string>();
  const roots: T[] = [];

  for (const node of ordered) {
    if (retainedIds.has(node.id)) {
      diagnostics.add({
        code: DIAGNOSTIC_CODES.scopeDuplicateRoot,
        severity: "info",
        message: "A duplicate selected root was removed defensively.",
        phase: "scope",
        source: nodeSource(node),
        causedDataLoss: false,
      });
      continue;
    }

    const ancestor = selectedAncestor(node, allSelectedIds);
    if (ancestor !== undefined) {
      diagnostics.add({
        code: DIAGNOSTIC_CODES.scopeNestedRoot,
        severity: "info",
        message:
          "A selected root nested under another selected root was removed defensively; its subtree remains in the ancestor export.",
        phase: "scope",
        source: nodeSource(node),
        causedDataLoss: false,
      });
      continue;
    }

    retainedIds.add(node.id);
    roots.push(node);
  }

  return {
    roots,
    diagnostics: diagnostics.listSince(diagnosticStart),
  };
}
