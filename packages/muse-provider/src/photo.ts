/**
 * "DO YOU HAVE THIS?" — a customer sends a photo and nothing else.
 *
 * Two Meta models, in order:
 *   1. `sam-3.1` finds the thing. A short noun phrase and the photo give back boxes in source
 *      pixels; the phrase matters ("bracelet" missed an arm bracelet that "jewelry" found, measured
 *      2026-10-27), so the shop's own words are tried in turn and the largest match wins.
 *   2. Muse Spark looks at the photo and describes what is inside that box as one JSON object the
 *      catalogue can be searched with: category, colours, materials, stones, style, keywords.
 * No cropping library: the box is told to the model in words, and it answers about that region.
 * The catalogue search itself belongs to the host (a shop's own index); this returns the words.
 *
 * A Messenger photo is given as its bytes (`imageDataUri`): Meta cannot fetch a Facebook CDN link.
 */
import { chat, type ChatOptions, type MuseEndpoint } from './chat.js';
import { largestMatch, segment, type SamBox, type SamMatch } from './sam.js';

/**
 * A picture as Meta's door takes it. The Meta Model API fetches an https picture itself, but not from every
 * host: a Facebook CDN link, where Messenger keeps a customer's photo, is answered 400 `media_url_not_fetchable`
 * by chat and SAM alike, while the same picture's bytes are taken (measured 2026-10-28, 6 KB to 6.5 MB). So the
 * picture is fetched here and given as a data URI, typed by the server that sent it. A data URI is kept as it is.
 */
export async function imageDataUri(url: string, opts: { fetchFn?: typeof fetch; timeoutMs?: number } = {}): Promise<string> {
  if (/^data:/i.test(url)) return url;
  const res = await (opts.fetchFn ?? fetch)(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000) });
  if (!res.ok) throw new Error(`picture fetch ${res.status}`);
  const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (!type.startsWith('image/')) throw new Error(`picture fetch: ${type || 'no type'}, not a picture`);
  return `data:${type};base64,${Buffer.from(await res.arrayBuffer()).toString('base64')}`;
}

export interface ProductDescription {
  /** What kind of thing: "ring", "hand chain", "earrings", "handbag", … */
  category: string;
  colors: string[];
  materials: string[];
  /** Gems, prints, fabrics: what a shop lists under attributes. */
  features: string[];
  style: string;
  /** Words to search a catalogue with, in the shop's language, most specific first. */
  keywords: string[];
  /** One sentence a person would say about it. */
  summary: string;
}

export interface PhotoMatch {
  /** Where SAM found it, or null when no phrase matched (the model then describes the whole photo). */
  box: SamBox | null;
  phrase: string | null;
  description: ProductDescription;
  usage: { samCalls: number; chatTokensIn: number; chatTokensOut: number };
  latencyMs: number;
}

const EMPTY: ProductDescription = { category: '', colors: [], materials: [], features: [], style: '', keywords: [], summary: '' };

/** The model's JSON, read defensively: a missing field is empty, never a crash. */
export function readDescription(text: string): ProductDescription {
  const start = text.indexOf('{'); const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return { ...EMPTY, summary: text.trim().slice(0, 300) };
  try {
    const d = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    const words = (v: unknown): string[] => Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : typeof v === 'string' && v.trim() ? [v.trim()] : [];
    return {
      category: typeof d['category'] === 'string' ? d['category'].trim() : '',
      colors: words(d['colors']), materials: words(d['materials']), features: words(d['features']),
      style: typeof d['style'] === 'string' ? d['style'].trim() : '',
      keywords: words(d['keywords']), summary: typeof d['summary'] === 'string' ? d['summary'].trim() : '',
    };
  } catch { return { ...EMPTY, summary: text.trim().slice(0, 300) }; }
}

/** The question put to Muse Spark beside the photo. Exported so a test can read it. */
export function describePrompt(box: SamBox | null, language: string): string {
  const where = box
    ? `Look only at the item inside the box with corners (${box.x1}, ${box.y1}) and (${box.x2}, ${box.y2}) of this ${box.frameWidth}x${box.frameHeight} photo.`
    : 'Look at the main item in this photo.';
  return `${where} Describe it for a shop's catalogue search. Answer with ONE JSON object and nothing else: `
    + `{"category": "<kind of item, two words at most>", "colors": [...], "materials": [...], "features": [<gems, prints, fabrics, closures, notable parts>], `
    + `"style": "<one short phrase>", "keywords": [<6 to 10 search words, most specific first>], "summary": "<one sentence>"}. `
    + `Write the values in ${language}. Say only what is visible; never guess a brand or a price.`;
}

export async function describeProduct(endpoint: MuseEndpoint, imageUrl: string, opts: { box?: SamBox | null; language?: string; chat?: ChatOptions } = {}): Promise<{ description: ProductDescription; tokensIn: number; tokensOut: number }> {
  const r = await chat(endpoint, [{ role: 'user', content: [{ type: 'text', text: describePrompt(opts.box ?? null, opts.language ?? 'English') }, { type: 'image_url', image_url: { url: imageUrl } }] }],
    { reasoningEffort: 'low', maxTokens: 1500, responseFormat: { type: 'json_object' }, ...(opts.chat ?? {}) });
  return { description: readDescription(r.text), tokensIn: r.usage.promptTokens, tokensOut: r.usage.completionTokens };
}

export interface PhotoMatchOptions {
  /** Noun phrases to try in turn: the shop's own kinds of things ("ring", "necklace"), then a wide one ("jewelry"). */
  phrases?: string[];
  language?: string;
  /** Test seams. */
  segmentFn?: typeof segment;
  describeFn?: typeof describeProduct;
}

export const DEFAULT_PHRASES = ['jewelry', 'bag', 'shoes', 'clothing', 'watch', 'product'];

/**
 * Find the thing, then describe it. The first phrase that finds something decides the box. `imageUrl` is a link
 * Meta can fetch or a data URI; a Messenger photo goes as its bytes (`imageDataUri`), fetched once for every call.
 */
export async function photoMatch(metaKey: string, endpoint: MuseEndpoint, imageUrl: string, opts: PhotoMatchOptions = {}): Promise<PhotoMatch> {
  const t0 = Date.now();
  const seg = opts.segmentFn ?? segment; const describe = opts.describeFn ?? describeProduct;
  let found: { phrase: string; match: SamMatch } | null = null; let samCalls = 0;
  for (const phrase of opts.phrases ?? DEFAULT_PHRASES) {
    samCalls += 1;
    const r = await seg(metaKey, imageUrl, phrase);
    const best = largestMatch(r.matches);
    if (best) { found = { phrase, match: best }; break; }
  }
  const d = await describe(endpoint, imageUrl, { box: found?.match.box ?? null, language: opts.language });
  return { box: found?.match.box ?? null, phrase: found?.phrase ?? null, description: d.description,
    usage: { samCalls, chatTokensIn: d.tokensIn, chatTokensOut: d.tokensOut }, latencyMs: Date.now() - t0 };
}

/** One line a reply engine can put into the turn: what the customer showed, in words the catalogue is searched with. */
export function photoFact(m: PhotoMatch): string {
  const d = m.description;
  const bits = [d.category, ...d.colors.slice(0, 2), ...d.materials.slice(0, 2), ...d.features.slice(0, 3)].filter(Boolean);
  const said = d.summary || bits.join(', ');
  const where = m.box ? ` (found as "${m.phrase}")` : '';
  // a summary that ends its own sentence is not given a second full stop
  const stop = where || !/[.!?]$/.test(said) ? '.' : '';
  return `${said}${where}${stop} Search words: ${d.keywords.join(', ') || bits.join(', ')}`;
}
