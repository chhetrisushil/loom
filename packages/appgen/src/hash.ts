// Self-contained FNV-1a (32-bit). @loom/appgen keeps its OWN copy of this tiny hash
// rather than importing one from a kernel package (e.g. @loom/compiler): the AI-native
// DX layer must never couple to — let alone modify — framework internals. This is used
// only by the appgen safety gate to recognise an untouched generated handler stub.
export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}
