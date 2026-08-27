import type {
  ComponentDefinitionIR,
  ComponentDependencyIR,
  JsonArray,
  JsonValue,
  SourceRef,
} from "./ir";

export class CanonicalSerializationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalSerializationError";
  }
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function assertPlainObject(value: object): void {
  let prototype: object | null;
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
  } catch {
    throw new CanonicalSerializationError(
      "Canonical JSON could not inspect an object prototype; normalize it first.",
    );
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new CanonicalSerializationError(
      "Canonical JSON accepts only arrays and plain objects.",
    );
  }
}

function safeArrayCheck(value: object): boolean {
  try {
    return Array.isArray(value);
  } catch {
    throw new CanonicalSerializationError(
      "Canonical JSON could not inspect a runtime value kind; normalize it first.",
    );
  }
}

function safeObjectKeys(value: object): string[] {
  try {
    return Object.keys(value);
  } catch {
    throw new CanonicalSerializationError(
      "Canonical JSON could not inspect object keys; normalize it first.",
    );
  }
}

function rejectSymbolKeys(value: object): void {
  let symbols: symbol[];
  try {
    symbols = Object.getOwnPropertySymbols(value);
  } catch {
    throw new CanonicalSerializationError(
      "Canonical JSON could not inspect object keys; normalize it first.",
    );
  }
  if (symbols.length > 0) {
    throw new CanonicalSerializationError(
      "Canonical JSON cannot omit symbol-keyed properties; normalize them first.",
    );
  }
}

function isArrayIndexKey(key: string, length: number): boolean {
  const index = Number(key);
  return (
    Number.isSafeInteger(index) &&
    index >= 0 &&
    index < length &&
    String(index) === key
  );
}

export function canonicalizeJsonValue(value: unknown): JsonValue {
  const activeObjects = new WeakSet<object>();

  const visit = (current: unknown): JsonValue => {
    if (
      current === null ||
      typeof current === "string" ||
      typeof current === "boolean"
    ) {
      return current;
    }

    if (typeof current === "number") {
      if (!Number.isFinite(current)) {
        throw new CanonicalSerializationError(
          "Canonical JSON cannot contain a non-finite number; normalize it first.",
        );
      }
      return current;
    }

    if (typeof current !== "object") {
      throw new CanonicalSerializationError(
        "Canonical JSON encountered a non-JSON runtime value; normalize it first.",
      );
    }

    if (activeObjects.has(current)) {
      throw new CanonicalSerializationError(
        "Canonical JSON encountered a cyclic value; normalize it first.",
      );
    }

    activeObjects.add(current);
    try {
      if (safeArrayCheck(current)) {
        const currentArray = current as readonly unknown[];
        let length: number;
        try {
          length = currentArray.length;
        } catch {
          throw new CanonicalSerializationError(
            "Canonical JSON could not inspect an array length; normalize it first.",
          );
        }
        rejectSymbolKeys(current);
        if (
          safeObjectKeys(current).some((key) => !isArrayIndexKey(key, length))
        ) {
          throw new CanonicalSerializationError(
            "Canonical JSON cannot omit non-index array properties; normalize them first.",
          );
        }
        const canonicalArray: JsonValue[] = [];
        for (let index = 0; index < length; index += 1) {
          let item: unknown;
          try {
            item = currentArray[index];
          } catch {
            throw new CanonicalSerializationError(
              "Canonical JSON could not read an array item; normalize it first.",
            );
          }
          canonicalArray.push(visit(item));
        }
        return canonicalArray;
      }

      assertPlainObject(current);
      rejectSymbolKeys(current);
      const canonicalObject = Object.create(null) as Record<string, JsonValue>;
      for (const key of safeObjectKeys(current).sort(compareCodeUnits)) {
        let propertyValue: unknown;
        try {
          propertyValue = (current as Record<string, unknown>)[key];
        } catch {
          throw new CanonicalSerializationError(
            "Canonical JSON could not read an object property; normalize it first.",
          );
        }
        canonicalObject[key] = visit(propertyValue);
      }
      return canonicalObject;
    } finally {
      activeObjects.delete(current);
    }
  };

  return visit(value);
}

function indentation(depth: number): string {
  return "  ".repeat(depth);
}

function isJsonArray(value: JsonValue): value is JsonArray {
  return Array.isArray(value);
}

function serializeCanonicalValue(value: JsonValue, depth: number): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    if (Object.is(value, -0)) {
      return "-0";
    }
    return String(value);
  }

  if (isJsonArray(value)) {
    if (value.length === 0) {
      return "[]";
    }
    const childIndent = indentation(depth + 1);
    const serializedItems = value.map(
      (item) => `${childIndent}${serializeCanonicalValue(item, depth + 1)}`,
    );
    return `[\n${serializedItems.join(",\n")}\n${indentation(depth)}]`;
  }

  const objectValue = value;
  const keys = Object.keys(objectValue).sort(compareCodeUnits);
  if (keys.length === 0) {
    return "{}";
  }
  const childIndent = indentation(depth + 1);
  const serializedProperties = keys.map((key) => {
    const propertyValue = objectValue[key];
    if (propertyValue === undefined) {
      throw new CanonicalSerializationError(
        "Canonical JSON encountered an undefined object property; normalize it first.",
      );
    }
    return `${childIndent}${JSON.stringify(key)}: ${serializeCanonicalValue(
      propertyValue,
      depth + 1,
    )}`;
  });
  return `{\n${serializedProperties.join(",\n")}\n${indentation(depth)}}`;
}

export function ensureOneFinalNewline(text: string): string {
  return `${text.replace(/(?:\r\n|\r|\n)+$/u, "")}\n`;
}

export function serializeCanonicalJson(value: unknown): string {
  return ensureOneFinalNewline(
    serializeCanonicalValue(canonicalizeJsonValue(value), 0),
  );
}

export function compareSourceRefs(left: SourceRef, right: SourceRef): number {
  return (
    compareCodeUnits(left.id, right.id) ||
    compareCodeUnits(
      left.name === undefined ? "0" : `1${left.name}`,
      right.name === undefined ? "0" : `1${right.name}`,
    ) ||
    compareCodeUnits(left.kind, right.kind) ||
    compareCodeUnits(
      left.key === undefined ? "0" : `1${left.key}`,
      right.key === undefined ? "0" : `1${right.key}`,
    ) ||
    compareCodeUnits(
      left.remote === undefined ? "0" : left.remote ? "2" : "1",
      right.remote === undefined ? "0" : right.remote ? "2" : "1",
    )
  );
}

export function sortUnorderedSourceRefs(
  references: readonly SourceRef[],
): readonly SourceRef[] {
  return [...references].sort(compareSourceRefs);
}

export function sortUnorderedSourceEntities<
  T extends { readonly source: SourceRef },
>(entities: readonly T[]): readonly T[] {
  return [...entities].sort((left, right) =>
    compareSourceRefs(left.source, right.source),
  );
}

export function compareComponentDependencies(
  left: ComponentDependencyIR,
  right: ComponentDependencyIR,
): number {
  return (
    compareSourceRefs(left.from, right.from) ||
    compareSourceRefs(left.to, right.to) ||
    compareCodeUnits(left.relationship, right.relationship)
  );
}

export function sortUnorderedComponentDefinitions(
  definitions: readonly ComponentDefinitionIR[],
): readonly ComponentDefinitionIR[] {
  return sortUnorderedSourceEntities(definitions);
}

export function sortUnorderedComponentDependencies(
  dependencies: readonly ComponentDependencyIR[],
): readonly ComponentDependencyIR[] {
  return [...dependencies].sort(compareComponentDependencies);
}
