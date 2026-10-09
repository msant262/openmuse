/** Edit distance proposes spelling candidates; it does not establish identity. */
export function spellingDistance(left: string, right: string) {
  let row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 0; i < left.length; i++) {
    const next = [i + 1];
    for (let j = 0; j < right.length; j++)
      next.push(Math.min(next[j] + 1, row[j + 1] + 1, row[j] + Number(left[i] !== right[j])));
    row = next;
  }
  return row[right.length];
}
