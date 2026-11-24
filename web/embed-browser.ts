// The same embedding model as on Node.js (all-MiniLM-L6-v2, quantised), run in the browser with Transformers.js.
// It is only loaded when someone describes a change in words; ticket numbers use the stored embeddings.
export { cleanText } from '../src/text.js';

type Extractor = (texts: string[], o: { pooling: 'mean'; normalize: boolean }) => Promise<{ tolist(): number[][] }>;
let fe: Promise<Extractor> | null = null;
const TRANSFORMERS = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2/dist/transformers.min.js';

const model = () => (fe ??= import(/* @vite-ignore */ TRANSFORMERS)
  .then((m: { pipeline: (task: string, model: string, o: object) => Promise<Extractor> }) => m.pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'q8' })));

export async function embed(texts: string[], batch = 16, onProgress?: (done: number) => void): Promise<number[][]> {
  const m = await model();
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += batch) {
    out.push(...(await m(texts.slice(i, i + batch), { pooling: 'mean', normalize: true })).tolist());
    onProgress?.(out.length);
  }
  return out;
}

export async function embedOne(text: string): Promise<number[]> {
  return (await embed([text]))[0];
}
