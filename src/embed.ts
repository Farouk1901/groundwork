// Sentence embeddings that run locally (all-MiniLM-L6-v2, quantised, 384 dimensions).
// No API key, nothing leaves the machine; the model (~25 MB) is downloaded once and cached.
import { pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';

let fe: Promise<FeatureExtractionPipeline> | null = null;
const model = () => (fe ??= pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'q8' }) as Promise<FeatureExtractionPipeline>);

/** Plain text for embedding and search: title first, then the body without code blocks, HTML or long URLs. */
export function cleanText(title: string, body = '', max = 1200): string {
  const b = body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return `${title.trim()}. ${b}`.slice(0, max);
}

export async function embed(texts: string[], batch = 32, onProgress?: (done: number) => void): Promise<number[][]> {
  const m = await model();
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += batch) {
    const t = await m(texts.slice(i, i + batch), { pooling: 'mean', normalize: true });
    out.push(...(t.tolist() as number[][]));
    onProgress?.(out.length);
  }
  return out;
}

export async function embedOne(text: string): Promise<number[]> {
  return (await embed([text]))[0];
}
