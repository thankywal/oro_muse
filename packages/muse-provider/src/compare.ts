/**
 * "IS THIS ONE OF YOURS?" — the customer's photo beside the shop's own product photos.
 *
 * Words are not enough. A shop's catalogue rarely says what a piece looks like (two items named "Diamond Ring",
 * one "Gold Pendant"), so a photo described in words cannot be told from the shop's other pieces of the same
 * kind, and an honest assistant has to ask the owner. Pictures can be: Muse Spark is shown the
 * customer's photo and the shop's product photos, each after its number, in ONE call, and says which numbers
 * show the same piece, and which only look alike.
 *
 * Measured 2026-11-03 on the Meta Model API:
 *   - public-domain photos: one customer photo and 40 product photos in one call, 7.5 s; every copy of the right
 *     item found from a cropped, turned photo;
 *   - a jewellery shop's 36 product photos: a forwarded ring, a forwarded pendant and a cropped, turned hand chain
 *     were each named; a pearl rope the shop does not sell matched nothing. 5 to 12 s a call, about 11k prompt
 *     tokens with 512-pixel product photos.
 *
 * More than PICTURES_A_CALL product photos go in calls of that size, side by side. Photos are given as data URIs
 * (`imageDataUri`) or links Meta can fetch; a Facebook CDN link is not one.
 */
import { chat, type ChatOptions, type ChatPart, type MuseEndpoint } from './chat.js';

/** Product photos shown in one call (one customer photo and 40 product photos were measured in one call). */
export const PICTURES_A_CALL = 40;

/** One of the shop's products as it is compared: its own id, and its photo as a data URI or a fetchable link. */
export interface CatalogPicture { id: string; picture: string }

export interface PictureMatch {
  /** The products whose photo shows the same piece as the customer's. */
  same: string[];
  /** The products that only look alike. */
  alike: string[];
  calls: number;
  usage: { promptTokens: number; completionTokens: number };
  latencyMs: number;
}

export function compareQuestion(count: number): string {
  return [
    `Picture 0 is a photo a customer sent to a shop. Pictures 1 to ${count} are the shop's own product photos.`,
    'Which numbers show the SAME piece as picture 0: the same design, not only the same kind of thing? A different angle, crop, light, size or background is still the same piece.',
    'Which numbers only look alike: a similar piece, but you cannot tell it is the same one?',
    'Answer with one JSON object and nothing else: {"same": [numbers], "alike": [numbers]}. Use [] when there are none.',
  ].join(' ');
}

/** The answer's JSON, kept to the numbers that were shown; null when there is no such object. */
export function readComparison(text: string | null | undefined, count: number): { same: number[]; alike: number[] } | null {
  const m = /\{[\s\S]*\}/.exec(text ?? '');
  if (!m) return null;
  let o: unknown;
  try { o = JSON.parse(m[0]); } catch { return null; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const rec = o as Record<string, unknown>;
  if (!Array.isArray(rec['same']) && !Array.isArray(rec['alike'])) return null;
  const numbers = (v: unknown): number[] => Array.isArray(v)
    ? [...new Set(v.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n >= 1 && n <= count))] : [];
  const same = numbers(rec['same']);
  return { same, alike: numbers(rec['alike']).filter((n) => !same.includes(n)) };
}

/** The question, then each picture after its number, the customer's first: the answer's numbers are the pictures'. */
export function comparisonContent(question: string, customer: string, pictures: readonly string[]): ChatPart[] {
  const out: ChatPart[] = [{ type: 'text', text: question }, { type: 'text', text: "Picture 0, the customer's photo:" }, { type: 'image_url', image_url: { url: customer } }];
  pictures.forEach((url, i) => { out.push({ type: 'text', text: `Picture ${i + 1}:` }, { type: 'image_url', image_url: { url } }); });
  return out;
}

/**
 * Which of the shop's products is the one in the customer's photo. An answer that is not the JSON asked for counts
 * as no match in its call; a call that fails throws, and the host decides what the turn does without it.
 */
export async function pictureMatch(
  endpoint: MuseEndpoint, customer: string, catalog: readonly CatalogPicture[],
  opts: { chat?: ChatOptions; chatFn?: typeof chat } = {},
): Promise<PictureMatch> {
  const t0 = Date.now();
  const batches: CatalogPicture[][] = [];
  for (let i = 0; i < catalog.length; i += PICTURES_A_CALL) batches.push(catalog.slice(i, i + PICTURES_A_CALL));
  const answers = await Promise.all(batches.map(async (batch) => {
    const r = await (opts.chatFn ?? chat)(endpoint, [{ role: 'user', content: comparisonContent(compareQuestion(batch.length), customer, batch.map((b) => b.picture)) }],
      { reasoningEffort: 'low', maxTokens: 3000, timeoutMs: 30_000, ...(opts.chat ?? {}) });
    const read = readComparison(r.text, batch.length) ?? { same: [], alike: [] };
    return { same: read.same.map((n) => batch[n - 1]!.id), alike: read.alike.map((n) => batch[n - 1]!.id), usage: r.usage };
  }));
  const same = [...new Set(answers.flatMap((a) => a.same))];
  const alike = [...new Set(answers.flatMap((a) => a.alike))].filter((id) => !same.includes(id));
  return {
    same, alike, calls: batches.length,
    usage: { promptTokens: answers.reduce((n, a) => n + a.usage.promptTokens, 0), completionTokens: answers.reduce((n, a) => n + a.usage.completionTokens, 0) },
    latencyMs: Date.now() - t0,
  };
}
