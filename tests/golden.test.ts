import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { serializeCanonicalJson } from "../src/shared/serialization";
import {
  buildSyntheticGoldenArtifact,
  SYNTHETIC_UNICODE_TEXT,
} from "./fixtures/synthetic-design-system";

describe("synthetic Design IR golden", () => {
  it("matches the reviewed canonical artifact and covers each high-risk contract family", async () => {
    const expected = await readFile(
      new URL("./golden/synthetic-design-ir.json", import.meta.url),
      "utf8",
    );
    const actual = serializeCanonicalJson(buildSyntheticGoldenArtifact());
    const parsed = JSON.parse(actual) as {
      readonly contract: { readonly provenance: string };
      readonly document: {
        readonly counts: {
          readonly localVariables: { readonly coverage?: string };
          readonly localStyles: { readonly coverage?: string };
          readonly localComponents: { readonly coverage?: string };
        };
      };
      readonly nodes: readonly {
        readonly samples: readonly {
          readonly family: string;
          readonly text?: { readonly characters: string };
        }[];
      }[];
      readonly styles: readonly { readonly styleType: string }[];
      readonly interactions: readonly {
        readonly actions: readonly { readonly actionType: string }[];
      }[];
      readonly assets: readonly { readonly assetKind: string }[];
      readonly variables: {
        readonly variables: readonly {
          readonly values: readonly { readonly status: string }[];
        }[];
      };
      readonly diagnostics: readonly {
        readonly id: string;
        readonly code: string;
        readonly propertyPath?: string;
      }[];
    };

    expect(actual).toBe(expected);
    expect(parsed.contract.provenance).toContain("Entirely invented synthetic");
    expect(parsed.document.counts).toMatchObject({
      localVariables: { coverage: "file-local" },
      localStyles: { coverage: "file-local" },
      localComponents: { coverage: "selected-reachable" },
    });
    expect(
      new Set(
        parsed.nodes.flatMap((page) => page.samples.map((node) => node.family)),
      ),
    ).toEqual(
      new Set([
        "container",
        "text",
        "vector",
        "component",
        "instance",
        "leaf",
        "unknown",
      ]),
    );
    expect(
      parsed.nodes
        .flatMap((page) => page.samples)
        .find((node) => node.family === "text")?.text?.characters,
    ).toBe(SYNTHETIC_UNICODE_TEXT);
    expect(parsed.styles.map((style) => style.styleType)).toEqual([
      "effect",
      "grid",
      "paint",
      "text",
    ]);
    expect(
      parsed.interactions.map((interaction) =>
        interaction.actions.map((action) => action.actionType),
      ),
    ).toEqual([["navigate", "set-variable"], ["set-variable"], ["unknown"]]);
    expect(parsed.assets.map((asset) => asset.assetKind)).toEqual([
      "raster",
      "vector",
    ]);
    expect(
      new Set(
        parsed.variables.variables.flatMap((variable) =>
          variable.values.map((value) => value.status),
        ),
      ),
    ).toEqual(new Set(["resolved", "cycle", "missing-reference"]));
    expect(new Set(parsed.diagnostics.map((item) => item.id)).size).toBe(
      parsed.diagnostics.length,
    );
    expect(
      parsed.diagnostics.find(
        (item) => item.code === "INTERACTION_UNSUPPORTED_ACTION",
      )?.propertyPath,
    ).toBe("$.reactions[2].actions[0]");
  });
});
