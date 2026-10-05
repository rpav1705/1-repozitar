/**
 * Druhy revizí, které appka eviduje odděleně (elektro, tlakové nádoby, …).
 * Každý druh má VLASTNÍ sadu Firestore kolekcí a vlastní složku ve Storage,
 * takže se data různých druhů nikdy nemíchají (ani při importu, ani při
 * párování revizních zpráv podle čísla zařízení, ani v ceníku). Elektro revize
 * záměrně drží PŮVODNÍ názvy kolekcí – už uložená data se tak nemigrují a
 * zůstávají přesně tam, kde byla.
 *
 * Přidání dalšího druhu = jeden nový záznam v KOLEKCE_TYPU níž (a typ v
 * TypRevize) – zbytek appky se řídí podle tohohle záznamu.
 */
export type TypRevize = "elektro" | "tlakove_nadoby";

export const VYCHOZI_TYP_REVIZE: TypRevize = "elektro";

export type KolekceRevizi = {
  typ: TypRevize;
  /** Popisek druhu revizí pro přepínač v UI. */
  label: string;
  /** Plán revizí / zařízení (dashboard, import plánu). */
  plan: string;
  /** Revizní zprávy (PDF) vč. historie. */
  zpravy: string;
  /** Historie importů/zpracování (karty "poslední import" na dashboardu). */
  log: string;
  /** Ceník. */
  cenik: string;
  /**
   * Prefix cesty PDF ve Firebase Storage. Tlakové nádoby jsou záměrně
   * podsložka stávající složky "revizni_zpravy/", ať na ně platí stejná
   * pravidla Storage jako na elektro revize.
   */
  storagePrefix: string;
};

const KOLEKCE_TYPU: Record<TypRevize, KolekceRevizi> = {
  elektro: {
    typ: "elektro",
    label: "Elektro revize",
    plan: "planovane_revize",
    zpravy: "revizni_zpravy",
    log: "import_log",
    cenik: "cenik",
    storagePrefix: "revizni_zpravy",
  },
  tlakove_nadoby: {
    typ: "tlakove_nadoby",
    label: "Tlakové nádoby",
    plan: "planovane_revize_tlakove_nadoby",
    zpravy: "revizni_zpravy_tlakove_nadoby",
    log: "import_log_tlakove_nadoby",
    cenik: "cenik_tlakove_nadoby",
    storagePrefix: "revizni_zpravy/tlakove_nadoby",
  },
};

/** Druhy revizí v pořadí, v jakém je ukazuje přepínač. */
export const TYPY_REVIZE: KolekceRevizi[] = [KOLEKCE_TYPU.elektro, KOLEKCE_TYPU.tlakove_nadoby];

export function jeTypRevize(value: unknown): value is TypRevize {
  return typeof value === "string" && value in KOLEKCE_TYPU;
}

export function kolekceProTyp(typ: TypRevize): KolekceRevizi {
  return KOLEKCE_TYPU[typ];
}
