/**
 * Own-property access for records keyed by strings that come from a document or a crosswalk. A plain `record[key]` read follows the prototype chain (`valueOf` and `constructor` are found on every object) and a plain `record[key] = value` write to `__proto__` replaces the record's prototype instead of adding a key, so a path naming such a segment would read inherited functions or reach `Object.prototype` itself. These helpers treat every key, `__proto__` included, as the ordinary data property JSON.parse makes of it.
 */

/**
 * Reads an own property.
 * @param record - The record to read.
 * @param key - Any string, including `__proto__` and names inherited from `Object.prototype`.
 * @returns The own property's value, or `undefined` when the record has no such own property.
 */
export function getOwn(record: Readonly<Record<string, unknown>>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/**
 * Writes an own, enumerable, writable data property, defining it rather than assigning so that `__proto__` becomes a key and never a prototype.
 * @param record - The record to write into.
 * @param key - Any string.
 * @param value - The value to store.
 */
export function setOwn(record: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(record, key, { value, enumerable: true, writable: true, configurable: true });
}
