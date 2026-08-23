import { Fragment } from 'react'

const INLINE_RE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\([^)\s]+\))/g

export function renderInline(text) {
  const out = []
  let last = 0
  let k = 0
  let m
  const re = new RegExp(INLINE_RE)
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const tok = m[0]
    if (tok.startsWith('`')) {
      out.push(<code key={k++}>{tok.slice(1, -1)}</code>)
    } else if (tok.startsWith('**')) {
      out.push(<strong key={k++}>{tok.slice(2, -2)}</strong>)
    } else if (tok.startsWith('*')) {
      out.push(<em key={k++}>{tok.slice(1, -1)}</em>)
    } else {
      const lm = tok.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/)
      const url = lm ? lm[2] : ''
      if (lm && /^https?:\/\//i.test(url)) {
        out.push(
          <a key={k++} href={url} target="_blank" rel="noreferrer noopener">{lm[1]}</a>
        )
      } else if (lm) {
        out.push(lm[1])
      } else {
        out.push(tok)
      }
    }
    last = re.lastIndex
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

// Split a GFM table row into trimmed cells, tolerating optional leading/trailing
// pipes: "| a | b |" → ["a","b"].
function splitRow(line) {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|')) s = s.slice(0, -1)
  return s.split('|').map(c => c.trim())
}

const isTableSep = line => /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(line) && line.includes('-')
const isTableRow = line => line.includes('|')

// Parse the alignment row into 'left' | 'center' | 'right' | null per column.
function parseAlign(sep) {
  return splitRow(sep).map(c => {
    const l = c.startsWith(':')
    const r = c.endsWith(':')
    if (l && r) return 'center'
    if (r) return 'right'
    if (l) return 'left'
    return null
  })
}

// LLM answers frequently arrive with LITERAL escape sequences ("\n", "\t")
// instead of real newlines/tabs — e.g. when the markdown was JSON-encoded a
// second time upstream. Without this, a whole table collapses onto one line and
// renders as raw pipe text. Convert the common literals back to real characters
// so the block parser can see structure. (A real newline in the source is left
// untouched; only backslash-escaped ones are normalized.)
function normalize(src) {
  if (!src.includes('\\')) return src
  return src
    .replace(/\r\n/g, '\n')
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '  ')
    .replace(/\\\|/g, '|')
}

// `hardBreaks`: CommonMark treats a single newline inside a paragraph as a
// soft wrap (joined with a space) — correct for LLM-authored prose (reports,
// descriptions, contribution answers), which relies on that to reflow long
// paragraphs. Pasted documents (docs 20 §8) are not authored that way: a
// person's line breaks are meaningful, so callers rendering raw pasted text
// pass `hardBreaks` to keep every `\n` as a visible break instead of
// collapsing the whole paragraph onto one line.
export function Markdown({ text, hardBreaks = false }) {
  const src = normalize(String(text || ''))
  // Split on fenced code blocks first (odd segments are code).
  const segments = src.split('```')
  const nodes = []
  let key = 0

  segments.forEach((segment, si) => {
    if (si % 2 === 1) {
      const code = segment.replace(/^[a-zA-Z0-9_-]*\n/, '').replace(/\n$/, '')
      if (code) nodes.push(<pre key={`pre-${key++}`}>{code}</pre>)
      return
    }
    parseBlocks(segment, nodes, () => key++, hardBreaks)
  })

  if (nodes.length === 0) return null
  return <>{nodes}</>
}

// Turn a code-free chunk of markdown into block nodes (tables, headings, lists,
// paragraphs). `nextKey` yields a fresh unique key each call.
function parseBlocks(chunk, nodes, nextKey, hardBreaks) {
  const lines = chunk.split('\n')
  let i = 0
  const margin = () => (nodes.length === 0 ? { margin: 0 } : { margin: '8px 0 0' })

  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()

    // Blank line → skip.
    if (!trimmed) { i++; continue }

    // Table: a header row followed by a separator row (|---|---|).
    if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const header = splitRow(line)
      const align = parseAlign(lines[i + 1])
      i += 2
      const rows = []
      while (i < lines.length && lines[i].trim() && isTableRow(lines[i]) && !isTableSep(lines[i])) {
        rows.push(splitRow(lines[i]))
        i++
      }
      const cellStyle = idx => (align[idx] ? { textAlign: align[idx] } : undefined)
      nodes.push(
        <div key={`tw-${nextKey()}`} className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>{header.map((h, c) => <th key={c} style={cellStyle(c)}>{renderInline(h)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {header.map((_, c) => <td key={c} style={cellStyle(c)}>{renderInline(r[c] ?? '')}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
      continue
    }

    // Heading: #..###### text
    const hm = trimmed.match(/^(#{1,6})\s+(.*)$/)
    if (hm) {
      const level = Math.min(hm[1].length, 6)
      const Tag = `h${Math.min(level + 2, 6)}` // map #→h3 so it fits inside a card
      nodes.push(<Tag key={`h-${nextKey()}`} className="md-h" style={margin()}>{renderInline(hm[2].trim())}</Tag>)
      i++
      continue
    }

    // Unordered list: consecutive -, *, or + bullets.
    if (/^\s*[-*+]\s+/.test(line)) {
      const items = []
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ''))
        i++
      }
      nodes.push(
        <ul key={`ul-${nextKey()}`} className="md-list" style={margin()}>
          {items.map((it, idx) => <li key={idx}>{renderInline(it.trim())}</li>)}
        </ul>
      )
      continue
    }

    // Ordered list: consecutive "1. ", "2) " etc.
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items = []
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ''))
        i++
      }
      nodes.push(
        <ol key={`ol-${nextKey()}`} className="md-list" style={margin()}>
          {items.map((it, idx) => <li key={idx}>{renderInline(it.trim())}</li>)}
        </ol>
      )
      continue
    }

    // Paragraph: gather consecutive non-blank, non-block lines.
    const para = []
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+[.)]\s+/.test(lines[i]) &&
      !/^#{1,6}\s+/.test(lines[i].trim()) &&
      !(isTableRow(lines[i]) && i + 1 < lines.length && isTableSep(lines[i + 1]))
    ) {
      para.push(lines[i].trim())
      i++
    }
    if (para.length) {
      nodes.push(
        <p key={`p-${nextKey()}`} style={margin()}>
          {hardBreaks
            ? para.map((line, li) => (
                <Fragment key={li}>
                  {li > 0 && <br />}
                  {renderInline(line)}
                </Fragment>
              ))
            : renderInline(para.join(' '))}
        </p>
      )
    }
  }
}
