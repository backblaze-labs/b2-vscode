export function inputText(value: unknown, fallback = "?"): string {
  return value === undefined || value === null ? fallback : String(value);
}
