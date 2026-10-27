/**
 * Promo images with `muse-image-1.0` (`POST /v1/images/generations`).
 *
 * Measured 2026-10-27: `{ model, prompt, n }` came back in 18 s as
 * `{ created, data: [{ b64_json }], output_format, background, usage }`, and the bytes
 * were a WebP (RIFF….WEBP), not a PNG. $0.01 per image; failed or filtered images are
 * not billed.
 */

export interface ImageOptions { model?: string; n?: number; timeoutMs?: number }

export interface GeneratedImage { bytes: Uint8Array; mime: string; format: string }

export class ImageError extends Error {
  constructor(message: string, readonly status: number, readonly body: string) { super(message); this.name = 'ImageError'; }
}

const META_IMAGES = 'https://api.meta.ai/v1/images/generations';

/** What the bytes say they are: the response's `output_format` is a word, the bytes are the truth. */
export function sniffImage(bytes: Uint8Array): { mime: string; format: string } {
  const text = (o: number, n: number) => String.fromCharCode(...bytes.subarray(o, o + n));
  if (bytes.length >= 12 && text(0, 4) === 'RIFF' && text(8, 4) === 'WEBP') return { mime: 'image/webp', format: 'webp' };
  if (bytes.length >= 8 && bytes[0] === 0x89 && text(1, 3) === 'PNG') return { mime: 'image/png', format: 'png' };
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return { mime: 'image/jpeg', format: 'jpeg' };
  return { mime: 'application/octet-stream', format: 'unknown' };
}

/** Reads the endpoint's answer: every image decoded, typed by its bytes. */
export function readImages(raw: string): GeneratedImage[] {
  const d = JSON.parse(raw) as { data?: Array<{ b64_json?: string; url?: string }> };
  return (d.data ?? []).flatMap((x) => {
    if (!x.b64_json) return [];
    const bytes = new Uint8Array(Buffer.from(x.b64_json, 'base64'));
    return [{ bytes, ...sniffImage(bytes) }];
  });
}

export async function generateImage(apiKey: string, prompt: string, opts: ImageOptions = {}): Promise<GeneratedImage[]> {
  const res = await fetch(META_IMAGES, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: opts.model ?? 'muse-image-1.0', prompt, n: opts.n ?? 1 }), signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000) });
  const raw = await res.text();
  if (!res.ok) throw new ImageError(`images answered ${res.status}`, res.status, raw.slice(0, 2000));
  return readImages(raw);
}
