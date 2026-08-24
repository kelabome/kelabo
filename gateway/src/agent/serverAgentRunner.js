// Minutes JSON parsing shared by the server agent (MainAgent.summarize) and the
// dev-mode paths (archive.js / minutes.js) that parse an opencode-produced summary.
// The main/sub agent orchestration lives in mainAgent.js and subAgent.js.
//
// Two shapes reach this function: the current one, where topics/decisions/
// findings carry their substance as objects, and the original one, where they
// were plain strings. Both normalize to the object form so a record archived
// before the richer minutes still renders — and so an opencode session that
// answers in the old shape is not rejected.
import { repairTruncatedJson } from "./repairJson.js";

/**
 * Minutes from a model's reply, or `null` if there are none to be had.
 *
 * **Unparseable used to mean "minutes whose only content is the raw reply"** —
 * a record that reported `hasMinutes: true` and rendered a wall of escaped JSON
 * where the summary should be. That is worse than no minutes: it looks like a
 * failure of the product rather than of one call, and there is nothing a reader
 * can do with it. Now the reply is repaired if it was merely cut short, and
 * otherwise nothing is returned — the caller already logs `minutes_skipped`
 * with a reason and the record honestly shows none.
 */
export function parseMinutesJson(text, kelaboId, generatedBy) {
  if (!text) return null;
  try {
    const stripped = String(text).replace(/```json|```/g, "").trim();
    const open = stripped.indexOf("{");
    if (open < 0) return null;
    // Two candidates, tried in the order that loses the least.
    //
    // `{` to the **last** `}` is right when the model wrote the object and then
    // kept talking. It is wrong when the reply was cut off, because the last
    // `}` is then some *inner* object and everything after it — often whole
    // sections — is thrown away before the repair ever sees it. So the exact
    // parse of that candidate is tried first, and if it fails the repair works
    // on the full tail instead.
    const greedy = stripped.slice(open, stripped.lastIndexOf("}") + 1);
    const toEnd = stripped.slice(open);
    const source = parses(greedy) ?? repairTruncatedJson(toEnd) ?? repairTruncatedJson(greedy);
    if (!source) return null;
    const json = JSON.parse(source);
    return {
      kelaboId,
      ...(str(json.title) ? { title: str(json.title).slice(0, 80) } : {}),
      ...(str(json.summary) ? { summary: str(json.summary) } : {}),
      topics: topics(json.topics),
      decisions: decisions(json.decisions),
      actionItems: Array.isArray(json.actionItems)
        ? json.actionItems.map((a) =>
            typeof a === "string"
              ? { text: a }
              : {
                  text: str(a?.text),
                  ...(str(a?.owner) ? { owner: str(a.owner) } : {}),
                  ...(str(a?.due) ? { due: str(a.due) } : {}),
                }
          )
        : [],
      openQuestions: arr(json.openQuestions),
      findings: findings(json.findings),
      generatedAt: Date.now(),
      generatedBy,
    };
  } catch {
    return null;
  }
}

/** The text itself when it is already valid JSON, else null. */
function parses(text) {
  try {
    JSON.parse(text);
    return text;
  } catch {
    return null;
  }
}

const str = (v) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v));
const arr = (v) => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);

function topics(v) {
  if (!Array.isArray(v)) return [];
  return v
    .map((t) => {
      if (typeof t === "string") return { title: str(t) };
      const speakers = arr(t?.speakers);
      return {
        title: str(t?.title) || str(t?.name) || str(t?.detail).slice(0, 60),
        ...(str(t?.detail) ? { detail: str(t.detail) } : {}),
        ...(speakers.length ? { speakers } : {}),
      };
    })
    .filter((t) => t.title);
}

function decisions(v) {
  if (!Array.isArray(v)) return [];
  return v
    .map((d) =>
      typeof d === "string"
        ? { text: str(d) }
        : { text: str(d?.text) || str(d?.decision), ...(str(d?.rationale) ? { rationale: str(d.rationale) } : {}) }
    )
    .filter((d) => d.text);
}

function findings(v) {
  if (!Array.isArray(v)) return [];
  return v
    .map((f) => {
      if (typeof f === "string") return { text: str(f) };
      const sources = Array.isArray(f?.sources)
        ? f.sources
            .map((s) => (typeof s === "string" ? { title: s } : { title: str(s?.title) || str(s?.url), ...(str(s?.url) ? { url: str(s.url) } : {}) }))
            .filter((s) => s.title)
        : [];
      return { text: str(f?.text) || str(f?.finding), ...(sources.length ? { sources } : {}) };
    })
    .filter((f) => f.text);
}
