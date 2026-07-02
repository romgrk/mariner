/* Shell-style glob matching for "Select Items Matching" (Ctrl+S).
 *
 * Supports the two wildcards GLib's GPatternSpec (and nautilus) use — `*` (any
 * run, including empty) and `?` (exactly one character) — with every other
 * character matched literally. Matching is case-insensitive: `*.png` also
 * selects `PHOTO.PNG`, which is friendlier than GPatternSpec's case-sensitive
 * default for a quick select-by-name. The whole name must match (the pattern is
 * anchored), so `*.txt` selects `notes.txt` but not `txt.old`. */

/* Compile `glob` to an anchored, case-insensitive RegExp, or null if it is
 * empty/whitespace (which should match nothing). */
export function globToRegExp(glob: string): RegExp | null {
  const pattern = glob.trim()
  if (!pattern) return null
  let re = ''
  for (const ch of pattern) {
    if (ch === '*') re += '.*'
    else if (ch === '?') re += '.'
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')   // literal, regex-escaped
  }
  try { return new RegExp('^' + re + '$', 'i') } catch { return null }
}

/* A predicate that tests a name against `pattern`. An empty pattern yields a
 * matcher that rejects everything (so an accidental empty selection is a no-op). */
export function globMatcher(pattern: string): (name: string) => boolean {
  const re = globToRegExp(pattern)
  return re ? (name: string) => re.test(name) : () => false
}
