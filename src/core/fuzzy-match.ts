/*
 * Vendored from ~/src/zym (src/ui/fuzzyMatch.ts) — kept verbatim so it can be
 * re-synced. Used by the command palette (src/ui/command-palette.ts) for ranking.
 *
 * fuzzyMatch — the picker's scoring core, kept free of any GTK imports so it can
 * be unit-tested on its own and reused by anything that needs subsequence
 * ranking.
 *
 * The scoring is a port of jhawthorn/fzy's algorithm (see its `match.c`): a
 * Smith-Waterman-style dynamic program over two matrices, with bonuses that
 * reward matches at the start of words / path segments and penalise the gaps
 * between matched characters. It produces noticeably better rankings than a
 * greedy scan for the short queries a picker sees, and reconstructs which
 * characters matched for highlighting.
 *
 * Three extensions on top of stock fzy:
 *   - `boostFrom`: a char offset (e.g. a filename's start) whose matches score
 *     higher, so filename hits outrank directory hits.
 *   - `maxTypos`: allow up to N query characters to go unmatched (a heavily
 *     penalised fallback), so a small typo still finds its target.
 *   - `ignoreTail`: drop stock fzy's penalty for characters after the last
 *     match, so equally-good matches no longer rank by length (type-to-select
 *     lands on the first such row in view order rather than the shortest).
 *
 * Matching is case-insensitive by default, but `smartcase` (on by default)
 * makes it case-sensitive as soon as the query contains an uppercase letter —
 * the familiar editor convention where a lowercase query matches anything but
 * `Foo` only matches `Foo`.
 */

export interface FuzzyMatch {
  /** Higher is a better match. */
  score: number;
  /** Indices in the text that the query matched, in order. */
  positions: number[];
}

/**
 * A candidate's query-independent precompute, shared across every keystroke.
 * `lowerText`/`bonus` depend only on the text, so a picker prepares each item
 * once (see Picker's `preparedCache`) instead of recomputing per keystroke.
 * `bonus` is derived from the original-case text (camelCase humps), so a single
 * `Prepared` serves both smartcase-sensitive and -insensitive matching.
 */
export interface Prepared {
  /** Original text — the haystack for a case-sensitive (smartcase) match. */
  text: string;
  /** Lower-cased text — the haystack for a case-insensitive match. */
  lowerText: string;
  /** Per-position match bonus (`precomputeBonus`); query- and case-independent. */
  bonus: Float64Array;
}

export interface FuzzyOptions {
  /** Char offset in `text` from which matches score higher (e.g. a filename). */
  boostFrom?: number;
  /** Max query chars allowed to go unmatched for a typo-tolerant fallback. */
  maxTypos?: number;
  /**
   * Case-sensitive when the query contains an uppercase letter, otherwise
   * case-insensitive. Defaults to `true`. Set `false` to always ignore case.
   */
  smartcase?: boolean;
  /**
   * Ignore characters trailing the last match when scoring, so two names that
   * match the query equally well no longer rank by length (stock fzy's trailing
   * gap makes the shorter one win). Off by default — a picker keeps the
   * shorter-is-better bias; type-to-select turns it on so it lands on the first
   * equally-good row in view order instead of the shortest name.
   */
  ignoreTail?: boolean;
}

// fzy's scoring weights (see jhawthorn/fzy match.h). Scores are small floats; a
// perfect run accrues ~1 per consecutive character, while gaps cost fractions.
const SCORE_MIN = -Infinity;
const SCORE_MAX = Infinity;
const GAP_LEADING = -0.005; // each char skipped before the first match
const GAP_TRAILING = -0.005; // each char after the last match
const GAP_INNER = -0.01; // each char skipped between two matches
const MATCH_CONSECUTIVE = 1.0; // match immediately following the previous one
const MATCH_SLASH = 0.9; // match right after a path separator
const MATCH_WORD = 0.8; // match right after a word separator (- _ space)
const MATCH_CAPITAL = 0.7; // match at a camelCase hump
const MATCH_DOT = 0.6; // match right after a dot
const BOOST_PRIMARY = 0.4; // added to matches at/after `boostFrom`
const TYPO_PENALTY = -1.0; // per unmatched query char in the typo fallback

// Reused DP scratch for `fzyMatch`, grown on demand to the current `m*n` and
// indexed `[i*n + j]` (stride = the current haystack length). Matching is
// strictly sequential and single-threaded, so two module-level buffers replace
// the per-call allocation of `2*m` Float64Arrays — the forward pass writes every
// cell of the current `m*n` window before the backtrace reads it, and cells
// beyond it are never touched.
let scratchD = new Float64Array(0);
let scratchM = new Float64Array(0);
function ensureScratch(size: number): void {
  if (scratchD.length < size) {
    scratchD = new Float64Array(size);
    scratchM = new Float64Array(size);
  }
}

/**
 * Score `text` against `query` as a fuzzy (subsequence) match, recording which
 * characters matched. Returns `null` when `query` cannot be matched (not a
 * subsequence, even allowing `maxTypos` skipped query chars). An empty query
 * matches everything with a neutral score.
 *
 * A standalone convenience that computes the query's case + the text's
 * `Prepared` on the fly. Hot callers (the picker) instead precompute `Prepared`
 * once per item and call `fuzzyMatchPrepared` directly.
 */
export function fuzzyMatch(query: string, text: string, options: FuzzyOptions = {}): FuzzyMatch | null {
  if (query.length === 0) return { score: 0, positions: [] };
  // Smartcase (on by default): an uppercase letter in the query opts into a
  // case-sensitive match; an all-lowercase query stays case-insensitive.
  const caseSensitive = (options.smartcase ?? true) && /[A-Z]/.test(query);
  const needle = caseSensitive ? query : query.toLowerCase();
  return fuzzyMatchPrepared(needle, prepare(text), caseSensitive, options.boostFrom, options.maxTypos, options.ignoreTail);
}

/** Build the query-independent `Prepared` for a candidate's text (cache it). */
export function prepare(text: string): Prepared {
  return { text, lowerText: text.toLowerCase(), bonus: precomputeBonus(text) };
}

/**
 * Core matcher over a precomputed `Prepared`. `needle` must already be in the
 * caller's chosen case (lower-cased iff `!caseSensitive`); `caseSensitive`
 * selects the prepared haystack (`text` vs `lowerText`). This is the hot path a
 * picker calls per item with a per-call-constant `needle`/`caseSensitive`.
 */
export function fuzzyMatchPrepared(
  needle: string,
  prepared: Prepared,
  caseSensitive: boolean,
  boostFrom: number = Number.POSITIVE_INFINITY,
  maxTypos: number = 0,
  ignoreTail: boolean = false,
): FuzzyMatch | null {
  if (needle.length === 0) return { score: 0, positions: [] };
  const exact = fzyMatch(needle, prepared, caseSensitive, boostFrom, ignoreTail);
  if (exact) return exact;
  if (maxTypos <= 0) return null;
  return approxMatch(needle, prepared, caseSensitive, boostFrom, maxTypos, ignoreTail);
}

/** Stock fzy: requires `needle` to be a strict subsequence of the haystack. */
function fzyMatch(
  needle: string,
  prepared: Prepared,
  caseSensitive: boolean,
  boostFrom: number,
  ignoreTail: boolean = false,
): FuzzyMatch | null {
  const haystack = caseSensitive ? prepared.text : prepared.lowerText;
  const m = needle.length;
  const n = haystack.length;
  if (m > n) return null;

  // Cheap reject + exact-length shortcut before touching the DP matrices.
  for (let i = 0, j = 0; i < m; i++) {
    while (j < n && haystack[j] !== needle[i]) j++;
    if (j === n) return null;
    j++;
  }
  if (m === n) {
    return { score: SCORE_MAX, positions: Array.from({ length: m }, (_, i) => i) };
  }

  const bonus = prepared.bonus;
  const boostAt = (j: number) => (j >= boostFrom ? BOOST_PRIMARY : 0);

  // D[i*n + j]: best score ending with needle[i] matched at haystack[j].
  // M[i*n + j]: best score for needle[0..i] within haystack[0..j] (running max).
  // Flat, reused buffers (stride = n); see `ensureScratch`.
  ensureScratch(m * n);
  const D = scratchD;
  const M = scratchM;

  for (let i = 0; i < m; i++) {
    let prevScore = SCORE_MIN;
    // Last needle char: trailing chars decay the running max (favouring shorter
    // names) unless `ignoreTail` zeroes that gap so length stops mattering.
    const gap = i === m - 1 ? (ignoreTail ? 0 : GAP_TRAILING) : GAP_INNER;
    const iBase = i * n;
    const pBase = iBase - n; // (i - 1) * n; only read when i > 0

    for (let j = 0; j < n; j++) {
      if (needle[i] === haystack[j]) {
        let score = SCORE_MIN;
        if (i === 0) {
          score = j * GAP_LEADING + bonus[j];
        } else if (j > 0) {
          score = Math.max(
            M[pBase + j - 1] + bonus[j], // start a fresh match here
            D[pBase + j - 1] + MATCH_CONSECUTIVE, // extend a consecutive run
          );
        }
        if (score !== SCORE_MIN) score += boostAt(j);
        D[iBase + j] = score;
        prevScore = Math.max(score, prevScore + gap);
        M[iBase + j] = prevScore;
      } else {
        D[iBase + j] = SCORE_MIN;
        prevScore = prevScore + gap;
        M[iBase + j] = prevScore;
      }
    }
  }

  // Walk D/M back from the end to recover the matched positions (fzy's
  // match_positions): at each needle char, take the column where the best path
  // matched, preferring the consecutive predecessor.
  const positions = new Array<number>(m);
  let matchRequired = false;
  let j = n - 1;
  for (let i = m - 1; i >= 0; i--) {
    const iBase = i * n;
    const pBase = iBase - n;
    for (; j >= 0; j--) {
      if (
        D[iBase + j] !== SCORE_MIN &&
        (matchRequired || D[iBase + j] === M[iBase + j])
      ) {
        matchRequired =
          i > 0 && j > 0 && M[iBase + j] === D[pBase + j - 1] + MATCH_CONSECUTIVE + boostAt(j);
        positions[i] = j;
        j--;
        break;
      }
    }
  }

  return { score: M[(m - 1) * n + (n - 1)], positions };
}

/**
 * Typo-tolerant fallback: allow up to `maxTypos` query characters to be dropped
 * (an extra / mistyped char the user didn't mean), scoring the best surviving
 * subsequence and penalising each drop so exact matches always rank above it.
 */
function approxMatch(
  needle: string,
  prepared: Prepared,
  caseSensitive: boolean,
  boostFrom: number,
  maxTypos: number,
  ignoreTail: boolean = false,
): FuzzyMatch | null {
  let best: FuzzyMatch | null = null;
  for (let k = 0; k < needle.length; k++) {
    const reduced = needle.slice(0, k) + needle.slice(k + 1);
    if (reduced.length === 0) continue;
    // `needle` is already in the chosen case, so a sliced needle stays consistent
    // with the prepared haystack — carry `caseSensitive` through unchanged.
    const match =
      maxTypos > 1
        ? fzyMatch(reduced, prepared, caseSensitive, boostFrom, ignoreTail) ??
          approxMatch(reduced, prepared, caseSensitive, boostFrom, maxTypos - 1, ignoreTail)
        : fzyMatch(reduced, prepared, caseSensitive, boostFrom, ignoreTail);
    if (match && (!best || match.score > best.score)) best = match;
  }
  if (!best) return null;
  return { score: best.score + TYPO_PENALTY, positions: best.positions };
}

/** Per-position match bonus, from the character preceding each one. */
function precomputeBonus(text: string): Float64Array {
  const n = text.length;
  const bonus = new Float64Array(n);
  let prev = '/'; // treat the start of the string as a path boundary
  for (let i = 0; i < n; i++) {
    const ch = text[i];
    bonus[i] = charBonus(prev, ch);
    prev = ch;
  }
  return bonus;
}

function charBonus(prev: string, cur: string): number {
  switch (prev) {
    case '/':
    case '\\':
      return MATCH_SLASH;
    case '-':
    case '_':
    case ' ':
    case ':': // namespace separator in command names (e.g. agent:continue)
      return MATCH_WORD;
    case '.':
      return MATCH_DOT;
  }
  // camelCase boundary: a lowercase/digit followed by an uppercase letter.
  if (/[a-z0-9]/.test(prev) && /[A-Z]/.test(cur)) return MATCH_CAPITAL;
  return 0;
}
