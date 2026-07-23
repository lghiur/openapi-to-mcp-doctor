/**
 * Resolves a finding's JSON path (e.g. ['paths', '/users/{id}', 'get']) to a
 * 1-based line number in the original spec text, so PR annotations land on the
 * offending line. YAML and JSON specs share one code path: the 'yaml' parser
 * handles both and exposes character offsets for every node.
 *
 * When the full path does not exist in the document, the deepest existing
 * ancestor's line is returned instead — an annotation near the problem beats
 * no annotation. Only an unparseable or empty document yields undefined.
 */
import { isMap, isScalar, isSeq, parseDocument } from 'yaml'
import type { Document, Pair, ParsedNode } from 'yaml'

/**
 * Last parsed spec, memoized. Callers resolve every finding of a run against the
 * SAME spec text — dozens to hundreds of calls — so parsing per call made the
 * cost of locating findings scale with (findings × spec size) on multi-MB specs.
 *
 * One entry is enough: the call sites loop over one spec at a time, and the
 * `===` guard is an identity check for the reference they pass each time. The
 * document is read-only here, so sharing it across calls is safe.
 */
let memo: { text: string; doc: Document.Parsed } | null = null

function parseMemoized(specText: string): Document.Parsed {
  if (memo !== null && memo.text === specText) return memo.doc
  const doc = parseDocument(specText)
  memo = { text: specText, doc }
  return doc
}

/** Converts a 0-based character offset into a 1-based line number. */
function offsetToLine(text: string, offset: number): number {
  let line = 1
  const end = Math.min(offset, text.length)
  for (let i = 0; i < end; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) line++
  }
  return line
}

export function resolveSpecLine(
  specText: string,
  path: ReadonlyArray<string | number>,
): number | undefined {
  const doc = parseMemoized(specText)
  if (doc.errors.length > 0) return undefined

  let node: ParsedNode | null = doc.contents
  if (node === null) return undefined

  // Deepest offset resolved so far — starts at the document root.
  let offset = node.range[0]

  for (const segment of path) {
    if (isMap(node)) {
      const pair: Pair<ParsedNode, ParsedNode | null> | undefined = node.items.find(
        (item) => isScalar(item.key) && String(item.key.value) === String(segment),
      )
      if (!pair || !isScalar(pair.key)) break
      // Report the key's line, not the value's — a block map value starts on
      // the following line, which would point past the field being flagged.
      offset = pair.key.range[0]
      node = pair.value
    } else if (isSeq(node) && typeof segment === 'number') {
      const item: ParsedNode | null = node.items[segment] ?? null
      if (item === null) break
      offset = item.range[0]
      node = item
    } else {
      break
    }
    // A key with an empty value has nothing left to descend into.
    if (node === null) break
  }

  return offsetToLine(specText, offset)
}
