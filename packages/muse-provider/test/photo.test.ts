import { describe, expect, it, vi } from 'vitest';
import { describePrompt, photoFact, photoMatch, readDescription } from '../src/photo.js';
import { metaEndpoint } from '../src/chat.js';
import type { SamResult } from '../src/sam.js';

const box = { x1: 124, y1: 288, x2: 1137, y2: 1145, frameWidth: 1280, frameHeight: 1280, confidence: 0.86 };
const none: SamResult = { matches: [], text: '', imagesProcessed: 1, latencyMs: 10 };
const ring: SamResult = { matches: [{ id: 0, box, mask: null }], text: 'x', imagesProcessed: 1, latencyMs: 10 };

describe('the description', () => {
  it('reads the model\'s JSON, and takes words for lists', () => {
    const d = readDescription('Here: {"category":"ring","colors":["silver"],"materials":"silver","features":["engraved band"],"style":"plain","keywords":["silver ring","engraved"],"summary":"A plain silver ring."}');
    expect(d).toEqual({ category: 'ring', colors: ['silver'], materials: ['silver'], features: ['engraved band'], style: 'plain', keywords: ['silver ring', 'engraved'], summary: 'A plain silver ring.' });
  });
  it('a model that wrote prose instead is kept as the summary, never a crash', () => {
    expect(readDescription('I see a ring.').summary).toBe('I see a ring.');
    expect(readDescription('{"category": broken').keywords).toEqual([]);
  });
  it('the question names the box when there is one, and the language', () => {
    expect(describePrompt(box, 'Thai')).toContain('corners (124, 288) and (1137, 1145) of this 1280x1280 photo');
    expect(describePrompt(box, 'Thai')).toContain('in Thai');
    expect(describePrompt(null, 'English')).toContain('main item in this photo');
  });
});

describe('finding then describing', () => {
  it('tries the phrases in turn, stops at the first match, and describes that box', async () => {
    const asked: string[] = [];
    const segmentFn = vi.fn(async (_k: string, _u: string, phrase: string) => { asked.push(phrase); return phrase === 'ring' ? ring : none; });
    const describeFn = vi.fn(async (_e: unknown, _u: string, opts: { box?: unknown }) => ({ description: readDescription('{"category":"ring","keywords":["silver ring"],"summary":"A silver ring."}'), tokensIn: 900, tokensOut: 80, _box: opts.box }));
    const m = await photoMatch('k', metaEndpoint('k'), 'https://x/p.jpg', { phrases: ['necklace', 'ring', 'jewelry'], segmentFn: segmentFn as never, describeFn: describeFn as never });
    expect(asked).toEqual(['necklace', 'ring']);
    expect(m.box).toEqual(box); expect(m.phrase).toBe('ring'); expect(m.usage.samCalls).toBe(2);
    expect(describeFn.mock.calls[0]![2]).toMatchObject({ box });
    expect(photoFact(m)).toBe('A silver ring. (found as "ring"). Search words: silver ring');
  });
  it('no phrase matches: the whole photo is described, and the fact says so by leaving the phrase out', async () => {
    const m = await photoMatch('k', metaEndpoint('k'), 'https://x/p.jpg', { phrases: ['ring'], segmentFn: (async () => none) as never,
      describeFn: (async () => ({ description: readDescription('{"category":"handbag","colors":["black"],"materials":["leather"],"keywords":["black leather handbag"],"summary":""}'), tokensIn: 1, tokensOut: 1 })) as never });
    expect(m.box).toBeNull();
    expect(photoFact(m)).toBe('handbag, black, leather. Search words: black leather handbag');
  });
  it('a summary that ends its own sentence is not given a second full stop', () => {
    const m = { box: null, phrase: null, usage: { samCalls: 9, chatTokensIn: 1, chatTokensOut: 1 }, latencyMs: 1,
      description: readDescription('{"category":"icon","keywords":["thumbs-up","like"],"summary":"A yellow cartoon thumbs-up hand."}') };
    expect(photoFact(m)).toBe('A yellow cartoon thumbs-up hand. Search words: thumbs-up, like');
  });
});
