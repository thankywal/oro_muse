import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { phrasesOf, searchCatalogue, tokens, type Item } from '../src/catalogue.js';
import { answer, FALLBACK, Memory, PHOTO_MARK, systemPrompt, VOICE_MARK, type Deps, type Shop } from '../src/assistant.js';
import { fromMeta, signed, turnsOf, verifyChallenge } from '../src/messenger.js';
import type { PhotoMatch } from '../../packages/muse-provider/src/index.js';

const { shop, items } = JSON.parse(readFileSync(new URL('../shop.json', import.meta.url), 'utf8')) as { shop: Shop; items: Item[] };

describe('the catalogue', () => {
  it('words are folded: case, plurals, short words', () => {
    expect(tokens('Gold Rings, a ring and 2 BANGLES')).toEqual(['gold', 'ring', 'and', 'bangle']);
  });
  it('the search ranks by shared words: the kind of thing first, then the name, then the rest', () => {
    expect(searchCatalogue(items, 'ruby ring gold').map((s) => `${s.item.name}=${s.score}`)).toEqual(['Ruby Dome Ring=6', 'Sapphire Halo Ring=4', 'Plain Silver Band=3']);
    expect(searchCatalogue(items, 'gold').map((s) => s.item.name)).toEqual(['Hammered Gold Cuff', 'Twisted Gold Bangle', 'Ruby Dome Ring']);
    expect(searchCatalogue(items, 'pearls').map((s) => s.item.name)).toEqual(['Baroque Pearl Rope']);
    expect(searchCatalogue(items, 'sneakers')).toEqual([]);
    expect(searchCatalogue(items, '')).toEqual([]);
  });
  it('the SAM phrases are the shop\'s categories, then the wide words', () => {
    expect(phrasesOf(items)).toEqual(['ring', 'necklace', 'bracelet', 'pendant', 'jewelry', 'product']);
  });
});

describe('Messenger', () => {
  it('the handshake answers the challenge only for the right token', () => {
    expect(verifyChallenge(new URLSearchParams('hub.mode=subscribe&hub.verify_token=t&hub.challenge=123'), 't')).toBe('123');
    expect(verifyChallenge(new URLSearchParams('hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=123'), 't')).toBeNull();
  });
  it('the signature is the HMAC of the raw body', () => {
    const raw = Buffer.from('{"a":1}');
    const sig = 'sha256=' + createHmac('sha256', 's').update(raw).digest('hex');
    expect(signed(raw, sig, 's')).toBe(true);
    expect(signed(raw, 'sha256=00', 's')).toBe(false);
    expect(signed(raw, undefined, 's')).toBe(false);
  });
  it('events become turns: text, voice, photo; echoes and other objects are skipped', () => {
    const body = { object: 'page', entry: [{ messaging: [
      { sender: { id: '1' }, message: { mid: 'a', text: 'hi' } },
      { sender: { id: '2' }, message: { mid: 'b', attachments: [{ type: 'audio', payload: { url: 'https://cdn.fbsbx.com/v/x.mp4' } }, { type: 'image', payload: { url: 'https://scontent.xx.fbcdn.net/v/p.jpg' } }] } },
      { sender: { id: '3' }, message: { mid: 'c', text: 'echo', is_echo: true } },
      { sender: { id: '4' }, delivery: {} },
    ] }] };
    expect(turnsOf(body)).toEqual([
      { senderId: '1', text: 'hi', audioUrl: null, imageUrl: null },
      { senderId: '2', text: null, audioUrl: 'https://cdn.fbsbx.com/v/x.mp4', imageUrl: 'https://scontent.xx.fbcdn.net/v/p.jpg' },
    ]);
    expect(turnsOf({ object: 'instagram', entry: [] })).toEqual([]);
    expect(turnsOf(null)).toEqual([]);
  });
  it('an attachment is fetched only from Meta\'s own hosts: a forged event naming another address becomes no turn', () => {
    for (const url of ['https://scontent-bkk1-1.xx.fbcdn.net/v/t1.15752-9/p.jpg?oh=x', 'https://cdn.fbsbx.com/v/n.mp4', 'https://lookaside.fbsbx.com/x', 'https://www.facebook.com/x']) expect(fromMeta(url)).toBe(true);
    for (const url of ['http://scontent.xx.fbcdn.net/p.jpg', 'https://127.0.0.1/internal.jpg', 'https://169.254.169.254/latest/meta-data', 'https://evil.example/fbcdn.net/p.jpg', 'https://fbcdn.net.evil.example/p.jpg', 'not a url', '']) expect(fromMeta(url)).toBe(false);
    const forged = { object: 'page', entry: [{ messaging: [{ sender: { id: '9' }, message: { mid: 'z', attachments: [{ type: 'image', payload: { url: 'https://127.0.0.1/internal.jpg' } }] } }] }] };
    expect(turnsOf(forged)).toEqual([]);
    const mixed = { object: 'page', entry: [{ messaging: [{ sender: { id: '9' }, message: { mid: 'z', text: 'look', attachments: [{ type: 'image', payload: { url: 'https://evil.example/p.jpg' } }] } }] }] };
    expect(turnsOf(mixed)).toEqual([{ senderId: '9', text: 'look', audioUrl: null, imageUrl: null }]);
  });
});

describe('the assistant', () => {
  const found: PhotoMatch = { box: { x1: 1, y1: 1, x2: 50, y2: 50, frameWidth: 100, frameHeight: 100, confidence: 0.9 }, phrase: 'ring',
    description: { category: 'ring', colors: ['gold', 'red'], materials: ['gold'], features: ['large red stone'], style: 'statement', keywords: ['ruby ring', 'gold', 'cabochon'], summary: 'A gold ring with a large red cabochon stone.' },
    usage: { samCalls: 1, chatTokensIn: 900, chatTokensOut: 80 }, latencyMs: 5 };
  function deps(reply = 'Yes, we have it.'): { deps: Deps; calls: string[]; messages: unknown[][] } {
    const calls: string[] = []; const messages: unknown[][] = [];
    return { calls, messages, deps: {
      chat: vi.fn(async (m: unknown[]) => { calls.push('chat'); messages.push(m); return reply; }),
      fetchBytes: vi.fn(async (url: string) => { calls.push(`fetch ${url}`); return new Uint8Array([1]); }),
      transcribe: vi.fn(async () => { calls.push('transcribe'); return ' Do you have a ruby ring? '; }),
      photo: vi.fn(async (_u: string, phrases: string[]) => { calls.push(`photo ${phrases.join(',')}`); return found; }),
    } };
  }
  const lastUser = (m: unknown[]): string => (m[m.length - 1] as { content: string }).content;

  it('text: the system prompt carries the shop and the catalogue, the turn is remembered', async () => {
    const d = deps(); const memory = new Memory();
    const r = await answer({ senderId: 'c1', text: ' how much is the locket? ' }, { shop, items, memory, deps: d.deps });
    expect(r).toMatchObject({ text: 'Yes, we have it.', imageUrl: null, heard: null, shown: null, matches: [] });
    const m = d.messages[0]!;
    expect((m[0] as { role: string; content: string }).content).toBe(systemPrompt(shop, items));
    expect(systemPrompt(shop, items)).toContain('- Oval Silver Locket (pendant): 95 USD.');
    expect(lastUser(m)).toBe('how much is the locket?');
    expect(memory.recall('c1')).toEqual([{ role: 'user', content: 'how much is the locket?' }, { role: 'assistant', content: 'Yes, we have it.' }]);
    await answer({ senderId: 'c1', text: 'and the band?' }, { shop, items, memory, deps: d.deps });
    expect(d.messages[1]).toHaveLength(4);
  });

  it('a voice note is fetched, transcribed and marked; typed words stay first', async () => {
    const d = deps();
    const r = await answer({ senderId: 'c2', text: 'hello', audioUrl: 'https://cdn/note.mp4' }, { shop, items, memory: new Memory(), deps: d.deps });
    expect(r.heard).toBe('Do you have a ruby ring?');
    expect(lastUser(d.messages[0]!)).toBe(`hello\n${VOICE_MARK} Do you have a ruby ring?`);
    expect(d.calls).toEqual(['fetch https://cdn/note.mp4', 'transcribe', 'chat']);
  });

  it('a photo is found and described with the shop\'s phrases, the catalogue is searched, the best match\'s picture is sent', async () => {
    const d = deps('That is our Ruby Dome Ring, 320 USD.');
    const r = await answer({ senderId: 'c3', imageUrl: 'https://cdn/p.jpg' }, { shop, items, memory: new Memory(), deps: d.deps });
    expect(d.calls).toEqual(['photo ring,necklace,bracelet,pendant,jewelry,product', 'chat']);
    expect(r.shown).toBe('A gold ring with a large red cabochon stone. (found as "ring"). Search words: ruby ring, gold, cabochon');
    expect(r.matches.map((i) => i.name)).toEqual(['Ruby Dome Ring', 'Sapphire Halo Ring', 'Plain Silver Band']);
    expect(r.imageUrl).toBe(items.find((i) => i.name === 'Ruby Dome Ring')!.imageUrl);
    expect(lastUser(d.messages[0]!)).toBe(`${PHOTO_MARK} ${r.shown}\nCatalogue items that match the photo: Ruby Dome Ring (320 USD); Sapphire Halo Ring (540 USD); Plain Silver Band (48 USD)`);
  });

  it('the picture is of the item the reply names, not the best-scored match; no name, no picture', async () => {
    const second = deps('Not quite, but the Sapphire Halo Ring (540 USD) is close.');
    const r2 = await answer({ senderId: 'c5', imageUrl: 'https://cdn/p.jpg' }, { shop, items, memory: new Memory(), deps: second.deps });
    expect(r2.imageUrl).toBe(items.find((i) => i.name === 'Sapphire Halo Ring')!.imageUrl);
    const none = deps('Sorry, we do not have that one.');
    const r3 = await answer({ senderId: 'c6', imageUrl: 'https://cdn/p.jpg' }, { shop, items, memory: new Memory(), deps: none.deps });
    expect(r3.imageUrl).toBeNull(); expect(r3.matches).toHaveLength(3);
  });

  it('the photo beside the shop\'s own photos: the piece Muse Spark says is the same one is named first, whatever the words found', async () => {
    const d = deps('That is our Plain Silver Band, 48 USD.');
    const compare = vi.fn(async (_u: string, _items: unknown[]) => ({ same: ['r1'] }));
    const r = await answer({ senderId: 'c7', imageUrl: 'https://cdn/p.jpg' }, { shop, items, memory: new Memory(), deps: { ...d.deps, compare } });
    expect(compare).toHaveBeenCalledWith('https://cdn/p.jpg', items);
    expect(r.matches.map((i) => i.name)).toEqual(['Plain Silver Band', 'Ruby Dome Ring', 'Sapphire Halo Ring']);
    expect(lastUser(d.messages[0]!)).toContain(`${PHOTO_MARK} Same item as our Plain Silver Band (48 USD).`);
    expect(r.imageUrl).toBe(items.find((i) => i.name === 'Plain Silver Band')!.imageUrl);
    // a comparison that fails leaves the words' search as it was
    const failed = deps('That is our Ruby Dome Ring, 320 USD.');
    const r2 = await answer({ senderId: 'c8', imageUrl: 'https://cdn/p.jpg' }, { shop, items, memory: new Memory(), deps: { ...failed.deps, compare: vi.fn(async () => { throw new Error('chat 503'); }) } });
    expect(r2.matches.map((i) => i.name)).toEqual(['Ruby Dome Ring', 'Sapphire Halo Ring', 'Plain Silver Band']);
    expect(lastUser(failed.messages[0]!)).not.toContain('Same item as our');
  });

  it('an empty answer becomes the fallback; an empty turn is still answered', async () => {
    const d = deps('   ');
    const r = await answer({ senderId: 'c4' }, { shop, items, memory: new Memory(), deps: d.deps });
    expect(r.text).toBe(FALLBACK);
    expect(lastUser(d.messages[0]!)).toContain('neither text, a voice note nor a photo');
  });
});
