/**
 * The assistant: one customer turn (text, a voice note, a photo, or any mix) becomes one reply.
 *   - a voice note is transcribed by muse-voice-transcribe-1.0 and marked "(voice note)";
 *   - a photo goes to SAM 3.1 (the shop's kinds of things are the phrases) and Muse Spark describes the
 *     box as search words; the catalogue is searched with them, and the matches ride in the message;
 *   - Muse Spark 1.3 answers with the shop's catalogue and rules, in the customer's language.
 * The Meta calls sit behind `Deps`, so the tests run without a network and the CLI runs without Messenger.
 */
import { chat, imageDataUri, metaEndpoint, photoFact, photoMatch, toPcmWav, transcribe, wavFormat, type ChatMessage, type PhotoMatch } from '../../packages/muse-provider/src/index.js';
import { catalogueLines, phrasesOf, searchCatalogue, type Item } from './catalogue.js';

export interface Shop { name: string; currency: string; delivery: string; payment: string }
export interface Turn { senderId: string; text?: string | null; audioUrl?: string | null; imageUrl?: string | null }
export interface Reply { text: string; imageUrl: string | null; heard: string | null; shown: string | null; matches: Item[] }
export interface Deps {
  chat(messages: ChatMessage[]): Promise<string>;
  fetchBytes(url: string): Promise<Uint8Array>;
  transcribe(audio: Uint8Array): Promise<string>;
  photo(imageUrl: string, phrases: string[]): Promise<PhotoMatch>;
}

export const VOICE_MARK = '(voice note)';
export const PHOTO_MARK = '(photo)';
export const FALLBACK = 'Sorry, I did not catch that. Could you say it again?';

export function systemPrompt(shop: Shop, items: Item[]): string {
  return [
    `You are the Messenger assistant of ${shop.name}, a small jewellery shop. Answer in the customer's own language, in one to three short sentences, warmly and plainly.`,
    'Use only the catalogue below for items and prices. Never invent an item, a price or a discount. If something is not in the catalogue, say so and offer the nearest item.',
    `Delivery: ${shop.delivery}`,
    `Payment: ${shop.payment}`,
    `A line starting "${VOICE_MARK}" is what the customer said in a voice note; answer it as their words.`,
    `A line starting "${PHOTO_MARK}" is what the customer's photo showed, followed by the catalogue items that match it; say whether we have it and name the match. If nothing matches, say so and offer the nearest item.`,
    '',
    'CATALOGUE',
    catalogueLines(items),
  ].join('\n');
}

/** The last few turns of each customer, in memory: enough for a demo, nothing is stored. */
export class Memory {
  private turns = new Map<string, ChatMessage[]>();
  recall(senderId: string): ChatMessage[] { return this.turns.get(senderId) ?? []; }
  remember(senderId: string, user: string, assistant: string): void {
    const t = [...this.recall(senderId), { role: 'user' as const, content: user }, { role: 'assistant' as const, content: assistant }];
    this.turns.set(senderId, t.slice(-12));
  }
}

export async function answer(turn: Turn, ctx: { shop: Shop; items: Item[]; memory: Memory; deps: Deps }): Promise<Reply> {
  const said: string[] = [];
  let heard: string | null = null; let shown: string | null = null; let matches: Item[] = [];
  if (turn.text?.trim()) said.push(turn.text.trim());
  if (turn.audioUrl) {
    heard = (await ctx.deps.transcribe(await ctx.deps.fetchBytes(turn.audioUrl))).trim();
    if (heard) said.push(`${VOICE_MARK} ${heard}`);
  }
  if (turn.imageUrl) {
    const m = await ctx.deps.photo(turn.imageUrl, phrasesOf(ctx.items));
    shown = photoFact(m);
    matches = searchCatalogue(ctx.items, [m.description.category, ...m.description.keywords].join(' ')).map((s) => s.item);
    said.push(`${PHOTO_MARK} ${shown}`);
    said.push(matches.length
      ? `Catalogue items that match the photo: ${matches.map((i) => `${i.name} (${i.price} ${i.currency})`).join('; ')}`
      : 'No catalogue item matches the photo.');
  }
  if (said.length === 0) said.push('(the customer sent something that is neither text, a voice note nor a photo)');
  const user = said.join('\n');
  const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt(ctx.shop, ctx.items) }, ...ctx.memory.recall(turn.senderId), { role: 'user', content: user }];
  const text = (await ctx.deps.chat(messages)).trim() || FALLBACK;
  ctx.memory.remember(turn.senderId, user, text);
  // The picture sent is of the item the reply names, never merely the best-scored match: measured 2026-10-27,
  // a ruby ring photo scored "Solitaire Diamond Ring" first while the reply rightly said "Ruby Dome Ring".
  const named = matches.find((i) => text.toLowerCase().includes(i.name.toLowerCase()));
  return { text, imageUrl: named?.imageUrl ?? null, heard, shown, matches };
}

/** The real doors, all on the Meta Model API with one key. */
export function museDeps(metaKey: string): Deps {
  const endpoint = metaEndpoint(metaKey);
  return {
    chat: async (messages) => (await chat(endpoint, messages, { reasoningEffort: 'low', maxTokens: 1500 })).text,
    fetchBytes: async (url) => {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`fetch ${r.status} for ${url.slice(0, 80)}`);
      return new Uint8Array(await r.arrayBuffer());
    },
    transcribe: async (bytes) => {
      const wav = wavFormat(bytes).ok ? bytes : await toPcmWav(bytes);
      return (await transcribe(metaKey, wav, { mode: 'ENDPOINTING' })).transcript;
    },
    // Messenger's photo is a Facebook CDN link, which Meta cannot fetch: SAM and Muse Spark are given its bytes.
    photo: async (url, phrases) => photoMatch(metaKey, endpoint, await imageDataUri(url), { phrases }),
  };
}
