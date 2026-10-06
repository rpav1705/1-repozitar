/**
 * Odkaz na nahraný PDF, který otevře rovnou stránku s danou revizní zprávou.
 *
 * Jeden nahraný soubor často obsahuje stovky revizních zpráv (jedna na
 * stránku – např. 207stránkový export za celou halu) a appka ho ukládá do
 * Storage JEDNOU, na který odkazují všechny zprávy z něj. Bez čísla stránky by
 * odkaz "Revizní zpráva" u zařízení otevřel soubor od první stránky a
 * uživatel by musel hledat. Prohlížeče PDF (Chrome, Edge, Firefox) berou
 * "#page=N" na konci adresy jako číslo stránky; u zprávy na první stránce se
 * adresa nemění.
 */
export function urlSeStrankou(url: unknown, stranka: unknown): string | null {
  if (typeof url !== "string" || !url) return null;
  if (typeof stranka !== "number" || !Number.isFinite(stranka) || stranka <= 1) return url;
  return `${url.split("#")[0]}#page=${Math.floor(stranka)}`;
}
