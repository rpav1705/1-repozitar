/**
 * Vytáhne z libovolného textu číslo zařízení ve tvaru "písmena + číslice"
 * (alespoň 2 písmena a alespoň 2 číslice, přímo za sebou).
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
 */
export function extractEquipmentNumber(text: string): string | null {
  const match = text.match(/[A-Z]{2,}\d{2,}/i);
  return match ? match[0] : null;
}
