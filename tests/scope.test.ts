import { describe, expect, it } from "vitest";

import {
  DIAGNOSTIC_CODES,
  DiagnosticBag,
  type DiagnosticCode,
} from "../src/shared/diagnostics";
import {
  resolveSelectionRoots,
  SelectionScopeError,
} from "../src/shared/scope";

interface SyntheticScopeNode {
  readonly id: string;
  readonly name: string;
  parent: SyntheticScopeNode | null;
  children: SyntheticScopeNode[];
}

function appendNode(
  parent: SyntheticScopeNode | null,
  id: string,
): SyntheticScopeNode {
  const node: SyntheticScopeNode = {
    id,
    name: `Synthetic ${id}`,
    parent,
    children: [],
  };
  parent?.children.push(node);
  return node;
}

function snapshotTree(root: SyntheticScopeNode): readonly object[] {
  const snapshot: object[] = [];
  const visit = (node: SyntheticScopeNode): void => {
    snapshot.push({
      id: node.id,
      parentId: node.parent?.id ?? null,
      childIds: node.children.map((child) => child.id),
    });
    node.children.forEach(visit);
  };
  visit(root);
  return snapshot;
}

describe("current-selection scope resolution", () => {
  it("resolves table-driven empty, ordered, duplicate, and nested inputs without mutation", () => {
    const documentNode = appendNode(null, "document:synthetic");
    const firstPage = appendNode(documentNode, "page:first");
    const secondPage = appendNode(documentNode, "page:second");
    const ancestor = appendNode(firstPage, "node:ancestor");
    const nested = appendNode(ancestor, "node:nested");
    const firstSibling = appendNode(firstPage, "node:first-sibling");
    const secondSibling = appendNode(firstPage, "node:second-sibling");
    const laterPageRoot = appendNode(secondPage, "node:later-page-root");

    const cases: readonly {
      readonly name: string;
      readonly selection: readonly SyntheticScopeNode[];
      readonly expectedRootIds?: readonly string[];
      readonly expectedDiagnosticCodes?: readonly DiagnosticCode[];
      readonly emptyError?: true;
      readonly preservedDescendant?: SyntheticScopeNode;
    }[] = [
      {
        name: "empty",
        selection: [],
        emptyError: true,
      },
      {
        name: "single",
        selection: [secondSibling],
        expectedRootIds: [secondSibling.id],
      },
      {
        name: "reversed multiple",
        selection: [secondSibling, firstSibling],
        expectedRootIds: [firstSibling.id, secondSibling.id],
      },
      {
        name: "document order across parents",
        selection: [laterPageRoot, firstSibling],
        expectedRootIds: [firstSibling.id, laterPageRoot.id],
      },
      {
        name: "duplicate defensive input",
        selection: [firstSibling, firstSibling],
        expectedRootIds: [firstSibling.id],
        expectedDiagnosticCodes: [DIAGNOSTIC_CODES.scopeDuplicateRoot],
      },
      {
        name: "nested defensive input",
        selection: [nested, ancestor],
        expectedRootIds: [ancestor.id],
        expectedDiagnosticCodes: [DIAGNOSTIC_CODES.scopeNestedRoot],
        preservedDescendant: nested,
      },
    ];

    for (const testCase of cases) {
      const input = Object.freeze([...testCase.selection]);
      const inputBefore = [...input];
      const treeBefore = snapshotTree(documentNode);
      const diagnostics = new DiagnosticBag("scope-test");

      if (testCase.emptyError === true) {
        expect(
          () => resolveSelectionRoots(input, diagnostics),
          testCase.name,
        ).toThrowError(SelectionScopeError);
      } else {
        const result = resolveSelectionRoots(input, diagnostics);
        expect(
          result.roots.map((root) => root.id),
          testCase.name,
        ).toEqual(testCase.expectedRootIds);
        expect(
          result.diagnostics.map((diagnostic) => diagnostic.code),
          testCase.name,
        ).toEqual(testCase.expectedDiagnosticCodes ?? []);

        if (testCase.preservedDescendant !== undefined) {
          expect(result.roots, testCase.name).toEqual([ancestor]);
          expect(ancestor.children, testCase.name).toContain(
            testCase.preservedDescendant,
          );
        }
      }

      expect(input, `${testCase.name}: input array`).toEqual(inputBefore);
      expect(
        snapshotTree(documentNode),
        `${testCase.name}: source tree`,
      ).toEqual(treeBefore);
    }
  });
});
