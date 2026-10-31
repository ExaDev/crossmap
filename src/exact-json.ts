import type { JsonValue } from "trilean";

/**
 * Whether a value is JSON exactly as trilean's JsonValueSchema would give it back: a string, a finite number, a boolean, null, an array or a plain record of such values, with nothing the schema's parse would drop or reject. When this holds, parsing the value with the schema succeeds and returns a copy deeply and strictly equal to it, so the value can stand for the parsed copy without the copy being made. It is conservative: a value the schema accepts only by rewriting it (a record with a null or other prototype, a non-enumerable or `__proto__` own key, an array holding a hole or a non-index key) fails this check, and the caller then parses it to get the schema's own result.
 * @param value - The value to check.
 * @returns Whether the value is exact JSON.
 */
export function isExactJson(value: unknown): value is JsonValue {
  switch (typeof value) {
    case "string":
    case "boolean":
      return true;
    case "number":
      // The schema's number refuses NaN and both infinities.
      return Number.isFinite(value);
    case "object":
      if (value === null) {
        return true;
      }

      return Array.isArray(value) ? isExactArray(value) : isExactRecord(value);
    case "bigint":
    case "function":
    case "symbol":
    case "undefined":
      return false;
    default:
      return unknownType();
  }
}

/** An array the schema copies element for element: an ordinary array whose every element is exact (a hole reads as `undefined`, which is not) and with no key but its indices, since the schema's copy keeps only the indices. */
function isExactArray(array: readonly unknown[]): boolean {
  if (Object.getPrototypeOf(array) !== Array.prototype) {
    return false;
  }
  for (const element of array) {
    if (!isExactJson(element)) {
      return false;
    }
  }

  return Object.keys(array).length === array.length;
}

/** A record the schema copies key for key: an ordinary object whose own keys are all enumerable strings other than `__proto__` (the schema refuses a symbol key and drops the others) and whose every value is exact. */
function isExactRecord(record: object): boolean {
  if (Object.getPrototypeOf(record) !== Object.prototype || Object.getOwnPropertySymbols(record).length > 0) {
    return false;
  }
  const keys = Object.keys(record);
  if (keys.length !== Object.getOwnPropertyNames(record).length || keys.includes("__proto__")) {
    return false;
  }

  return keys.every((key) => isExactJson(Reflect.get(record, key)));
}

/** Unreachable: `typeof` has exactly the eight results the switch names, and this arm exists so it is total. */
function unknownType(): never {
  throw new Error("a typeof result outside the eight the language defines");
}
