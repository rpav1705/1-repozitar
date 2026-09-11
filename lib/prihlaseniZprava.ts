/**
 * Krátká zpráva, kterou má AuthGate zobrazit na přihlašovací obrazovce po
 * příštím načtení – používá se, když appka uživatele sama odhlásí kvůli
 * vedlejšímu efektu jiné akce (např. založení nového účtu v Administraci
 * vždy Firebase automaticky přihlásí, appka proto hned poté odhlásí zpět
 * na přihlašovací obrazovku, viz app/administrace/page.tsx).
 */
const KLIC = "prihlaseni_zprava";

export function nastavPrihlaseniZpravu(zprava: string): void {
  try {
    window.localStorage.setItem(KLIC, zprava);
  } catch {
    // localStorage nemusí být dostupný (např. soukromé okno) – zpráva se
    // pak po odhlášení prostě nezobrazí, na hlavní akci to nemá vliv.
  }
}

/** Přečte a rovnou smaže uloženou zprávu, ať se nezobrazí opakovaně. */
export function vyzvednoutPrihlaseniZpravu(): string | null {
  try {
    const zprava = window.localStorage.getItem(KLIC);
    if (zprava) window.localStorage.removeItem(KLIC);
    return zprava;
  } catch {
    return null;
  }
}
