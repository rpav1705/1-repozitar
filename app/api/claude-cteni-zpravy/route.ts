import { NextRequest, NextResponse } from "next/server";
import { ChybaKonfiguraceFirebase, overitIdToken } from "@/lib/firebaseAdmin";
import type { ClaudeCteniVysledek } from "@/lib/claudeCteniZprav";
import { jeTypRevize } from "@/lib/typRevize";

// Volání externího API může trvat desítky sekund (zvlášť u skenů).
export const maxDuration = 60;
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * DOČASNÁ integrace Claude – přečte revizní zprávu (výřez z PDF) a vrátí z ní
 * pole, která appka běžně čte vlastním parserem. Volá se jen pro stránky,
 * které parser nerozpoznal, a jen když uživatel u nahrávání zaškrtne volbu
 * (viz app/nahrat/page.tsx). Vyžaduje proměnnou prostředí ANTHROPIC_API_KEY.
 * API klíč zůstává jen na serveru. Viz i lib/claudeCteniZprav.ts (odstranění).
 */
const MODEL = "claude-sonnet-5-5";

const PROMPT_ZAKLAD = `Jsi asistent, který čte české revizní zprávy (elektro revize, tlakové nádoby) z přiloženého PDF. Z dokumentu vyčti údaje o JEDNÉ revizní zprávě a odpověz VÝHRADNĚ jedním JSON objektem (bez dalšího textu, bez markdownu) s těmito klíči:

{
  "je_revizni_zprava": boolean,        // false, pokud dokument není revizní zpráva/protokol o revizi
  "cislo_zarizeni": string|null,       // kód zařízení přesně jak je uvedený, bez mezer (viz pravidla níž)
  "datum_provedeni": "YYYY-MM-DD"|null,// datum provedení / ukončení revize
  "novy_termin": "YYYY-MM-DD"|null,    // termín příští revize; je-li uveden jen měsíc/rok ("09/2027", "říjen 2026"), použij POSLEDNÍ den měsíce; jen rok = 31. 12.
  "celkove_hodnoceni": string|null,    // celkové hodnocení/posudek jednou větou, např. "Vyhovuje" nebo "Nevyhovuje"; u "schopné provozu" napiš "Vyhovuje"
  "zjistena_zavada": string|null,      // text zjištěných závad/poznámek, null když žádné
  "technik_jmeno": string|null,        // jméno revizního technika
  "technik_cislo_opravneni": string|null, // evidenční číslo oprávnění technika
  "druh_revize": "provozni"|"vnitrni"|"zkouska"|null, // jen u tlakových nádob (provozní revize / vnitřní revize / tlaková zkouška), jinak null
  "jistota": "vysoka"|"stredni"|"nizka", // jak moc jsi si jistý správností cislo_zarizeni a obou dat
  "poznamka": string                   // krátce česky: z čeho jsi číslo zařízení vzal, co bylo nejasné
}

Pravidla pro cislo_zarizeni:
- Protokol spotřebiče: pole "Inventární číslo" (ne "Spotřebič ID", ne výrobní číslo).
- Zpráva o revizi elektrického zařízení/instalace/rozvaděče: označení rozvaděče z pole "název rozv." (např. DT1, RSUBRACK1, AGVP06); když pole chybí nebo je prázdné, označení rozvaděče z "Předmět revize" ("rozvaděč RNAB společnosti…"). NIKDY ne číslo revize "YFAI-R-…" ("Revize ev. č.").
- Tlaková nádoba: kód TN… z hlavičky protokolu (např. TN0053, TNS147).
- Nic si nedomýšlej. Pokud údaj v dokumentu není, dej null a jistotu "nizka".`;

function pridatTyp(typ: string): string {
  return typ === "tlakove_nadoby"
    ? `${PROMPT_ZAKLAD}\n\nDokument je z oblasti TLAKOVÝCH NÁDOB.`
    : `${PROMPT_ZAKLAD}\n\nDokument je z oblasti ELEKTRO revizí.`;
}

const DATUM_RE = /^\d{4}-\d{2}-\d{2}$/;

function platneDatum(v: unknown): string | null {
  if (typeof v !== "string" || !DATUM_RE.test(v)) return null;
  const d = new Date(`${v}T00:00:00Z`);
  if (isNaN(d.getTime())) return null;
  const rok = d.getUTCFullYear();
  return rok >= 2000 && rok <= 2100 ? v : null;
}

function textNeboNull(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function vyjmoutJson(text: string): unknown {
  const zacatek = text.indexOf("{");
  const konec = text.lastIndexOf("}");
  if (zacatek === -1 || konec <= zacatek) throw new Error("odpověď Claude neobsahuje JSON");
  return JSON.parse(text.slice(zacatek, konec + 1));
}

function odpoved(vysledek: ClaudeCteniVysledek, status = 200) {
  return NextResponse.json(vysledek, { status });
}

export async function POST(request: NextRequest) {
  try {
    await overitIdToken(request.headers.get("authorization"));
  } catch (err) {
    if (err instanceof ChybaKonfiguraceFirebase) return odpoved({ ok: false, duvod: err.message }, 500);
    return odpoved(
      { ok: false, duvod: err instanceof Error ? err.message : "Neplatný nebo chybějící přihlašovací token." },
      401
    );
  }

  // Poskytovatel se vybírá podle klíče: GEMINI_API_KEY má přednost, jinak ANTHROPIC_API_KEY.
  const geminiKey = process.env.GEMINI_API_KEY;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!geminiKey && !apiKey) {
    return odpoved(
      {
        ok: false,
        chybaKonfigurace: true,
        duvod: "na serveru chybí GEMINI_API_KEY (nebo ANTHROPIC_API_KEY) – nastav ho na Vercelu a nasaď znovu",
      },
      503
    );
  }

  let body: { pdfBase64?: unknown; typ?: unknown };
  try {
    body = await request.json();
  } catch {
    return odpoved({ ok: false, duvod: "neplatné tělo požadavku" }, 400);
  }
  if (typeof body.pdfBase64 !== "string" || !body.pdfBase64) {
    return odpoved({ ok: false, duvod: "chybí pdfBase64" }, 400);
  }
  const typ = typeof body.typ === "string" && jeTypRevize(body.typ) ? body.typ : "elektro";

  if (geminiKey) {
    return odpovedGemini(geminiKey, body.pdfBase64, typ);
  }

  let apiRes: Response;
  try {
    apiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey ?? "",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        // Čtení údajů z formuláře nepotřebuje dlouhé přemýšlení – nízká
        // "effort" šetří výstupní tokeny (myšlení se účtuje jako výstup).
        // max_tokens zahrnuje i myšlení, proto s rezervou nad samotným JSON.
        max_tokens: 4000,
        output_config: { effort: "low" },
        messages: [
          {
            role: "user",
            content: [
              {
                type: "document",
                source: { type: "base64", media_type: "application/pdf", data: body.pdfBase64 },
              },
              { type: "text", text: pridatTyp(typ) },
            ],
          },
        ],
      }),
    });
  } catch (err) {
    return odpoved({ ok: false, duvod: `API Anthropic je nedostupné: ${err instanceof Error ? err.message : String(err)}` }, 502);
  }

  const apiText = await apiRes.text();
  if (!apiRes.ok) {
    console.error("Claude API chyba", apiRes.status, apiText.slice(0, 500));
    let detail = "";
    try {
      detail = JSON.parse(apiText)?.error?.message ?? "";
    } catch {
      // necháme prázdné
    }
    return odpoved({ ok: false, duvod: `API Anthropic vrátilo HTTP ${apiRes.status}${detail ? `: ${detail}` : ""}` }, 502);
  }

  try {
    const api = JSON.parse(apiText) as {
      content?: { type: string; text?: string }[];
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    // Spotřeba jednoho volání do Vercel Logs – podle ní jde spočítat skutečná cena.
    console.log("Claude čtení zprávy: tokeny", api.usage?.input_tokens, "vstup /", api.usage?.output_tokens, "výstup");
    const text = (api.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
    return vyhodnotitOdpoved(text);
  } catch (err) {
    return odpoved({ ok: false, duvod: `odpověď Claude se nepodařilo zpracovat: ${err instanceof Error ? err.message : String(err)}` });
  }
}

/** Zvaliduje JSON z modelu (Claude i Gemini) a vrátí odpověď route. */
function vyhodnotitOdpoved(text: string) {
  const data = vyjmoutJson(text) as Record<string, unknown>;

  if (data.je_revizni_zprava === false) {
    return odpoved({ ok: false, duvod: `Claude: nejde o revizní zprávu (${textNeboNull(data.poznamka) ?? "bez vysvětlení"})` });
  }
  const cislo = textNeboNull(data.cislo_zarizeni)?.replace(/\s+/g, "") ?? null;
  const datum = platneDatum(data.datum_provedeni);
  const termin = platneDatum(data.novy_termin);
  const poznamka = textNeboNull(data.poznamka) ?? "";
  if (!cislo || !datum || !termin) {
    const chybi = [!cislo && "číslo zařízení", !datum && "datum provedení", !termin && "termín příští revize"]
      .filter(Boolean)
      .join(", ");
    return odpoved({ ok: false, duvod: `Claude nenašel: ${chybi}${poznamka ? ` (${poznamka})` : ""}` });
  }
  const jistota =
    data.jistota === "vysoka" || data.jistota === "stredni" || data.jistota === "nizka" ? data.jistota : "nizka";
  const druh =
    data.druh_revize === "provozni" || data.druh_revize === "vnitrni" || data.druh_revize === "zkouska"
      ? data.druh_revize
      : null;

  return odpoved({
    ok: true,
    cislo_zarizeni: cislo,
    datum_provedeni: datum,
    novy_termin: termin,
    celkove_hodnoceni: textNeboNull(data.celkove_hodnoceni) ?? "",
    zjistena_zavada: textNeboNull(data.zjistena_zavada),
    technik_jmeno: textNeboNull(data.technik_jmeno),
    technik_cislo_opravneni: textNeboNull(data.technik_cislo_opravneni),
    druh_revize: druh,
    jistota,
    poznamka,
  });
}

/** Čtení přes Google Gemini (REST) – stejný prompt a validace jako u Claude. Model jde změnit proměnnou GEMINI_MODEL. */
async function odpovedGemini(klic: string, pdfBase64: string, typ: string) {
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  let apiRes: Response;
  try {
    apiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": klic, "content-type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ inline_data: { mime_type: "application/pdf", data: pdfBase64 } }, { text: pridatTyp(typ) }],
          },
        ],
        generationConfig: { responseMimeType: "application/json", temperature: 0 },
      }),
    });
  } catch (err) {
    return odpoved({ ok: false, duvod: `API Gemini je nedostupné: ${err instanceof Error ? err.message : String(err)}` }, 502);
  }

  const apiText = await apiRes.text();
  if (!apiRes.ok) {
    console.error("Gemini API chyba", apiRes.status, apiText.slice(0, 500));
    let detail = "";
    try {
      detail = JSON.parse(apiText)?.error?.message ?? "";
    } catch {
      // necháme prázdné
    }
    return odpoved({ ok: false, duvod: `API Gemini vrátilo HTTP ${apiRes.status}${detail ? `: ${detail}` : ""}` }, 502);
  }

  try {
    const api = JSON.parse(apiText) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };
    console.log(
      "Gemini čtení zprávy:",
      model,
      "tokeny",
      api.usageMetadata?.promptTokenCount,
      "vstup /",
      api.usageMetadata?.candidatesTokenCount,
      "výstup"
    );
    const text = (api.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
    return vyhodnotitOdpoved(text);
  } catch (err) {
    return odpoved({ ok: false, duvod: `odpověď Gemini se nepodařilo zpracovat: ${err instanceof Error ? err.message : String(err)}` });
  }
}
