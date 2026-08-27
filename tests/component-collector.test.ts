import { describe, expect, it } from "vitest";

import {
  ComponentCollectionSession,
  collectComponents,
  type ComponentCollectorAdapter,
  type ComponentCollectionProgress,
  type CollectedComponents,
} from "../src/main/collect-components";
import {
  ExportCancellationToken,
  ExportCancelledError,
} from "../src/main/cancellation";
import { DIAGNOSTIC_CODES, DiagnosticBag } from "../src/shared/diagnostics";
import { serializeCanonicalJson } from "../src/shared/serialization";

declare global {
  interface SceneNode {
    readonly id: string;
    readonly name: string;
  }
}

interface SyntheticNode {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly [property: string]: unknown;
}

function scene(node: SyntheticNode): SceneNode {
  return node;
}

describe("Component and instance collection", () => {
  it("retains accessible closure deterministically without touching the throwing variant getter", async () => {
    const hostileText = "INVENTED_VARIANT_GETTER_TEXT_MUST_NOT_ESCAPE";
    let variantGetterReads = 0;
    let standaloneGetterReads = 0;
    const page = { id: "page:synthetic", name: "Synthetic page", type: "PAGE" };

    const icon = {
      id: "component:icon",
      name: "Invented icon",
      type: "COMPONENT",
      key: "key:invented-icon",
      remote: false,
      parent: page,
      variantProperties: null,
      description: "Invented standalone icon.",
      descriptionMarkdown: "Invented **standalone** icon.",
      documentationLinks: [{ uri: "https://synthetic.invalid/icon" }],
      children: [],
      componentPropertyReferences: null,
    } satisfies SyntheticNode;
    Object.defineProperty(icon, "componentPropertyDefinitions", {
      enumerable: true,
      get: () => {
        standaloneGetterReads += 1;
        return {
          "Visible#opaque:icon": {
            type: "BOOLEAN",
            defaultValue: true,
          },
        };
      },
    });

    const nestedInstance = {
      id: "instance:nested",
      name: "Invented nested instance",
      type: "INSTANCE",
      componentProperties: {
        "Icon swap#opaque:7": {
          type: "INSTANCE_SWAP",
          value: "component:icon",
          preferredValues: [{ type: "COMPONENT", key: "key:invented-icon" }],
          boundVariables: {
            value: { type: "VARIABLE_ALIAS", id: "variable:instance-swap" },
          },
        },
      },
      componentPropertyReferences: {
        visible: "Visible#opaque:icon",
        mainComponent: "Icon swap#opaque:7",
      },
      overrides: [
        {
          id: "node:nested-label",
          overriddenFields: ["text", "fillStyleId"],
        },
      ],
      exposedInstances: [{ id: "instance:exposed" }],
      isExposedInstance: true,
      scaleFactor: 1.25,
      getMainComponentAsync: () => Promise.resolve(icon),
      children: [],
    } satisfies SyntheticNode;
    const slot = {
      id: "slot:invented",
      name: "Invented component slot",
      type: "SLOT",
      componentPropertyReferences: {
        visible: "Slot#opaque:9",
      },
      limitViolations: ["HAS_NON_PREFERRED", "BELOW_MIN"],
      children: [],
    } satisfies SyntheticNode;

    const set = {
      id: "component:set",
      name: "Invented control set",
      type: "COMPONENT_SET",
      key: "key:invented-set",
      remote: false,
      parent: page,
      variantProperties: null,
      componentPropertyDefinitions: {
        State: {
          type: "VARIANT",
          defaultValue: "Quiet",
          variantOptions: ["Quiet", "Loud"],
        },
        "Icon swap#opaque:7": {
          type: "INSTANCE_SWAP",
          defaultValue: "component:icon",
          preferredValues: [{ type: "COMPONENT", key: "key:invented-icon" }],
          description: "Invented opaque swap property.",
          slotSettings: {
            stretchChildOnInsert: true,
            displayEmptyByDefault: false,
            minChildren: 0,
            maxChildren: 1,
            allowPreferredValuesOnly: true,
          },
          boundVariables: {
            defaultValue: {
              type: "VARIABLE_ALIAS",
              id: "variable:definition-swap",
            },
          },
        },
      },
      description: "Invented variant set.",
      descriptionMarkdown: "Invented **variant set**.",
      documentationLinks: [{ uri: "https://synthetic.invalid/set" }],
      children: [] as SyntheticNode[],
      componentPropertyReferences: null,
    } satisfies SyntheticNode;

    const variant = {
      id: "component:variant",
      name: "State=Quiet",
      type: "COMPONENT",
      key: "key:invented-variant",
      remote: false,
      parent: set,
      variantProperties: { State: "Quiet" },
      description: "Invented quiet variant.",
      descriptionMarkdown: "Invented quiet variant.",
      documentationLinks: [],
      children: [nestedInstance, slot],
      componentPropertyReferences: null,
    } satisfies SyntheticNode;
    Object.defineProperty(variant, "componentPropertyDefinitions", {
      enumerable: true,
      get: () => {
        variantGetterReads += 1;
        throw new Error(hostileText);
      },
    });
    Object.defineProperty(set, "defaultVariant", {
      enumerable: true,
      value: variant,
    });
    set.children.push(variant);

    const selectedInstance = {
      id: "instance:selected",
      name: "Invented selected instance",
      type: "INSTANCE",
      componentProperties: {
        State: { type: "VARIANT", value: "Quiet" },
        "Icon swap#opaque:7": {
          type: "INSTANCE_SWAP",
          value: "component:icon",
          preferredValues: [{ type: "COMPONENT", key: "key:invented-icon" }],
          boundVariables: {
            value: { type: "VARIABLE_ALIAS", id: "variable:selected-swap" },
          },
        },
      },
      componentPropertyReferences: {
        characters: "Label#opaque:2",
      },
      overrides: [
        {
          id: "node:selected-label",
          overriddenFields: ["text", "fills"],
        },
      ],
      exposedInstances: [{ id: "instance:selected-exposed" }],
      scaleFactor: 0.75,
      getMainComponentAsync: () => Promise.resolve(variant),
      children: [],
    } satisfies SyntheticNode;
    const missingInstance = {
      id: "instance:missing",
      name: "Invented inaccessible instance",
      type: "INSTANCE",
      componentProperties: {},
      componentPropertyReferences: null,
      overrides: [],
      exposedInstances: [],
      scaleFactor: 1,
      getMainComponentAsync: () => Promise.resolve(null),
      children: [],
    } satisfies SyntheticNode;
    const root = {
      id: "node:root",
      name: "Invented selection root",
      type: "FRAME",
      componentPropertyReferences: null,
      children: [selectedInstance, missingInstance],
    } satisfies SyntheticNode;
    const adapter: ComponentCollectorAdapter = {
      getNodeByIdAsync: (id) =>
        Promise.resolve(id === icon.id ? scene(icon) : null),
    };

    const collect = async (roots: readonly SceneNode[]) => {
      const diagnostics = new DiagnosticBag("component-collector-test");
      const result = await collectComponents({
        roots,
        adapter,
        diagnostics,
        cancellation: new ExportCancellationToken(),
      });
      return { diagnostics: diagnostics.list(), result };
    };

    const forward = await collect([scene(root)]);
    const reverse = await collect([scene(missingInstance), scene(root)]);

    expect(variantGetterReads).toBe(0);
    expect(standaloneGetterReads).toBeGreaterThan(0);
    expect(
      forward.result.index.definitions.map((item) => item.source.id),
    ).toEqual(["component:icon", "component:set", "component:variant"]);
    expect(
      serializeCanonicalJson({
        definitions: forward.result.index.definitions,
        dependencies: forward.result.index.dependencies,
      }),
    ).toBe(
      serializeCanonicalJson({
        definitions: reverse.result.index.definitions,
        dependencies: reverse.result.index.dependencies,
      }),
    );

    const setDefinition = forward.result.index.definitions.find(
      (item) => item.source.id === set.id,
    );
    const opaqueDefinition = setDefinition?.propertyDefinitions?.find(
      (item) => item.id === "Icon swap#opaque:7",
    );
    expect(setDefinition).toMatchObject({
      componentKind: "component-set",
      defaultVariantId: "component:variant",
      variantAxes: [{ name: "State", values: ["Quiet", "Loud"] }],
      descriptionMarkdown: "Invented **variant set**.",
      documentationLinks: ["https://synthetic.invalid/set"],
    });
    expect(opaqueDefinition).toMatchObject({
      id: "Icon swap#opaque:7",
      name: "Icon swap#opaque:7",
      preferredValues: [{ type: "COMPONENT", key: "key:invented-icon" }],
      description: "Invented opaque swap property.",
      slotSettings: {
        stretchChildOnInsert: true,
        displayEmptyByDefault: false,
        minChildren: 0,
        maxChildren: 1,
        allowPreferredValuesOnly: true,
      },
      variableBindings: [
        {
          propertyPath: "defaultValue",
          variable: { kind: "variable", id: "variable:definition-swap" },
        },
      ],
    });
    expect(forward.result.componentDataByNodeId.get(variant.id)).toMatchObject({
      metadataCoverage: { status: "collected" },
      componentSet: { id: set.id },
      variantProperties: [{ property: "State", value: "Quiet" }],
      propertyDefinitionIds: ["Icon swap#opaque:7", "State"],
    });
    expect(
      forward.result.index.definitions.find(
        (definition) => definition.source.id === variant.id,
      )?.exposedInstanceIds,
    ).toEqual([nestedInstance.id]);

    expect(
      forward.result.instanceDataByNodeId.get(selectedInstance.id),
    ).toMatchObject({
      metadataCoverage: { status: "collected" },
      mainComponent: { id: variant.id },
      overrides: [
        {
          id: "node:selected-label",
          overriddenFields: ["fills", "text"],
        },
      ],
      exposedInstanceIds: ["instance:selected-exposed"],
      scaleFactor: 0.75,
    });
    expect(
      forward.result.instanceDataByNodeId
        .get(selectedInstance.id)
        ?.componentProperties?.find(
          (property) => property.id === "Icon swap#opaque:7",
        ),
    ).toMatchObject({
      preferredValues: [{ type: "COMPONENT", key: "key:invented-icon" }],
      variableBindings: [
        {
          propertyPath: "value",
          variable: { kind: "variable", id: "variable:selected-swap" },
        },
      ],
    });
    expect(
      forward.result.componentPropertyReferencesByNodeId.get(
        selectedInstance.id,
      ),
    ).toEqual({ characters: "Label#opaque:2" });
    expect(forward.result.slotLimitViolationsByNodeId.get(slot.id)).toEqual([
      "BELOW_MIN",
      "HAS_NON_PREFERRED",
    ]);
    expect(
      new Set(
        forward.result.index.dependencies.map(
          (dependency) =>
            `${dependency.from.id}:${dependency.relationship}:${dependency.to.id}`,
        ),
      ),
    ).toEqual(
      new Set([
        "component:set:contains:component:variant",
        "component:set:preferred-value:component:icon",
        "component:set:swap:component:icon",
        "component:variant:instance:component:icon",
        "component:variant:preferred-value:component:icon",
        "component:variant:swap:component:icon",
      ]),
    );
    expect(forward.result.complete).toBe(false);
    expect(
      forward.diagnostics.some(
        (diagnostic) =>
          diagnostic.code ===
            DIAGNOSTIC_CODES.componentMainComponentUnavailable &&
          diagnostic.source?.id === missingInstance.id,
      ),
    ).toBe(true);
    expect(JSON.stringify(forward.diagnostics)).not.toContain(hostileText);

    let releaseMainComponent: ((node: SceneNode) => void) | undefined;
    const pendingInstance = {
      ...selectedInstance,
      id: "instance:cancellation",
      getMainComponentAsync: () =>
        new Promise<SceneNode>((resolve) => {
          releaseMainComponent = resolve;
        }),
    } satisfies SyntheticNode;
    const cancellation = new ExportCancellationToken();
    const pending = collectComponents({
      roots: [scene(pendingInstance)],
      adapter,
      diagnostics: new DiagnosticBag("component-cancel-test"),
      cancellation,
    });
    await Promise.resolve();
    cancellation.cancel();
    if (releaseMainComponent === undefined) {
      throw new Error("The synthetic main-component lookup did not start.");
    }
    releaseMainComponent(scene(icon));
    await expect(pending).rejects.toBeInstanceOf(ExportCancelledError);
  });

  it("reuses opaque definition closure across pages without changing canonical results", async () => {
    const createFixture = () => {
      const page = {
        id: "page:repeated",
        name: "Invented repeated page",
        type: "PAGE",
      };
      const counters = {
        outerMainLookups: 0,
        nestedMainLookups: 0,
        definitionChildrenReads: 0,
        idLookups: 0,
      };
      const leaf = {
        id: "component:leaf",
        name: "Invented leaf",
        type: "COMPONENT",
        key: "key:leaf",
        remote: false,
        parent: page,
        variantProperties: null,
        componentPropertyDefinitions: {},
        componentPropertyReferences: null,
        documentationLinks: [],
        description: "",
        descriptionMarkdown: "",
        children: [],
      } satisfies SyntheticNode;
      const swapTarget = {
        id: "component:swap-target",
        name: "Invented swap target",
        type: "COMPONENT",
        key: "key:swap-target",
        remote: false,
        parent: page,
        variantProperties: null,
        componentPropertyDefinitions: {},
        componentPropertyReferences: null,
        documentationLinks: [],
        description: "",
        descriptionMarkdown: "",
        children: [],
      } satisfies SyntheticNode;
      const nested = {
        id: "instance:nested-repeat",
        name: "Invented nested repeat",
        type: "INSTANCE",
        componentProperties: {},
        componentPropertyReferences: null,
        overrides: [],
        exposedInstances: [],
        isExposedInstance: false,
        scaleFactor: 1,
        getMainComponentAsync: () => {
          counters.nestedMainLookups += 1;
          return Promise.resolve(leaf);
        },
        children: [],
      } satisfies SyntheticNode;
      const definition = {
        id: "component:repeated",
        name: "Invented repeated definition",
        type: "COMPONENT",
        key: "key:repeated",
        remote: false,
        parent: page,
        variantProperties: null,
        componentPropertyDefinitions: {
          Swap: {
            type: "INSTANCE_SWAP",
            defaultValue: swapTarget.id,
          },
        },
        componentPropertyReferences: null,
        documentationLinks: [],
        description: "",
        descriptionMarkdown: "",
      } satisfies Omit<SyntheticNode, "children">;
      Object.defineProperty(definition, "children", {
        enumerable: true,
        get: () => {
          counters.definitionChildrenReads += 1;
          return [nested];
        },
      });
      const makeRepeatedInstance = (pageIndex: number, index: number) => ({
        id: `instance:${pageIndex}:${index}`,
        name: "Invented repeated instance",
        type: "INSTANCE",
        componentProperties: {},
        componentPropertyReferences: null,
        overrides: [],
        exposedInstances: [],
        isExposedInstance: false,
        scaleFactor: 1,
        getMainComponentAsync: () => {
          counters.outerMainLookups += 1;
          return Promise.resolve(definition as unknown as SceneNode);
        },
        children: [],
      });
      const roots = [0, 1].map((pageIndex) =>
        scene({
          id: `root:${pageIndex}`,
          name: "Invented repeated root",
          type: "FRAME",
          componentPropertyReferences: null,
          children: Array.from({ length: 64 }, (_, index) =>
            makeRepeatedInstance(pageIndex, index),
          ),
        }),
      );
      const adapter: ComponentCollectorAdapter = {
        getNodeByIdAsync: (id) => {
          counters.idLookups += 1;
          return Promise.resolve(
            id === swapTarget.id ? scene(swapTarget) : null,
          );
        },
      };
      return { adapter, counters, roots };
    };

    const run = async (reuse: boolean) => {
      const fixture = createFixture();
      const diagnostics = new DiagnosticBag(
        reuse ? "component-reuse" : "component-baseline",
      );
      const session = reuse ? new ComponentCollectionSession() : undefined;
      const progress: ComponentCollectionProgress[] = [];
      const pages: CollectedComponents[] = [];
      for (const root of fixture.roots) {
        pages.push(
          await collectComponents({
            roots: [root],
            adapter: fixture.adapter,
            diagnostics,
            cancellation: new ExportCancellationToken(),
            ...(session === undefined ? {} : { session }),
            ...(reuse
              ? {
                  onProgress: (item: ComponentCollectionProgress) =>
                    progress.push(item),
                }
              : {}),
          }),
        );
      }
      const definitions = new Map<string, unknown>();
      const dependencies = new Map<string, unknown>();
      const dependencyRefs = new Map<string, unknown>();
      const instances = new Map<string, unknown>();
      for (const collected of pages) {
        for (const definition of collected.index.definitions) {
          definitions.set(definition.source.id, definition);
        }
        for (const dependency of collected.index.dependencies) {
          dependencies.set(
            `${dependency.from.id}:${dependency.relationship}:${dependency.to.id}`,
            dependency,
          );
        }
        for (const reference of collected.dependencyRefs) {
          dependencyRefs.set(`${reference.kind}:${reference.id}`, reference);
        }
        for (const [id, instance] of collected.instanceDataByNodeId) {
          instances.set(id, instance);
        }
      }
      const ordered = (values: ReadonlyMap<string, unknown>) =>
        [...values.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([, value]) => value);
      return {
        canonical: serializeCanonicalJson({
          definitions: ordered(definitions),
          dependencies: ordered(dependencies),
          dependencyRefs: ordered(dependencyRefs),
          instances: ordered(instances),
          diagnostics: diagnostics.list().map((diagnostic) => ({
            code: diagnostic.code,
            severity: diagnostic.severity,
            propertyPath: diagnostic.propertyPath,
            causedDataLoss: diagnostic.causedDataLoss,
          })),
        }),
        counters: fixture.counters,
        pages,
        progress,
      };
    };

    const baseline = await run(false);
    const reused = await run(true);

    expect(reused.canonical).toBe(baseline.canonical);
    expect(reused.counters.outerMainLookups).toBe(
      baseline.counters.outerMainLookups,
    );
    expect(reused.counters.definitionChildrenReads).toBe(1);
    expect(baseline.counters.definitionChildrenReads).toBe(2);
    expect(reused.counters.nestedMainLookups).toBe(1);
    expect(baseline.counters.nestedMainLookups).toBe(2);
    expect(reused.counters.idLookups).toBe(1);
    expect(baseline.counters.idLookups).toBe(2);
    expect(reused.pages[1]?.index.definitions).toEqual([]);
    expect(reused.pages[1]?.instanceDataByNodeId.size).toBe(64);
    const finalProgress = reused.progress.at(-1);
    expect(finalProgress).toMatchObject({
      stage: "complete",
      definitionsDiscovered: 0,
      instanceLookupsStarted: 64,
      instanceLookupsCompleted: 64,
      reusedDefinitionTraversals: 64,
    });
    expect(JSON.stringify(reused.progress)).not.toMatch(
      /Invented|component:|instance:|root:/u,
    );
  });
});
