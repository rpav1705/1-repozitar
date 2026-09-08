/**
 * Flexibilní parsování dat z Excelu / PDF revizních zpráv.
 * Podporuje JS Date (z xlsx s cellDates: true) i textové formáty
 * jako DD.MM.YYYY, DD. MM. YYYY, DD/MM/YYYY, DD-MM-YYYY nebo YYYY-MM-DD.
 */
export function parseFlexibleDate(value: unknown): Date | null {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return value;
  }

  if (typeof value !== "string") return null;

  const text = value.trim();
  if (!text) return null;

  // YYYY-MM-DD nebo YYYY/MM/DD
  const iso = text.match(/^(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/);
  if (iso) {
    const [, y, m, d] = iso;
    const date = new Date(Number(y), Number(m) - 1, Number(d));
    return isNaN(date.getTime()) ? null : date;
  }

  // DD.MM.YYYY / DD. MM. YYYY / DD/MM/YYYY / DD-MM-YYYY (i s dvouciferným rokem)
  const dmy = text.match(/(\d{1,2})\s*[.\-/]\s*(\d{1,2})\s*[.\-/]\s*(\d{2,4})/);
  if (dmy) {
    const [, d, m, yRaw] = dmy;
    const year = yRaw.length === 2 ? 2000 + Number(yRaw) : Number(yRaw);
    const date = new Date(year, Number(m) - 1, Number(d));
    return isNaN(date.getTime()) ? null : date;
  }

  return null;
}
