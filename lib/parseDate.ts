/**
 * Flexibilní parsování dat z Excelu / PDF revizních zpráv.
 * Podporuje JS Date (z xlsx s cellDates: true) i textové formáty
 * jako DD.MM.YYYY, DD. MM. YYYY, DD/MM/YYYY, DD-MM-YYYY nebo YYYY-MM-DD.
 *
 * KRITICKÉ: den/měsíc/rok se skládají do Date VÝHRADNĚ přes Date.UTC(), ne
 * přes obyčejné `new Date(rok, měsíc, den)`. Tenhle konstruktor bez UTC bere
 * zadané komponenty jako ČAS V LOKÁLNÍ ČASOVÉ ZÓNĚ PROSTŘEDÍ, VE KTERÉM KÓD
 * BĚŽÍ – a appka běží ve dvou různých prostředích s různou zónou: v
 * prohlížeči uživatele (Europe/Prague, UTC+1/+2) i v Node skriptu
 * scripts/reprocess-all-revizni-zpravy.ts (server/Codespace, UTC). Stejné
 * "13.03.2026" tak dřív vycházelo jako dva RŮZNÉ Timestampy podle toho, kde
 * zrovna appka běžela (2026-03-12T23:00:00Z v prohlížeči vs.
 * 2026-03-13T00:00:00Z v Node) – to je přesně to, co u zařízení 212261
 * rozbilo dedup duplicitních revizních zpráv (dvě zprávy se stejným
 * kalendářním datem, ale jinak uloženým Timestampem, takže dedup podle
 * přesné shody data je nerozpoznal jako duplicity). Date.UTC() dá VŽDY
 * stejný výsledek bez ohledu na to, v jaké časové zóně kód zrovna běží.
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
    const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
    return isNaN(date.getTime()) ? null : date;
  }

  // DD.MM.YYYY / DD. MM. YYYY / DD/MM/YYYY / DD-MM-YYYY (i s dvouciferným rokem)
  const dmy = text.match(/(\d{1,2})\s*[.\-/]\s*(\d{1,2})\s*[.\-/]\s*(\d{2,4})/);
  if (dmy) {
    const [, d, m, yRaw] = dmy;
    const year = yRaw.length === 2 ? 2000 + Number(yRaw) : Number(yRaw);
    const date = new Date(Date.UTC(year, Number(m) - 1, Number(d)));
    return isNaN(date.getTime()) ? null : date;
  }

  return null;
}
