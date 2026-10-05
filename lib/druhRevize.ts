/**
 * Druh revize u zařízení, které má v plánu VÍC plánovaných revizí s různou
 * frekvencí (typicky tlakové nádoby: provozní revize každý rok, vnitřní revize
 * po 5 letech, tlaková zkouška po 10 letech – každá je v plánu samostatný řádek
 * se svým PÚ a frekvencí). Revizní zpráva se podle druhu spáruje s řádkem
 * plánu, jehož frekvence druhu odpovídá, místo aby skončila jako "víc shod".
 *
 * Elektro revize druh nemají (zpráva ho nenese) – u nich appka párování a
 * historii řeší beze změny podle samotného čísla zařízení.
 */
export type DruhRevize = "provozni" | "vnitrni" | "zkouska";

const FREKVENCE_PODLE_DRUHU: Record<DruhRevize, number> = {
  provozni: 1,
  vnitrni: 5,
  zkouska: 10,
};

export const DRUH_REVIZE_LABELS: Record<DruhRevize, string> = {
  provozni: "provozní revize",
  vnitrni: "vnitřní revize",
  zkouska: "tlaková zkouška",
};

export function jeDruhRevize(value: unknown): value is DruhRevize {
  return value === "provozni" || value === "vnitrni" || value === "zkouska";
}

/** Frekvence (v letech) řádku plánu, který patří k danému druhu revize. */
export function frekvenceProDruh(druh: DruhRevize): number {
  return FREKVENCE_PODLE_DRUHU[druh];
}

/** Jestli řádek plánu s touhle frekvencí patří k danému druhu revize. */
export function planOdpovidaDruhu(planFrekvence: unknown, druh: DruhRevize): boolean {
  return typeof planFrekvence === "number" && planFrekvence === FREKVENCE_PODLE_DRUHU[druh];
}
