import { afterEach, describe, expect, it, vi } from 'vitest';
import { imageDataUri } from '../src/photo.js';
import { chat, metaEndpoint, MuseError, refusalReason } from '../src/chat.js';
import { SamError, segment } from '../src/sam.js';

// Meta's answer to a Facebook CDN link, 2026-10-28 (chat; SAM said the same of `input[0].content[1]`).
const NOT_FETCHABLE = JSON.stringify({ error: { code: 'media_url_not_fetchable', message: 'failed to download media at messages[0].content[1]: URL is not fetchable by this service' } });

describe('a picture is given as its bytes', () => {
  it('fetched once, typed by the server that sent it', async () => {
    const fetchFn = vi.fn(async () => new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), { headers: { 'content-type': 'image/jpeg; charset=binary' } }));
    expect(await imageDataUri('https://scontent.xx.fbcdn.net/v/p.jpg', { fetchFn: fetchFn as never })).toBe('data:image/jpeg;base64,/9j/4A==');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  it('a data URI is kept as it is, and nothing is fetched', async () => {
    const fetchFn = vi.fn();
    expect(await imageDataUri('data:image/png;base64,AAAA', { fetchFn: fetchFn as never })).toBe('data:image/png;base64,AAAA');
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it('a refused fetch says its status; something that is not a picture says so', async () => {
    await expect(imageDataUri('https://x/p.jpg', { fetchFn: (async () => new Response('gone', { status: 403 })) as never })).rejects.toThrow('picture fetch 403');
    await expect(imageDataUri('https://x/p.jpg', { fetchFn: (async () => new Response('<html>', { headers: { 'content-type': 'text/html' } })) as never })).rejects.toThrow('picture fetch: text/html, not a picture');
  });
});

describe('a refusal says why', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('the code and the start of the words; nothing from a body that says nothing', () => {
    expect(refusalReason(NOT_FETCHABLE)).toBe('media_url_not_fetchable: failed to download media at messages[0].content[1]: URL is not fetchable by this service');
    expect(refusalReason(JSON.stringify({ error: { message: 'reasoning_effort none is not supported' } }))).toBe('reasoning_effort none is not supported');
    expect(refusalReason('<html>bad gateway</html>')).toBe('');
    expect(refusalReason('null')).toBe('');
  });
  it('chat and SAM put it in the error, after the status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(NOT_FETCHABLE, { status: 400 })));
    const asked = chat(metaEndpoint('k'), [{ role: 'user', content: 'hi' }]);
    await expect(asked).rejects.toBeInstanceOf(MuseError);
    await expect(asked).rejects.toThrow('https://api.meta.ai/v1 answered 400 media_url_not_fetchable: failed to download media');
    const found = segment('k', 'https://scontent.xx.fbcdn.net/v/p.jpg', 'ring');
    await expect(found).rejects.toBeInstanceOf(SamError);
    await expect(found).rejects.toThrow('responses answered 400 media_url_not_fetchable');
  });
});
