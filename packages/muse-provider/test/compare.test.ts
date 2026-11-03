import { describe, expect, it, vi } from 'vitest';
import { PICTURES_A_CALL, compareQuestion, comparisonContent, pictureMatch, readComparison } from '../src/compare.js';
import { metaEndpoint, type ChatResult } from '../src/chat.js';

const answer = (text: string): ChatResult => ({ text, reasoning: null, toolCalls: [], finishReason: 'stop',
  usage: { promptTokens: 1000, completionTokens: 50, reasoningTokens: 30, cachedTokens: 0 }, model: 'muse-spark-1.3', latencyMs: 5 });

describe('the question and its answer', () => {
  it('asks which numbers show the same piece, and which only look alike, as one JSON object', () => {
    const q = compareQuestion(36);
    expect(q).toContain('Pictures 1 to 36');
    expect(q).toContain('SAME piece');
    expect(q).toContain('{"same": [numbers], "alike": [numbers]}');
  });
  it('keeps only the numbers that were shown, once each; alike never repeats a same', () => {
    expect(readComparison('{"same": [2, 2, 0, 9, "3"], "alike": [3, 4]}', 8)).toEqual({ same: [2, 3], alike: [4] });
    expect(readComparison('Here: {"same": [], "alike": [1]} done', 2)).toEqual({ same: [], alike: [1] });
  });
  it('an answer that is not the object asked for is no comparison', () => {
    for (const bad of ['', 'Picture 3.', '{"same": 3', '{"match": [1]}', '[1]']) expect(readComparison(bad, 5)).toBeNull();
  });
  it('every picture follows its number, the customer\'s first', () => {
    expect(comparisonContent('Q?', 'data:c', ['data:1', 'data:2'])).toEqual([
      { type: 'text', text: 'Q?' }, { type: 'text', text: "Picture 0, the customer's photo:" }, { type: 'image_url', image_url: { url: 'data:c' } },
      { type: 'text', text: 'Picture 1:' }, { type: 'image_url', image_url: { url: 'data:1' } },
      { type: 'text', text: 'Picture 2:' }, { type: 'image_url', image_url: { url: 'data:2' } },
    ]);
  });
});

describe('pictureMatch', () => {
  it('one call for a small catalogue; the numbers become the products\' own ids', async () => {
    const chatFn = vi.fn(async () => answer('{"same": [2], "alike": [1]}'));
    const r = await pictureMatch(metaEndpoint('k'), 'data:c', [{ id: 'r1', picture: 'data:1' }, { id: 'r2', picture: 'data:2' }], { chatFn: chatFn as never });
    expect(r).toMatchObject({ same: ['r2'], alike: ['r1'], calls: 1, usage: { promptTokens: 1000, completionTokens: 50 } });
    expect(chatFn.mock.calls[0]![2]).toMatchObject({ reasoningEffort: 'low', maxTokens: 3000 });
  });
  it(`more than ${PICTURES_A_CALL} photos go in calls of ${PICTURES_A_CALL}, and each answer's numbers are its own call's`, async () => {
    const catalog = Array.from({ length: 85 }, (_, i) => ({ id: `p${i}`, picture: `data:${i}` }));
    const sizes: number[] = [];
    const chatFn = vi.fn(async (_e: unknown, messages: Array<{ content: Array<{ type: string; image_url?: { url: string } }> }>) => {
      const pictures = messages[0]!.content.filter((p) => p.type === 'image_url').slice(1);
      sizes.push(pictures.length);
      return answer(pictures[0]!.image_url!.url === 'data:40' ? '{"same": [1]}' : '{"same": []}');
    });
    const r = await pictureMatch(metaEndpoint('k'), 'data:c', catalog, { chatFn: chatFn as never });
    expect(sizes.sort((a, b) => a - b)).toEqual([5, 40, 40]);
    expect(r.same).toEqual(['p40']);
    expect(r.calls).toBe(3);
    expect(r.usage.promptTokens).toBe(3000);
  });
  it('an answer that is not JSON matches nothing; a failed call throws for the host to decide', async () => {
    const prose = vi.fn(async () => answer('It is picture 1.'));
    expect((await pictureMatch(metaEndpoint('k'), 'data:c', [{ id: 'a', picture: 'data:1' }], { chatFn: prose as never })).same).toEqual([]);
    const failing = vi.fn(async () => { throw new Error('chat 503'); });
    await expect(pictureMatch(metaEndpoint('k'), 'data:c', [{ id: 'a', picture: 'data:1' }], { chatFn: failing as never })).rejects.toThrow('chat 503');
  });
});
