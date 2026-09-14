import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  archivePaths,
  requireSnapshotId,
  utf8ByteLength,
} from "../src/shared/archive";
import { summarizeDiagnostics } from "../src/shared/diagnostics";
import {
  escapeMarkdown,
  MAX_MARKDOWN_BYTES,
  projectComponentMarkdown,
  projectGlobalMarkdown,
  projectPageMarkdown,
  projectSelectionPageMarkdown,
  splitMarkdownArtifact,
  type MarkdownArtifact,
} from "../src/shared/minimal-markdown";
import { buildSyntheticDesignSystemFixture } from "./fixtures/synthetic-design-system";

function resolveLinkPath(from: string, target: string): string {
  return path.posix.normalize(
    path.posix.join(path.posix.dirname(from), target),
  );
}

function markdownLinks(text: string): readonly string[] {
  return [...text.matchAll(/\]\(<([^>]+)>\)/g)].map((match) => match[1]!);
}

function canonicalPaths(
  snapshotId: ReturnType<typeof requireSnapshotId>,
): Set<string> {
  return new Set([
    archivePaths.manifest(snapshotId),
    archivePaths.diagnostics(snapshotId),
    archivePaths.irDocument(snapshotId),
    archivePaths.irVariables(snapshotId),
    archivePaths.irStyles(snapshotId),
    archivePaths.irComponents(snapshotId),
    archivePaths.irNodePage(snapshotId, "page:z-specimens"),
    archivePaths.irNodePage(snapshotId, "page:a-journey"),
    archivePaths.irNodeRoot(snapshotId, "node:specimens-root"),
    archivePaths.rawRestPage(snapshotId, "page:z-specimens"),
    archivePaths.rawRestPage(snapshotId, "page:a-journey"),
    archivePaths.rasterAsset(snapshotId, "a".repeat(64), "png"),
    archivePaths.vectorAsset(snapshotId, "node:orbit-mark"),
    archivePaths.preview(snapshotId, "node:journey-destination"),
  ]);
}

describe("agent-readable Markdown projection", () => {
  it("is deterministic, keeps canonical recovery links, and closes every relative link", () => {
    const fixture = buildSyntheticDesignSystemFixture();
    const snapshotId = requireSnapshotId("synthetic-design-ir");
    const componentSummaryIds = new Set(
      fixture.components.definitions.map((definition) => definition.source.id),
    );
    const build = (): readonly MarkdownArtifact[] => [
      ...fixture.components.definitions.flatMap((definition) =>
        projectComponentMarkdown(snapshotId, definition, undefined, {
          dependencies: fixture.components.dependencies,
          componentSummaryIds,
        }),
      ),
      ...fixture.pages.flatMap((page) =>
        projectPageMarkdown(snapshotId, page, componentSummaryIds),
      ),
      ...projectGlobalMarkdown(
        snapshotId,
        fixture.document,
        fixture.variables,
        fixture.styles,
        fixture.components,
        fixture.pages.map((page) =>
          archivePaths.agentPage(snapshotId, page.source.id),
        ),
        summarizeDiagnostics(fixture.diagnostics),
      ),
    ];
    const first = build();
    const second = build();

    expect(first).toEqual(second);
    expect(
      first.find((entry) => entry.path.endsWith("agent/index.md"))?.text,
    ).toContain("## Reading strategy");
    expect(
      first.find((entry) => entry.path.endsWith("agent/index.md"))?.text,
    ).toContain("## Snapshot identity and completeness");
    expect(
      first.find((entry) => entry.path.endsWith("agent/index.md"))?.text,
    ).not.toContain("Document diagnostic IDs:");
    expect(
      first.find((entry) => entry.path.endsWith("agent/index.md"))?.text,
    ).toContain("Open the complete diagnostic list");
    expect(
      first.find((entry) => entry.path.endsWith("agent/tokens.md"))?.text,
    ).toContain("raw:");
    expect(first.map((entry) => entry.text).join("\n")).toContain(
      "Canonical IR artifact",
    );

    const paths = canonicalPaths(snapshotId);
    for (const entry of first) paths.add(entry.path);
    for (const entry of first) {
      expect(utf8ByteLength(entry.text)).toBeLessThanOrEqual(
        MAX_MARKDOWN_BYTES,
      );
      expect(entry.text.endsWith("\n")).toBe(true);
      for (const target of markdownLinks(entry.text)) {
        expect(paths.has(resolveLinkPath(entry.path, target))).toBe(true);
      }
    }

    const unavailablePageIndex = projectGlobalMarkdown(
      snapshotId,
      fixture.document,
      fixture.variables,
      fixture.styles,
      fixture.components,
      [
        undefined,
        archivePaths.agentPage(snapshotId, fixture.pages[1]!.source.id),
      ],
      summarizeDiagnostics(fixture.diagnostics),
    ).find((entry) => entry.path === archivePaths.agentPageIndex(snapshotId));
    expect(unavailablePageIndex?.text).toContain(
      "canonical page summary unavailable",
    );
    expect(unavailablePageIndex?.text).not.toContain(
      "agent/pages/page%3Az-specimens.md",
    );

    const selectionPage = projectSelectionPageMarkdown(
      snapshotId,
      fixture.pages[0]!.source,
      fixture.roots,
      componentSummaryIds,
    )[0]!;
    expect(
      markdownLinks(selectionPage.text).map((target) =>
        resolveLinkPath(selectionPage.path, target),
      ),
    ).toContain(
      archivePaths.irNodeRoot(snapshotId, fixture.roots[0]!.source.id),
    );
  });

  it("escapes hostile user-controlled Markdown and never turns it into a link target", () => {
    const escaped = escapeMarkdown(
      "# heading\n[break](https://invalid.example) `code` | -",
    );

    expect(escaped).toBe(
      "\\# heading \\[break\\]\\(https\\:\\/\\/invalid\\.example\\) \\`code\\` \\| \\-",
    );
    expect(escaped).not.toContain("](");
    expect(escaped).not.toContain("https://");
  });

  it("splits oversized Markdown deterministically while preserving the canonical index path", () => {
    const snapshotId = requireSnapshotId("markdown-split");
    const pathValue = archivePaths.agentTokens(snapshotId);
    const blocks = Array.from(
      { length: 30 },
      (_, index) => `## Token ${String(index)}\n\n${"x".repeat(48 * 1024)}`,
    );
    const artifacts = splitMarkdownArtifact(pathValue, "Tokens", blocks);

    expect(artifacts.length).toBeGreaterThan(2);
    expect(artifacts[0]?.path).toBe(pathValue);
    expect(artifacts[0]?.text).toContain("Part 1");
    expect(artifacts.map((artifact) => artifact.path)).toEqual(
      [...artifacts].map((artifact) => artifact.path),
    );
    for (const artifact of artifacts) {
      expect(utf8ByteLength(artifact.text)).toBeLessThanOrEqual(
        MAX_MARKDOWN_BYTES,
      );
    }

    const singleBlock = splitMarkdownArtifact(pathValue, "Tokens", [
      `# One giant generated block\n\n${"y".repeat(MAX_MARKDOWN_BYTES + 64 * 1024)}`,
    ]);
    expect(singleBlock.length).toBeGreaterThan(2);
    for (const artifact of singleBlock) {
      expect(utf8ByteLength(artifact.text)).toBeLessThanOrEqual(
        MAX_MARKDOWN_BYTES,
      );
    }
  });

  it("keeps component prose bounded and links precise component data instead of replacing it", () => {
    const fixture = buildSyntheticDesignSystemFixture();
    const snapshotId = requireSnapshotId("synthetic-design-ir");
    const sourceDefinition = fixture.components.definitions.find(
      (candidate) => candidate.componentKind === "component-set",
    )!;
    const definition = {
      ...sourceDefinition,
      definitionArtifact: {
        path: archivePaths.irComponentDefinition(
          snapshotId,
          sourceDefinition.source.id,
        ),
        mediaType: "application/json",
      },
    };
    const artifact = {
      kind: "design-ir-component-definition" as const,
      schemaVersion: fixture.document.schemaVersion,
      source: definition.source,
      dependencyRefs: fixture.pages[0]!.dependencyRefs,
      normalizedTree: fixture.pages[0]!.normalizedTrees[0]!,
      reactions: fixture.interactions,
      assets: fixture.assets,
      coverage: fixture.pages[0]!.coverage,
      diagnosticIds: [],
    };
    const componentSummaryIds = new Set(
      fixture.components.definitions.map((candidate) => candidate.source.id),
    );
    const artifacts = projectComponentMarkdown(
      snapshotId,
      definition,
      artifact,
      {
        dependencies: fixture.components.dependencies,
        componentSummaryIds,
      },
    );

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.text).toContain("Canonical component index");
    expect(artifacts[0]?.text).toContain("canonical component definition");
    expect(artifacts[0]?.text).toContain("Show orbit");
    expect(artifacts[0]?.text).toContain("Typography values");
    expect(artifacts[0]?.text).toContain("Paint and color values");
    expect(artifacts[0]?.text).toContain("component summary");
    expect(artifacts[0]?.text).toContain("page index");
  });
});
