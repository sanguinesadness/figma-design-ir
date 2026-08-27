import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import type { ContainerNodeIR, PaintIR } from "../src/shared/ir";
import {
  CanonicalSerializationError,
  ensureOneFinalNewline,
  serializeCanonicalJson,
  sortUnorderedComponentDefinitions,
  sortUnorderedComponentDependencies,
  sortUnorderedSourceRefs,
} from "../src/shared/serialization";
import {
  buildRandomizableJsonObject,
  buildSyntheticDesignSystemFixture,
  SYNTHETIC_UNICODE_TEXT,
  type SyntheticDesignSystemFixture,
} from "./fixtures/synthetic-design-system";

function seededShuffle<T>(values: readonly T[], seed: number): T[] {
  const shuffled = [...values];
  let state = seed >>> 0;
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    const target = state % (index + 1);
    const currentValue = shuffled[index];
    const targetValue = shuffled[target];
    if (currentValue !== undefined && targetValue !== undefined) {
      shuffled[index] = targetValue;
      shuffled[target] = currentValue;
    }
  }
  return shuffled;
}

function shuffleObjectInsertionOrder(value: unknown, seed: number): unknown {
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      shuffleObjectInsertionOrder(item, seed + index + 1),
    );
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }

  const result = Object.create(null) as Record<string, unknown>;
  const entries = seededShuffle(Object.entries(value), seed);
  for (const [index, [key, child]] of entries.entries()) {
    result[key] = shuffleObjectInsertionOrder(child, seed + index + 17);
  }
  return result;
}

describe("canonical serialization", () => {
  it("is byte-identical for independently built copies of one fixture", () => {
    const first = serializeCanonicalJson(buildSyntheticDesignSystemFixture());
    const second = serializeCanonicalJson(buildSyntheticDesignSystemFixture());

    expect(Buffer.from(first)).toEqual(Buffer.from(second));
  });

  it("is unchanged by recursively randomized object insertion order", () => {
    const fixture = buildRandomizableJsonObject();
    const expected = serializeCanonicalJson(fixture);

    for (const seed of [1, 7, 41, 9_973]) {
      expect(
        serializeCanonicalJson(shuffleObjectInsertionOrder(fixture, seed)),
      ).toBe(expected);
    }
  });

  it("preserves semantic page, selection, mode, reaction, fill, and stroke order", () => {
    const fixture = JSON.parse(
      serializeCanonicalJson(buildSyntheticDesignSystemFixture()),
    ) as SyntheticDesignSystemFixture;
    const root = fixture.pages[0]?.normalizedTrees[0] as ContainerNodeIR;

    expect(fixture.document.pages.map((page) => page.id)).toEqual([
      "page:z-specimens",
      "page:a-journey",
    ]);
    expect(fixture.document.selectedRootIds).toEqual([
      "node:specimens-root",
      "node:signal-card-set",
    ]);
    expect(
      fixture.pages[0]?.normalizedTrees.map((tree) => tree.source.id),
    ).toEqual(["node:specimens-root", "node:page-note"]);
    expect(
      fixture.variables.collections[0]?.modes.map((mode) => mode.id),
    ).toEqual(["mode:night", "mode:day"]);
    expect(fixture.interactions.map((reaction) => reaction.id)).toEqual([
      "reaction:open-journey",
      "reaction:set-accent",
      "reaction:future-action",
    ]);
    const fills = root.visual?.fills as readonly PaintIR[];
    const strokes = root.visual?.strokes as readonly PaintIR[];
    expect(fills[0]?.paintType).toBe("SOLID");
    expect(strokes[0]?.paintType).toBe("SOLID");
  });

  it("sorts only explicitly unordered references by source ID then name", () => {
    const sorted = sortUnorderedSourceRefs([
      { kind: "style", id: "source:b", name: "First" },
      { kind: "variable", id: "source:a", name: "Zulu" },
      { kind: "variable", id: "source:a", name: "Alpha" },
    ]);

    expect(
      sorted.map((reference) => `${reference.id}/${reference.name}`),
    ).toEqual(["source:a/Alpha", "source:a/Zulu", "source:b/First"]);

    const components = buildSyntheticDesignSystemFixture().components;
    expect(
      sortUnorderedComponentDefinitions([...components.definitions].reverse()),
    ).toEqual(components.definitions);
    expect(
      sortUnorderedComponentDependencies(
        [...components.dependencies].reverse(),
      ),
    ).toEqual(components.dependencies);
  });

  it("preserves invented Unicode and exact text formatting policies", () => {
    const serialized = serializeCanonicalJson({
      unicode: SYNTHETIC_UNICODE_TEXT,
      negativeZero: -0,
      nested: { second: 2, first: 1 },
    });
    const bytes = Buffer.from(serialized, "utf8");
    const roundTrip = bytes.toString("utf8");
    const parsed = JSON.parse(roundTrip) as {
      readonly negativeZero: number;
      readonly unicode: string;
    };

    expect(bytes.subarray(0, 3)).not.toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(parsed.unicode).toBe(SYNTHETIC_UNICODE_TEXT);
    expect(Object.is(parsed.negativeZero, -0)).toBe(true);
    expect(serialized).toContain('\n  "negativeZero": -0,\n');
    expect(serialized.endsWith("\n")).toBe(true);
    expect(serialized.endsWith("\n\n")).toBe(false);
    expect(ensureOneFinalNewline("# Synthetic\n\n")).toBe("# Synthetic\n");
    expect(ensureOneFinalNewline("<svg></svg>\r\n")).toBe("<svg></svg>\n");

    const symbolKeyed = { visible: "retained" } as Record<
      string | symbol,
      unknown
    >;
    symbolKeyed[Symbol("synthetic-key")] = "must not disappear";
    expect(() => serializeCanonicalJson(symbolKeyed)).toThrow(
      CanonicalSerializationError,
    );

    const hostileProxy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("synthetic private proxy detail");
        },
      },
    );
    expect(() => serializeCanonicalJson(hostileProxy)).toThrow(
      CanonicalSerializationError,
    );
    try {
      serializeCanonicalJson(hostileProxy);
    } catch (error) {
      expect(error).toBeInstanceOf(CanonicalSerializationError);
      expect((error as Error).message).not.toContain("synthetic private");
    }
  });
});
