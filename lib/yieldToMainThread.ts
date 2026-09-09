/**
 * Vrátí řízení hlavnímu vláknu prohlížeče (macrotask hranice přes
 * setTimeout, ne mikrotask jako prosté Promise.resolve()) – použij v
 * cyklech, které zpracovávají hodně položek za sebou a jednotlivé kroky
 * mezi sebou řetězí přes await. Bez tohohle by prohlížeč mezi jednotlivými
 * kroky nemusel dostat šanci vykreslit snímek nebo zpracovat uživatelský
 * vstup (mikrotasky se odbavují přednostně před renderem), což Chrome při
 * dost dlouhém souvislém bloku vyhodnotí jako "Stránka nereaguje".
 */
export function yieldToMainThread(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
