/**
 * Close a JSON document that was cut off in mid-air.
 *
 * The minutes are the one long-form JSON the agent writes, and a model that
 * runs out of output budget stops mid-token: a string with no closing quote, a
 * key with no value, an array nobody closed. `JSON.parse` then rejects the
 * whole thing, and a kelabo whose title, summary and every topic came back
 * perfectly loses all of it because the last sentence of the last finding was
 * three characters short.
 *
 * That happened in Chinese, which is where it would: the same minutes cost far
 * more output tokens per character, so the budget runs out on a kelabo that
 * would have fit in English. The failure has to be recoverable, not fatal.
 *
 * The repair keeps only what is unambiguously complete — an incomplete string
 * is dropped rather than closed, because closing it invents a sentence ending
 * the model did not write, and these are meeting minutes.
 *
 * Pure and dependency-free (see `gateway/test/repairJson.mjs`): everything else
 * in the agent needs a live LLM, so a parser that only fails on real output is
 * a parser nobody can test.
 */

/** Scan `text`, returning the bracket stack and where an unterminated string began. */
function scan(text) {
  const stack = [];
  let inString = false;
  let escaped = false;
  let stringStart = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') {
        inString = false;
        stringStart = -1;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      stringStart = i;
    } else if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") stack.pop();
  }
  return { stack, inString, stringStart };
}

/**
 * Drop whatever trails the last complete value, so the document can be closed.
 *
 * Runs to a fixed point because one removal exposes the next: cutting an
 * unterminated string leaves `"detail":`, cutting that leaves `,`, and cutting
 * *that* can leave an object with a dangling key of its own.
 */
function trimDangling(text) {
  let out = text;
  for (;;) {
    const before = out;
    out = out.replace(/\s+$/, "");
    if (out.endsWith(",")) out = out.slice(0, -1);
    else if (out.endsWith(":")) {
      // `"key":` with nothing after it — the key goes too. Its opening quote is
      // the last unescaped `"` before the one that closes it.
      const withoutColon = out.slice(0, -1).replace(/\s+$/, "");
      const close = withoutColon.lastIndexOf('"');
      const open = close > 0 ? withoutColon.lastIndexOf('"', close - 1) : -1;
      if (open < 0) return "";
      out = withoutColon.slice(0, open);
    }
    if (out === before) return out;
  }
}

/**
 * `text` if it already parses; otherwise the longest valid prefix of it, closed.
 * Returns `null` when nothing usable survives.
 */
export function repairTruncatedJson(text) {
  const src = String(text ?? "").trim();
  if (!src) return null;
  try {
    JSON.parse(src);
    return src;
  } catch {
    // Truncated, or not JSON at all. Only the first is repairable.
  }

  const first = scan(src);
  // An unterminated string is dropped whole: closing it would attribute a
  // sentence to someone that the model never finished writing.
  let body = first.inString && first.stringStart >= 0 ? src.slice(0, first.stringStart) : src;
  body = trimDangling(body);
  if (!body) return null;

  // Re-scan: the stack that matters is the one for the text we kept.
  const { stack } = scan(body);
  const closed = body + stack.reverse().map((b) => (b === "{" ? "}" : "]")).join("");
  try {
    JSON.parse(closed);
    return closed;
  } catch {
    return null;
  }
}
