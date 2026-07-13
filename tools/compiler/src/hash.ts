export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

export function shortHash(input: string): string {
  return fnv1a32(input).toString(16).padStart(8, "0").slice(0, 8);
}
