// Small text helpers that read a line from start to end exactly once. They replace regular
// expressions whose running time could grow with the square of the input: what they read is
// written by other programs (process lists) or by the agent (commands).

/** `text` without the run of `chars` at its end. */
export function trimEndOf(text, chars) {
  let end = text.length;
  while (end > 0 && chars.includes(text[end - 1])) end--;
  return text.slice(0, end);
}

/** `text` without the run of `chars` at its start. */
export function trimStartOf(text, chars) {
  let start = 0;
  while (start < text.length && chars.includes(text[start])) start++;
  return text.slice(start);
}

/**
 * The first `n` fields of a line separated by spaces or tabs, and what follows them.
 * @returns {string[]|null} n + 1 strings, the last being the rest of the line (trimmed);
 *   null when the line has fewer than n fields
 */
export function fields(line, n) {
  const out = [];
  let i = 0;
  const blank = ch => ch === ' ' || ch === '\t' || ch === '\r';
  for (let k = 0; k < n; k++) {
    while (i < line.length && blank(line[i])) i++;
    const start = i;
    while (i < line.length && !blank(line[i])) i++;
    if (i === start) return null;
    out.push(line.slice(start, i));
  }
  out.push(line.slice(i).trim());
  return out;
}

/** Order by text, character codes as they are: for sorting keys and ISO times. */
export function compareText(a, b) {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}
