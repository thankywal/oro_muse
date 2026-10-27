import { describe, expect, it } from 'vitest';
import { largestMatch, parseSamText, readSam, samBody } from '../src/sam.js';
import { readImages, sniffImage } from '../src/images.js';

// Shapes as the Meta Model API answered on 2026-10-27 (mask payloads shortened).
const RING = '<0f>0<|box;x1=124;y1=288;x2=1137;y2=1145;w=1280;h=1280;c=0.8552036285400391|><|mask;x=0;y=0;c=0.86;data=46,101,~abc,def;ghi|>';
const PEARLS = '<0f>0<|box;x1=426;y1=894;x2=511;y2=988;w=1280;h=1619;c=0.875|><|mask;x=0;y=0;data=8,8,~aa|>,1<|box;x1=587;y1=239;x2=633;y2=292;w=1280;h=1619;c=0.6049|><|mask;x=0;y=0;data=8,8,~bb|>,2<|box;x1=616;y1=151;x2=712;y2=243;w=1280;h=1619;c=0.8632|><|mask;x=0;y=0;data=8,8,~cc|>';

describe('SAM 3.1', () => {
  it('the request puts the phrase beside the image and asks for confidence', () => {
    expect(samBody('https://x/p.jpg', 'ring')).toEqual({ model: 'sam-3.1', metadata: { include_confidence: 'true' }, stream: false,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ring' }, { type: 'input_image', image_url: 'https://x/p.jpg' }] }] });
  });
  it('one match: id, box in source pixels, frame size, confidence, raw mask', () => {
    const [m] = parseSamText(RING);
    expect(m).toMatchObject({ id: 0, box: { x1: 124, y1: 288, x2: 1137, y2: 1145, frameWidth: 1280, frameHeight: 1280 }, mask: expect.stringContaining('data=46,101,~') });
    expect(m!.box.confidence).toBeCloseTo(0.855, 2);
  });
  it('three matches are parsed by key, with the commas inside the mask data left alone', () => {
    const ms = parseSamText(PEARLS);
    expect(ms.map((m) => m.id)).toEqual([0, 1, 2]);
    expect(ms[1]!.box).toMatchObject({ x1: 587, y2: 292 }); expect(ms[1]!.box.confidence).toBeCloseTo(0.6049, 3);
    expect(largestMatch(ms)!.id).toBe(2);
  });
  it('no match is an empty answer, not an error', () => {
    const r = readSam(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: '' }] }], usage: { images_processed: 1 } }));
    expect(r.matches).toEqual([]); expect(r.imagesProcessed).toBe(1); expect(largestMatch(r.matches)).toBeNull();
  });
});

describe('Muse Image', () => {
  it('the bytes decide the type: the endpoint returned WebP under b64_json', () => {
    const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38]);
    const [img] = readImages(JSON.stringify({ created: 1, data: [{ b64_json: Buffer.from(webp).toString('base64') }], output_format: 'webp' }));
    expect(img).toMatchObject({ mime: 'image/webp', format: 'webp' }); expect(img!.bytes.length).toBe(15);
    expect(sniffImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])).format).toBe('png');
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff])).format).toBe('jpeg');
  });
});
