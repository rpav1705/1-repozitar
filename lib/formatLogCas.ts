export function formatLogCas(d: Date): string {
  return d.toLocaleString("cs-CZ", { dateStyle: "medium", timeStyle: "short" });
}
