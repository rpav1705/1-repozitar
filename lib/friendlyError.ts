type MaybeCodedError = { code?: unknown };

function getErrorCode(err: unknown): string | null {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as MaybeCodedError).code;
    return typeof code === "string" ? code : null;
  }
  return null;
}

const FIRESTORE_ERROR_MESSAGES: Record<string, string> = {
  "permission-denied":
    "Nemáš oprávnění ukládat data do databáze. Zkontroluj přihlášení, případně kontaktuj správce.",
  unauthenticated: "Přihlášení vypršelo. Přihlas se prosím znovu a zkus to znovu.",
  unavailable: "Nepodařilo se spojit s databází. Zkontroluj internetové připojení a zkus to znovu.",
  "resource-exhausted": "Databáze je dočasně přetížená. Zkus to prosím za chvíli znovu.",
  "deadline-exceeded": "Databáze neodpověděla včas. Zkus to prosím znovu.",
  cancelled: "Ukládání bylo přerušeno. Zkus to prosím znovu.",
};

/** Přeloží technickou chybu z ukládání do Firestore na srozumitelnou hlášku pro uživatele. */
export function describeSaveError(err: unknown): string {
  const code = getErrorCode(err);
  if (code && FIRESTORE_ERROR_MESSAGES[code]) {
    return FIRESTORE_ERROR_MESSAGES[code];
  }
  if (err instanceof Error && /failed to fetch|network|offline/i.test(err.message)) {
    return "Nepodařilo se spojit se serverem. Zkontroluj internetové připojení a zkus to znovu.";
  }
  return "Nepodařilo se uložit záznamy do databáze. Zkus to prosím znovu, a pokud problém přetrvá, kontaktuj správce.";
}
