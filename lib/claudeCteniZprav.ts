/**
 * DOČASNÁ integrace Claude (Anthropic API) pro čtení revizních zpráv, které
 * vlastní parser (lib/pdfRevizniZprava.ts) nerozpoznal – viz
 * app/api/claude-cteni-zpravy/route.ts (server, drží API klíč) a použití v
 * handleProcess (app/nahrat/page.tsx, volitelné zaškrtávátko u nahrávání).
 *
 * Odstranění: smazat tenhle soubor, route a větev "pouzitClaude" v
 * app/nahrat/page.tsx (a pole "cteno_claude" v lib/revizniZpravyFirestore.ts).
 */

import type { Part } from "firebase/ai";
import { klasifikujVysledekRevize, ParsedRevizniZprava, SkippedPage } from "./pdfRevizniZprava";
import { otevriZdrojPdf, ZdrojPdf } from "./pdfRozdeleni";
import { pridatTyp, vyhodnotitOdpoved } from "./cteniZpravPrompt";

/** Odpověď route po validaci na serveru (data jsou YYYY-MM-DD). */
export type ClaudeCteniVysledek =
  | {
      ok: true;
      cislo_zarizeni: string;
      datum_provedeni: string;
      novy_termin: string;
      celkove_hodnoceni: string;
      zjistena_zavada: string | null;
      technik_jmeno: string | null;
      technik_cislo_opravneni: string | null;
      druh_revize: "provozni" | "vnitrni" | "zkouska" | null;
      jistota: "vysoka" | "stredni" | "nizka";
      poznamka: string;
    }
  | { ok: false; duvod: string; chybaKonfigurace?: boolean };

/** Bytes -> base64 po částech (spread celého pole do String.fromCharCode by u větších PDF přetekl zásobník). */
export function bytesNaBase64(bytes: Uint8Array): string {
  let binarni = "";
  const velikostCastiky = 0x8000;
  for (let i = 0; i < bytes.length; i += velikostCastiky) {
    binarni += String.fromCharCode(...bytes.subarray(i, i + velikostCastiky));
  }
  return btoa(binarni);
}

/**
 * Gemini přijímá inline data do ~20 MB celého požadavku (base64 zvětší data o
 * třetinu) – volá se přímo z prohlížeče přes Firebase AI Logic, takže tu
 * neplatí 4,5MB limit Vercel Functions.
 */
export const CLAUDE_MAX_BYTES_PDF = 14_000_000;

/** Maximum stránek jedné zprávy, které appka modelu pošle (ochrana před cenou). */
export const CLAUDE_MAX_STRAN = 20;

/**
 * Modely Gemini na Vertex AI, od nejnovějšího stabilního (viz
 * https://docs.cloud.google.com/vertex-ai/generative-ai/docs/learn/model-versions):
 * gemini-2.5-flash skončil 20. 10. 2026, gemini-2.0-flash 1. 6. 2026.
 * Neexistující model se přeskočí.
 */
const AI_MODELY = ["gemini-3.8-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite"];
/** Novější modely bývají dostupné jen v "global" lokaci. */
const AI_LOKACE = ["global", "us-central1"];
let fungujiciModel: { nazev: string; lokace: string } | null = null;

/** Chyby, které znamenají špatné nastavení projektu (ne problém konkrétní zprávy). */
const CHYBA_KONFIGURACE_RE =
  /permission|403|billing|not enabled|has not been used|disabled|app.?check|api.?key|quota|blaze/i;

/**
 * Přečte zprávu (výřez PDF) pomocí Gemini přes Firebase AI Logic s Vertex AI
 * backendem (účtuje se přes Google Cloud/Blaze projektu, žádný API klíč).
 * Vyžaduje zapnuté Firebase AI Logic (Vertex AI) v projektu.
 */
export async function precistZpravuPomociClaude(
  _idToken: string,
  pdfBytes: Uint8Array,
  typ: string
): Promise<ClaudeCteniVysledek> {
  if (pdfBytes.length > CLAUDE_MAX_BYTES_PDF) {
    return {
      ok: false,
      duvod: `výřez je příliš velký pro odeslání (${(pdfBytes.length / 1e6).toFixed(1)} MB, limit ${CLAUDE_MAX_BYTES_PDF / 1e6} MB)`,
    };
  }
  try {
    const { getAI, getGenerativeModel, VertexAIBackend } = await import("firebase/ai");
    const { firebaseApp } = await import("./firebase");
    const casti: Part[] = [
      { inlineData: { mimeType: "application/pdf", data: bytesNaBase64(pdfBytes) } },
      { text: pridatTyp(typ) },
    ];

    // Dřív ověřená dvojice model + lokace se zkouší první (ať se u každé
    // stránky znovu neprochází seznam).
    const kandidati = [
      ...(fungujiciModel ? [fungujiciModel] : []),
      ...AI_MODELY.flatMap((nazev) => AI_LOKACE.map((lokace) => ({ nazev, lokace }))),
    ].filter((k, i, vse) => vse.findIndex((v) => v.nazev === k.nazev && v.lokace === k.lokace) === i);

    const nedostupne: string[] = [];
    for (const { nazev, lokace } of kandidati) {
      try {
        const ai = getAI(firebaseApp, { backend: new VertexAIBackend(lokace) });
        const model = getGenerativeModel(ai, {
          model: nazev,
          generationConfig: { responseMimeType: "application/json", temperature: 0 },
        });
        const odpoved = await model.generateContent(casti);
        fungujiciModel = { nazev, lokace };
        const usage = odpoved.response.usageMetadata;
        console.log("AI čtení zprávy:", nazev, lokace, "tokeny", usage?.promptTokenCount, "vstup /", usage?.candidatesTokenCount, "výstup");
        return vyhodnotitOdpoved(odpoved.response.text());
      } catch (err) {
        const zprava = err instanceof Error ? err.message : String(err);
        if (/not found|not available|no longer available|unsupported|not supported|404/i.test(zprava)) {
          nedostupne.push(`${nazev}@${lokace}`);
          continue;
        }
        throw err;
      }
    }
    throw new Error(`žádný model není dostupný (zkoušeno: ${nedostupne.join(", ")}) – zkontroluj názvy modelů v lib/claudeCteniZprav.ts`);
  } catch (err) {
    const zprava = err instanceof Error ? err.message : String(err);
    if (CHYBA_KONFIGURACE_RE.test(zprava)) {
      return {
        ok: false,
        chybaKonfigurace: true,
        duvod: `AI nedostupná – zapni ve Firebase Console Build → AI Logic (Vertex AI) a tarif Blaze (${zprava.slice(0, 200)})`,
      };
    }
    return { ok: false, duvod: `čtení AI selhalo: ${zprava}` };
  }
}

/** Nejvíc volání Claude na jeden nahraný soubor (ochrana před nechtěně vysokou cenou u velkých exportů). */
const CLAUDE_MAX_VOLANI_NA_SOUBOR = 30;

function datumUTC(yyyymmdd: string): Date {
  return new Date(`${yyyymmdd}T00:00:00Z`);
}

/**
 * Stránky, které vlastní parser přeskočil, zkusí přečíst Claude. Zpráva začíná
 * na přeskočené stránce a sahá po další stránku, kterou parser vzal/přeskočil
 * (nebo konec souboru, nejvýš CLAUDE_MAX_STRAN stran). Vrací úspěšně přečtené
 * zprávy (jistota "vysoka"/"stredni", příznak cteno_claude) a stránky, které
 * zůstaly nerozpoznané, s důvodem doplněným o odpověď Claude.
 */
export async function precistPreskocenePomociClaude(
  buffer: ArrayBuffer,
  preskoceno: SkippedPage[],
  zpravyParseru: ParsedRevizniZprava[],
  typ: string,
  idToken: string
): Promise<{ prectene: ParsedRevizniZprava[]; zbyva: SkippedPage[]; chybaKonfigurace: boolean }> {
  const prectene: ParsedRevizniZprava[] = [];
  const zbyva: SkippedPage[] = [];
  let chybaKonfigurace = false;

  let zdroj: ZdrojPdf;
  try {
    zdroj = await otevriZdrojPdf(buffer);
  } catch (err) {
    const duvod = err instanceof Error ? err.message : String(err);
    return {
      prectene,
      zbyva: preskoceno.map((p) => ({ ...p, duvod: `${p.duvod}; Claude: PDF nejde otevřít (${duvod})` })),
      chybaKonfigurace,
    };
  }

  // Naskenované stránky (parser z nich nepřečetl žádný text) navazující na
  // předchozí přeskočenou naskenovanou stránku patří k téže zprávě – model
  // dostane celou zprávu najednou (jedno volání místo jednoho na stránku).
  const jeSken = (p: SkippedPage) => p.duvod.includes('obsah stránky: ""');
  const skenovane = new Set(preskoceno.filter(jeSken).map((p) => p.stranka));
  const navazujici = new Set(preskoceno.filter((p) => jeSken(p) && skenovane.has(p.stranka - 1)).map((p) => p.stranka));

  const hranice = [
    ...new Set(
      [...zpravyParseru.map((z) => z.stranka), ...preskoceno.filter((p) => !navazujici.has(p.stranka)).map((p) => p.stranka)].filter(
        (s) => s > 0
      )
    ),
  ].sort((a, b) => a - b);

  const pokryto = new Set<number>();
  let volani = 0;
  for (const p of preskoceno) {
    if (navazujici.has(p.stranka)) continue; // přečte se spolu s první stránkou zprávy
    if (p.stranka <= 0 || p.stranka > zdroj.pocetStran) {
      zbyva.push(p);
      continue;
    }

    const dalsiHranice = hranice.find((s) => s > p.stranka);
    const konec = Math.min(
      (dalsiHranice ?? zdroj.pocetStran + 1) - 1,
      zdroj.pocetStran,
      p.stranka + CLAUDE_MAX_STRAN - 1
    );
    const strany = Array.from({ length: konec - p.stranka + 1 }, (_, i) => p.stranka + i);
    strany.forEach((s) => pokryto.add(s));
    // Všechny přeskočené stránky téhle zprávy (první + navazující sken) – při nezdaru zůstanou nerozpoznané.
    const skupina = preskoceno.filter((q) => strany.includes(q.stranka));
    const nepodarilo = (dodatek: string) =>
      skupina.forEach((q) => zbyva.push({ ...q, duvod: `${q.duvod}; ${dodatek}` }));

    if (chybaKonfigurace) {
      nepodarilo("AI nedostupná (nastavení Firebase AI Logic)");
      continue;
    }
    if (volani >= CLAUDE_MAX_VOLANI_NA_SOUBOR) {
      nepodarilo(`Claude: překročen limit ${CLAUDE_MAX_VOLANI_NA_SOUBOR} volání na soubor`);
      continue;
    }
    volani += 1;

    let vysledek: ClaudeCteniVysledek;
    try {
      vysledek = await precistZpravuPomociClaude(idToken, await zdroj.vyrez(strany), typ);
    } catch (err) {
      vysledek = { ok: false, duvod: err instanceof Error ? err.message : String(err) };
    }

    if (!vysledek.ok) {
      if (vysledek.chybaKonfigurace) chybaKonfigurace = true;
      nepodarilo(`Claude: ${vysledek.duvod}`);
    } else if (vysledek.jistota === "nizka") {
      nepodarilo(
        `Claude si není jistý (navrhuje ${vysledek.cislo_zarizeni}${
          vysledek.poznamka ? `: ${vysledek.poznamka}` : ""
        }) – zpráva se neuložila`
      );
    } else {
      prectene.push({
        cislo_zarizeni: vysledek.cislo_zarizeni,
        datum_provedeni: datumUTC(vysledek.datum_provedeni),
        novy_termin: datumUTC(vysledek.novy_termin),
        celkove_hodnoceni: vysledek.celkove_hodnoceni,
        vysledek_revize: klasifikujVysledekRevize(vysledek.celkove_hodnoceni),
        zjistena_zavada: vysledek.zjistena_zavada,
        technik_jmeno: vysledek.technik_jmeno,
        technik_cislo_opravneni: vysledek.technik_cislo_opravneni,
        stranka: p.stranka,
        pocet_stran: strany.length,
        ...(vysledek.druh_revize ? { druh_revize: vysledek.druh_revize } : {}),
        cteno_claude: true,
      });
    }
  }

  // Navazující sken za limitem CLAUDE_MAX_STRAN stran jedné zprávy se nepřečetl.
  for (const p of preskoceno) {
    if (navazujici.has(p.stranka) && !pokryto.has(p.stranka)) {
      zbyva.push({ ...p, duvod: `${p.duvod}; Claude: stránka je za limitem ${CLAUDE_MAX_STRAN} stran jedné zprávy` });
    }
  }

  return { prectene, zbyva, chybaKonfigurace };
}
