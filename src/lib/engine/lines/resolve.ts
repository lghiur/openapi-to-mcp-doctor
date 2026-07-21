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
import type { Pair, ParsedNode } from 'yaml'

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
  const doc = parseDocument(specText)
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
