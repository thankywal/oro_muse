/**
 * "Do you have this?" starts with finding the thing in the photo: `sam-3.1` through
 * `POST /v1/responses`. The prompt is a short noun phrase (`input_text`) beside the
 * photo (`input_image`, an https URL or a data URI).
 *
 * The answer is special-token text, one line per frame (one line for a photo):
 *   <0f>0<|box;x1=353;y1=382;x2=453;y2=427;w=537;h=561;c=0.93|><|mask;x=0;y=0;data=46,101,~…|>,1<|box;…|><|mask;…|>
 * An object id, then its box in source pixels (`w`/`h` = the source frame size), then
 * its mask (base85 raster, `H,W,` first). No match = empty text. Confidence `c=` only
 * when `metadata.include_confidence` is "true". Records are parsed by key, never by
 * splitting on commas: the mask payload has commas of its own.
 *
 * For the shop's purpose the BOX is what matters: it crops the product out of the
 * customer's photo before Muse Spark describes it and the catalogue is searched. The
 * mask token is kept raw; `@meta-sam/parser` decodes it when a mask is needed.
 */

export interface SamBox { x1: number; y1: number; x2: number; y2: number; frameWidth: number; frameHeight: number; confidence: number | null }
export interface SamMatch { id: number; box: SamBox; mask: string | null }
export interface SamResult { matches: SamMatch[]; text: string; imagesProcessed: number; latencyMs: number }

export class SamError extends Error {
  constructor(message: string, readonly status: number, readonly body: string) { super(message); this.name = 'SamError'; }
}

const META_RESPONSES = 'https://api.meta.ai/v1/responses';

/** The request body, exported so a test can read it without a network. */
export function samBody(imageUrl: string, phrase: string, opts: { model?: string; includeConfidence?: boolean } = {}): Record<string, unknown> {
  return {
    model: opts.model ?? 'sam-3.1',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: phrase }, { type: 'input_image', image_url: imageUrl }] }],
    ...(opts.includeConfidence === false ? {} : { metadata: { include_confidence: 'true' } }),
    stream: false,
  };
}

function fields(token: string): Record<string, string> {
  const out: Record<string, string> = {};
  // `data=` runs to the end of the token and may hold commas and semicolons' worth of base85.
  const dataAt = token.indexOf('data=');
  const head = dataAt >= 0 ? token.slice(0, dataAt) : token;
  for (const part of head.split(';')) { const eq = part.indexOf('='); if (eq > 0) out[part.slice(0, eq)] = part.slice(eq + 1); }
  if (dataAt >= 0) out['data'] = token.slice(dataAt + 5);
  return out;
}

/** Parses the special-token text of one image (the first frame line). */
export function parseSamText(text: string): SamMatch[] {
  const line = text.split('\n').find((l) => l.trim().length > 0) ?? '';
  const body = line.replace(/^<\d+f>/, '');
  const matches: SamMatch[] = [];
  const re = /(\d+)<\|box;([^|]*)\|>(?:<\|mask;((?:[^|]|\|(?!>))*)\|>)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const b = fields(m[2]!);
    const num = (k: string) => Number(b[k] ?? NaN);
    if ([num('x1'), num('y1'), num('x2'), num('y2')].some((v) => Number.isNaN(v))) continue;
    matches.push({ id: Number(m[1]), box: { x1: num('x1'), y1: num('y1'), x2: num('x2'), y2: num('y2'), frameWidth: num('w') || 0, frameHeight: num('h') || 0,
      confidence: b['c'] !== undefined ? Number(b['c']) : null }, mask: m[3] ?? null });
  }
  return matches;
}

/** Reads a non-streaming Responses answer. Exported for tests and replay. */
export function readSam(raw: string, latencyMs = 0): SamResult {
  const d = JSON.parse(raw) as { output?: Array<{ content?: Array<{ type?: string; text?: string }> }>; usage?: { images_processed?: number } };
  const text = (d.output ?? []).flatMap((o) => o.content ?? []).filter((c) => c.type === 'output_text').map((c) => c.text ?? '').join('');
  return { matches: parseSamText(text), text, imagesProcessed: d.usage?.images_processed ?? 0, latencyMs };
}

/** The largest match first: in a shop photo the product fills the frame. */
export function largestMatch(matches: readonly SamMatch[]): SamMatch | null {
  return [...matches].sort((a, b) => (b.box.x2 - b.box.x1) * (b.box.y2 - b.box.y1) - (a.box.x2 - a.box.x1) * (a.box.y2 - a.box.y1))[0] ?? null;
}

export async function segment(apiKey: string, imageUrl: string, phrase: string, opts: { model?: string; includeConfidence?: boolean; timeoutMs?: number } = {}): Promise<SamResult> {
  const t0 = Date.now();
  const res = await fetch(META_RESPONSES, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(samBody(imageUrl, phrase, opts)), signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000) });
  const raw = await res.text();
  if (!res.ok) throw new SamError(`responses answered ${res.status}`, res.status, raw.slice(0, 2000));
  return readSam(raw, Date.now() - t0);
}
