// DynamoDB expression evaluation, the subset this repository actually writes.
//
// Deliberately a subset, and deliberately STRICT about it: anything it does not
// understand throws rather than being ignored. A permissive evaluator is worse
// than no evaluator here — a ConditionExpression it silently treats as "true"
// turns every `attribute_not_exists(PK)` guard into a no-op, and the e2e suite
// then passes on a store that has none of the concurrency behaviour the real
// code is written against. The grammar is small because `rest-api/src/db.js`,
// `gateway/src/db.js` and `gateway/src/journeys.js` only use this much; when
// they grow a construct, this throws and names it.

/** `#a.#b` / plain `a.b` — resolve one document path against the alias map. */
function pathOf(raw, names) {
  return raw
    .trim()
    .split(".")
    .map((seg) => {
      const s = seg.trim();
      if (!s.startsWith("#")) return s;
      const resolved = names?.[s];
      if (resolved === undefined) throw new Error(`unknown ExpressionAttributeName: ${s}`);
      return resolved;
    });
}

function readPath(item, path) {
  let cur = item;
  for (const seg of path) {
    if (cur === undefined || cur === null) return undefined;
    cur = cur[seg];
  }
  return cur;
}

function writePath(item, path, value) {
  let cur = item;
  for (const seg of path.slice(0, -1)) {
    if (typeof cur[seg] !== "object" || cur[seg] === null) cur[seg] = {};
    cur = cur[seg];
  }
  cur[path[path.length - 1]] = value;
}

function deletePath(item, path) {
  let cur = item;
  for (const seg of path.slice(0, -1)) {
    if (typeof cur?.[seg] !== "object" || cur[seg] === null) return;
    cur = cur[seg];
  }
  delete cur[path[path.length - 1]];
}

function valueOf(token, values) {
  const t = token.trim();
  if (!t.startsWith(":")) throw new Error(`expected a value placeholder, got: ${t}`);
  if (!values || !(t in values)) throw new Error(`unknown ExpressionAttributeValue: ${t}`);
  return values[t];
}

/** A comparison operand: a `:value`, or a document path read from the item. */
function operand(token, item, names, values) {
  const t = token.trim();
  if (t.startsWith(":")) return valueOf(t, values);
  return readPath(item, pathOf(t, names));
}

/**
 * Split on a top-level keyword, respecting parentheses. `AND`/`OR` inside
 * `begins_with(SK, :p)` must not split the expression, and a naive
 * `.split(" AND ")` does exactly that the first time an argument contains one.
 */
function splitTopLevel(expr, keyword) {
  const parts = [];
  let depth = 0;
  let last = 0;
  // `SK BETWEEN :lo AND :hi` contains an AND that is part of ONE comparison,
  // not a conjunction. Splitting on it produced `PK = :pk`, `SK BETWEEN :lo`
  // and `:hi` — the middle of which is not a valid expression, which is how it
  // was found. So an AND is swallowed when an unmatched BETWEEN is open.
  let pendingBetween = 0;
  const re = new RegExp(`\\b${keyword}\\b`, "gi");
  const between = /\bBETWEEN\b/gi;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0) {
      between.lastIndex = i;
      const b = between.exec(expr);
      if (b && b.index === i) {
        pendingBetween++;
        i = between.lastIndex - 1;
        continue;
      }
      re.lastIndex = i;
      const m = re.exec(expr);
      if (m && m.index === i) {
        if (keyword.toUpperCase() === "AND" && pendingBetween > 0) {
          pendingBetween--;
          i = re.lastIndex - 1;
          continue;
        }
        parts.push(expr.slice(last, i));
        i = re.lastIndex - 1;
        last = re.lastIndex;
      }
    }
  }
  parts.push(expr.slice(last));
  return parts.length > 1 ? parts.map((p) => p.trim()) : null;
}

/** Strip one layer of wrapping parentheses, if they wrap the WHOLE expression. */
function unwrap(expr) {
  let e = expr.trim();
  while (e.startsWith("(") && e.endsWith(")")) {
    let depth = 0;
    let wrapsAll = true;
    for (let i = 0; i < e.length; i++) {
      if (e[i] === "(") depth++;
      else if (e[i] === ")") {
        depth--;
        if (depth === 0 && i < e.length - 1) {
          wrapsAll = false;
          break;
        }
      }
    }
    if (!wrapsAll) break;
    e = e.slice(1, -1).trim();
  }
  return e;
}

/**
 * Evaluate a ConditionExpression / FilterExpression against one item.
 *
 * @param {string} expr
 * @param {object|null} item  null means "no such item" — which is the case
 *   `attribute_not_exists(PK)` exists to allow, so it must be a real input
 *   rather than a short-circuit at the call site.
 */
export function evaluateCondition(expr, item, names, values) {
  const e = unwrap(expr);
  if (!e) return true;

  const ors = splitTopLevel(e, "OR");
  if (ors) return ors.some((p) => evaluateCondition(p, item, names, values));
  const ands = splitTopLevel(e, "AND");
  if (ands) return ands.every((p) => evaluateCondition(p, item, names, values));

  let m = /^attribute_not_exists\s*\(([^)]+)\)$/i.exec(e);
  if (m) return readPath(item ?? {}, pathOf(m[1], names)) === undefined;

  m = /^attribute_exists\s*\(([^)]+)\)$/i.exec(e);
  if (m) return readPath(item ?? {}, pathOf(m[1], names)) !== undefined;

  m = /^begins_with\s*\(([^,]+),([^)]+)\)$/i.exec(e);
  if (m) {
    const subject = operand(m[1], item ?? {}, names, values);
    const prefix = operand(m[2], item ?? {}, names, values);
    return typeof subject === "string" && subject.startsWith(String(prefix));
  }

  m = /^(.+?)\s+BETWEEN\s+(\S+)\s+AND\s+(\S+)$/i.exec(e);
  if (m) {
    const subject = operand(m[1], item ?? {}, names, values);
    const lo = operand(m[2], item ?? {}, names, values);
    const hi = operand(m[3], item ?? {}, names, values);
    if (subject === undefined) return false;
    return subject >= lo && subject <= hi;
  }

  m = /^(.+?)\s*(<>|<=|>=|=|<|>)\s*(.+)$/.exec(e);
  if (m) {
    const left = operand(m[1], item ?? {}, names, values);
    const right = operand(m[3], item ?? {}, names, values);
    switch (m[2]) {
      case "=":
        return left === right;
      case "<>":
        return left !== right;
      default:
        // An absent attribute compares false on every ordering operator, the
        // way DynamoDB treats it — not `undefined < 5` -> false by accident.
        if (left === undefined || right === undefined) return false;
        return m[2] === "<" ? left < right : m[2] === ">" ? left > right : m[2] === "<=" ? left <= right : left >= right;
    }
  }

  throw new Error(`unsupported condition expression: ${JSON.stringify(expr)}`);
}

/** The last top-level `+`/`-` in a SET operand, or null if there is none. */
function topLevelArithmetic(expr) {
  let depth = 0;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0 && (ch === "+" || ch === "-") && i > 0) {
      return { left: expr.slice(0, i), op: ch, right: expr.slice(i + 1) };
    }
  }
  return null;
}

/** `if_not_exists(a, :v)`, `list_append(:a, :b)`, `#n + :d`, `:v`, or a path. */
function evaluateSetValue(raw, item, names, values) {
  const e = raw.trim();

  let m = /^if_not_exists\s*\(([^,]+),\s*(.+)\)$/i.exec(e);
  if (m) {
    const existing = readPath(item, pathOf(m[1], names));
    return existing !== undefined ? existing : evaluateSetValue(m[2], item, names, values);
  }

  m = /^list_append\s*\((.+),\s*([^,]+)\)$/i.exec(e);
  if (m) {
    const a = evaluateSetValue(m[1], item, names, values);
    const b = evaluateSetValue(m[2], item, names, values);
    return [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])];
  }

  // `+`/`-` at PAREN DEPTH ZERO only. A regex cannot do this: the counter
  // idiom the whole repository uses is
  // `SET n = if_not_exists(n, :zero) + :one`, and any pattern that finds the
  // `+` also has to know the `(` before it is balanced. Guarding with "the left
  // side contains no bracket" was the first attempt and it rejected exactly
  // that expression, leaving every counter unset.
  const split = topLevelArithmetic(e);
  if (split) {
    const a = evaluateSetValue(split.left, item, names, values);
    const b = evaluateSetValue(split.right, item, names, values);
    return split.op === "+" ? Number(a || 0) + Number(b || 0) : Number(a || 0) - Number(b || 0);
  }

  if (e.startsWith(":")) return valueOf(e, values);
  return readPath(item, pathOf(e, names));
}

/**
 * Apply an UpdateExpression to a (mutable) item. SET and REMOVE only — nothing
 * in this repository writes ADD or DELETE, and one that appears should surface
 * here rather than be dropped.
 */
export function applyUpdate(expr, item, names, values) {
  const clauses = String(expr).split(/\b(SET|REMOVE|ADD|DELETE)\b/i).filter((s) => s.trim());
  for (let i = 0; i < clauses.length; i += 2) {
    const verb = clauses[i].trim().toUpperCase();
    const body = (clauses[i + 1] || "").trim();
    if (verb === "SET") {
      for (const assignment of splitArgs(body)) {
        const eq = assignment.indexOf("=");
        if (eq < 0) throw new Error(`malformed SET clause: ${assignment}`);
        writePath(item, pathOf(assignment.slice(0, eq), names), evaluateSetValue(assignment.slice(eq + 1), item, names, values));
      }
    } else if (verb === "REMOVE") {
      for (const target of splitArgs(body)) deletePath(item, pathOf(target, names));
    } else {
      throw new Error(`unsupported update action: ${verb}`);
    }
  }
  return item;
}

/** Comma-split that respects parentheses — `if_not_exists(a, :z)` is one arg. */
function splitArgs(body) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      out.push(body.slice(start, i));
      start = i + 1;
    }
  }
  out.push(body.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

/** ProjectionExpression -> a copy carrying only the named attributes. */
export function project(item, expr, names) {
  if (!expr || !item) return item;
  const out = {};
  for (const raw of splitArgs(expr)) {
    const path = pathOf(raw, names);
    const v = readPath(item, path);
    if (v !== undefined) writePath(out, path, v);
  }
  return out;
}
