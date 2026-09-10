/**
 * Vytáhne z libovolného textu číslo zařízení ve tvaru "písmena + číslice"
 * (alespoň 2 písmena a alespoň 2 číslice, přímo za sebou), volitelně
 * doplněné o podtržítkovou příponu subkomponenty ("_R2", "_EOL", "_CAB"...).
 *
 * Používá se při importu .xls (sloupec s kódem typu "REV-E-ASST007-1R"
 * i sloupec s holým číslem "ASST007"). Revizní zprávy (PDF) mají číslo
 * zařízení uvedené přímo a čistě v poli "Inventární číslo:" (viz
 * lib/pdfRevizniZprava.ts), takže tuhle funkci nepotřebují.
 *
 * U "REV-E-ASST007-1R" vrátí "ASST007" (ne "REV" – tomu chybí navazující
 * číslice – ani "1R" – tam je pořadí písmeno/číslice obráceně).
 * U čistě číselných kódů jako "211508" vrátí null, protože takový kód
 * neobsahuje písmennou část.
 *
 * U "REV-E-ASST119_R2-1R" vrátí "ASST119_R2", ne jen "ASST119" – bez
 * přípony by se subkomponenta zařízení v "planovane_revize" ukládala pod
 * stejné číslo jako hlavní stroj (a jako všechny jeho ostatní
 * subkomponenty), takže by revizní zpráva k "ASST119_R2" (appka ji z PDF
 * čte celou, viz lib/pdfRevizniZprava.ts) neměla s čím se spárovat.
 * Přípona smí obsahovat jen písmena/číslice hned za "_" (končí na první
 * pomlčce/mezeře/dalším podtržítku), ať nepohltí nesouvisející část kódu
 * za pomlčkou jako "-1R".
 */
export function extractEquipmentNumber(text: string): string | null {
  const match = text.match(/[A-Z]{2,}\d{2,}(?:_[A-Z0-9]+)?/i);
  return match ? match[0] : null;
}
