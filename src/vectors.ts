// Embeddings in snapshots travel as int8 (base64), shared by Node.js and the browser.

/** Embeddings travel as int8 (base64): 384 bytes per text instead of 1.5 KB, cosine barely moves. */
export function decodeVectors(b64: string, dim: number, scale: number): number[][] {
  const bin = atob(b64);
  const out: number[][] = [];
  for (let i = 0; i < bin.length; i += dim) {
    const v = new Array<number>(dim);
    let n = 0;
    for (let j = 0; j < dim; j++) { const x = ((bin.charCodeAt(i + j) << 24) >> 24) / scale; v[j] = x; n += x * x; }
    n = Math.sqrt(n) || 1;
    for (let j = 0; j < dim; j++) v[j] /= n;
    out.push(v);
  }
  return out;
}
