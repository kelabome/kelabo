// Finding a person from what someone has typed so far (docs 18 §4.8).
//
// The old suggestion was a DynamoDB `begins_with` on the address, which only
// helps somebody who already knows the address — the one person who does not
// need help. People type names: "dan", "okafor", "dan ok", "dokafor", a
// misspelt "micheal". This ranks a candidate list against that.
//
// Pure — no I/O, no clock — so it is testable under plain node and the same
// ranking can run anywhere a candidate list exists. The caller decides who the
// candidates are (and therefore who may be seen); this only orders them.
//
// ## How a match is scored
//
// The query and each person are folded (lowercase, accents removed) and split
// into words: the display name's words, the address's local part split on
// `.`, `_`, `-` and digits, and the local part whole. Every query word must
// match some word of the person, or the person does not match at all; the
// person's score is the sum of each query word's best match:
//
//   exact word             100
//   prefix of a word        80   ("dan" → Daniel)
//   one edit away           45   (4+ letters: "micheal" → Michael, "okafr" → Okafor)
//   inside a word           40   (3+ letters: "vries" → mdevries)
//   letters in order        20   (3+ letters, same first letter: "dnl" → Daniel)
//
// Two whole-query shortcuts sit above that: a query that is a prefix of the
// address itself (someone typing the address) scores 1000, and a single query
// word that the name's initials start with ("do" → Daniel Okafor) scores 60.
//
// Ties go to the match on an earlier word of the name, then alphabetically,
// so the order is stable from one keystroke to the next.

/** Lowercased, accents and other combining marks removed. */
export function fold(s) {
  return String(s ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/** Words of a folded string: runs of letters or of digits. */
export function wordsOf(s) {
  return fold(s).match(/[\p{L}]+|[0-9]+/gu) ?? [];
}

/**
 * Optimal string alignment distance, stopping early past `max`. A transposed
 * pair counts as one edit — "micheal" is one slip from "michael", not two.
 */
export function editDistance(a, b, max = 1) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev2 = new Array(b.length + 1).fill(0);
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    for (let j = 0; j <= b.length; j++) prev2[j] = prev[j];
    prev = cur;
  }
  return prev[b.length];
}

function isSubsequence(q, w) {
  let i = 0;
  for (let j = 0; j < w.length && i < q.length; j++) if (w[j] === q[i]) i++;
  return i === q.length;
}

/** How well one query word matches one word of a person. 0 is no match. */
export function scoreWord(q, w) {
  if (!q || !w) return 0;
  if (q === w) return 100;
  if (w.startsWith(q)) return 80;
  if (q.length >= 4) {
    // Against the whole word, and against the word cut to the query's length,
    // so a slip early in a half-typed word ("okaf" for "okafor"… "oakf") still
    // finds it.
    if (editDistance(q, w) <= 1 || editDistance(q, w.slice(0, q.length)) <= 1) return 45;
  }
  if (q.length >= 3 && w.includes(q)) return 40;
  if (q.length >= 3 && q[0] === w[0] && isSubsequence(q, w)) return 20;
  return 0;
}

/**
 * The searchable form of one person, computed once per candidate list rather
 * than per keystroke-per-person.
 *
 * @param {{ email: string, displayName?: string }} person
 */
export function indexPerson(person) {
  const email = fold(person.email);
  const local = email.split("@")[0] || "";
  const nameWords = wordsOf(person.displayName);
  const localWords = wordsOf(local);
  const words = [...nameWords];
  for (const w of [...localWords, local]) if (w && !words.includes(w)) words.push(w);
  return {
    email,
    words,
    nameWordCount: nameWords.length,
    initials: nameWords.map((w) => w[0]).join(""),
  };
}

/**
 * How well a query matches one person; 0 means it does not.
 *
 * @param {string} query
 * @param {ReturnType<typeof indexPerson>} idx  from indexPerson
 */
export function scorePerson(query, idx) {
  const q = fold(query).trim();
  if (!q) return 0;
  // Typing the address: the strongest signal there is.
  if (idx.email.startsWith(q)) return 1000 + q.length;
  if (q.includes("@")) return idx.email.includes(q) ? 200 : 0;

  const tokens = wordsOf(q);
  if (!tokens.length) return 0;

  let total = 0;
  let firstHit = Infinity;
  for (const t of tokens) {
    let best = 0;
    let at = -1;
    idx.words.forEach((w, i) => {
      const s = scoreWord(t, w);
      if (s > best) {
        best = s;
        at = i;
      }
    });
    if (!best) {
      if (tokens.length === 1 && t.length >= 2 && idx.initials.length >= 2 && idx.initials.startsWith(t)) return 60;
      return 0;
    }
    total += best;
    firstHit = Math.min(firstHit, at);
  }
  // A small edge for matching the first word of the name — "dan" should put
  // Dan Smith above Jordan Danvers.
  return total + (firstHit === 0 ? 5 : 0);
}

/**
 * Rank candidates for a query. Stable: equal scores keep alphabetical order.
 *
 * @template {{ email: string, displayName?: string }} P
 * @param {string} query
 * @param {P[]} people
 * @param {{ limit?: number, boost?: (p: P) => number, index?: Map<string, ReturnType<typeof indexPerson>> }} [opts]
 *   `boost` adds to a matching person's score (favourites, people who have
 *   signed in) — it never makes a non-match match. `index` reuses indexes a
 *   caller has cached, keyed by email.
 * @returns {Array<P & { score: number }>}
 */
export function rankPeople(query, people, { limit = 8, boost = () => 0, index } = {}) {
  const out = [];
  for (const p of people) {
    const idx = index?.get(p.email) ?? indexPerson(p);
    const s = scorePerson(query, idx);
    if (s > 0) out.push({ ...p, score: s + boost(p) });
  }
  out.sort(
    (a, b) =>
      b.score - a.score ||
      fold(a.displayName || a.email).localeCompare(fold(b.displayName || b.email)) ||
      a.email.localeCompare(b.email),
  );
  return out.slice(0, limit);
}
