import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTranscribe, toPcmWav, transcribe, transcribeForm, wavFormat } from '../src/transcribe.js';

function wav(channels: number, rate: number, bits: number, frames = 16): Uint8Array {
  const dataBytes = frames * channels * (bits / 8);
  const b = new Uint8Array(44 + dataBytes); const v = new DataView(b.buffer);
  const put = (o: number, s: string) => { for (let i = 0; i < s.length; i++) b[o + i] = s.charCodeAt(i); };
  put(0, 'RIFF'); v.setUint32(4, 36 + dataBytes, true); put(8, 'WAVE'); put(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, channels, true); v.setUint32(24, rate, true); v.setUint32(28, rate * channels * bits / 8, true); v.setUint16(32, channels * bits / 8, true); v.setUint16(34, bits, true);
  put(36, 'data'); v.setUint32(40, dataBytes, true);
  return b;
}

describe('the WAV the endpoint accepts', () => {
  it('mono 16-bit at 16 or 24 kHz passes; a 22,050 Hz piper file and stereo do not', () => {
    expect(wavFormat(wav(1, 16000, 16)).ok).toBe(true);
    expect(wavFormat(wav(1, 24000, 16)).ok).toBe(true);
    expect(wavFormat(wav(1, 22050, 16))).toMatchObject({ ok: false, sampleRate: 22050 });
    expect(wavFormat(wav(2, 16000, 16)).ok).toBe(false);
    expect(wavFormat(new Uint8Array(10)).reason).toBe('not a RIFF/WAVE file');
  });
  it('a bad file is refused before any network call', async () => {
    await expect(transcribe('k', wav(1, 22050, 16))).rejects.toThrow(/22050/);
  });
});

describe('the form and the answer', () => {
  it('carries the JSON request part and the audio part', async () => {
    const form = transcribeForm(wav(1, 16000, 16), { mode: 'ENDPOINTING' });
    const req = form.get('request') as Blob; const audio = form.get('audio') as File;
    expect(JSON.parse(await req.text())).toEqual({ model: 'muse-voice-transcribe-1.0', audioEncoding: 'WAV', mode: 'ENDPOINTING' });
    expect(audio.type).toBe('audio/wav'); expect(audio.size).toBe(44 + 32);
  });
  it('reads the transcript, duration and turns as the endpoint returned them on 2026-10-27', () => {
    const r = readTranscribe(JSON.stringify({ sessionId: 'voyager/transcribe/2D58', transcript: 'Hi, do you still have the ruby hand chain? How much is it and can you deliver to Sukhumvit tomorrow', audioDurationMs: 5040,
      turns: [{ turnId: 0, startMs: 0, endMs: 4540, transcript: 'Hi, do you still have the ruby hand chain? How much is it and can you deliver to Sukhumvit tomorrow' }] }), 1345);
    expect(r.transcript).toMatch(/^Hi, do you still have the ruby hand chain/); expect(r.audioDurationMs).toBe(5040); expect(r.turns).toHaveLength(1); expect(r.latencyMs).toBe(1345);
  });
});

describe('converting a note: files, never pipes', () => {
  // A stand-in ffmpeg: it records what it was asked and writes a WAV to the last argument.
  function fakeFfmpeg(body: string): { bin: string; seen: string; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), 'fake-ffmpeg-'));
    const bin = join(dir, 'ffmpeg'); const seen = join(dir, 'seen.json');
    writeFileSync(bin, `#!/usr/bin/env node\nconst fs = require('node:fs'); const a = process.argv.slice(2);\nconst src = a[a.indexOf('-i') + 1]; const dst = a[a.length - 1];\nfs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ args: a, src, input: fs.readFileSync(src).toString('hex') }));\n${body}\n`, { mode: 0o755 });
    return { bin, seen, dir };
  }

  it('the note is read from a file and the WAV written to a file, bit-exact, then both are gone', async () => {
    const out = wav(1, 16000, 16);
    const f = fakeFfmpeg(`fs.writeFileSync(dst, Buffer.from('${Buffer.from(out).toString('hex')}', 'hex'));`);
    const got = await toPcmWav(new Uint8Array([1, 2, 3]), { ffmpeg: f.bin });
    expect(Buffer.from(got).equals(Buffer.from(out))).toBe(true);
    const seen = JSON.parse(readFileSync(f.seen, 'utf8')) as { args: string[]; src: string; input: string };
    expect(seen.input).toBe('010203');
    expect(seen.args).not.toContain('pipe:0'); expect(seen.args).not.toContain('pipe:1');
    expect(seen.args.slice(-1)[0]).toMatch(/out\.wav$/);
    expect(seen.args.join(' ')).toContain('-map_metadata -1 -fflags +bitexact -flags:a +bitexact -vn -ac 1 -ar 16000 -acodec pcm_s16le -f wav');
    expect(existsSync(seen.src)).toBe(false);
    rmSync(f.dir, { recursive: true, force: true });
  });

  it('a failed conversion says ffmpeg\'s own words and still leaves nothing behind; a missing ffmpeg says so', async () => {
    const f = fakeFfmpeg(`process.stderr.write('Invalid data found when processing input'); process.exit(1);`);
    await expect(toPcmWav(new Uint8Array([9]), { ffmpeg: f.bin })).rejects.toThrow('ffmpeg exited 1: Invalid data found when processing input');
    const seen = JSON.parse(readFileSync(f.seen, 'utf8')) as { src: string };
    expect(existsSync(seen.src)).toBe(false);
    rmSync(f.dir, { recursive: true, force: true });
    await expect(toPcmWav(new Uint8Array([9]), { ffmpeg: '/nonexistent/ffmpeg' })).rejects.toThrow('ffmpeg could not start');
  });
});
