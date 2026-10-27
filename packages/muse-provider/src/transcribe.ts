/**
 * Voice notes to text with `muse-voice-transcribe-1.0` (`POST /v1/asr/transcribe`).
 *
 * Measured 2026-10-27: the endpoint takes multipart form data with a JSON `request`
 * part and an `audio` part, and it is strict about the audio: mono, 16-bit PCM WAV at
 * 16,000 or 24,000 Hz. A 22,050 Hz file is refused with HTTP 400
 * ("expected mono s16le at 16000 or 24000 Hz"). A 5-second note came back in 1.4 s as
 * `{ sessionId, transcript, audioDurationMs, turns: [{ turnId, startMs, endMs, transcript }] }`.
 * Limits from the docs: 10 minutes, 32 MB. Price: $0.18 per hour of audio.
 *
 * Messenger voice notes arrive as MP4/AAC, so `toPcmWav` runs ffmpeg when it is on the
 * machine. Nothing here depends on anything but Node.
 */
import { spawn } from 'node:child_process';

export type TranscribeMode = 'PUSH_TO_TALK' | 'ENDPOINTING' | 'DIARIZATION';

export interface TranscribeOptions {
  model?: string;
  /** PUSH_TO_TALK gives one transcript; ENDPOINTING adds turns with timestamps. */
  mode?: TranscribeMode;
  sessionId?: string;
  timeoutMs?: number;
}

export interface TranscribeTurn { turnId: number; startMs: number; endMs: number; transcript: string; speaker?: string }

export interface TranscribeResult {
  transcript: string;
  audioDurationMs: number;
  turns: TranscribeTurn[];
  sessionId: string;
  latencyMs: number;
}

export class TranscribeError extends Error {
  constructor(message: string, readonly status: number, readonly body: string) { super(message); this.name = 'TranscribeError'; }
}

const META_ASR = 'https://api.meta.ai/v1/asr/transcribe';

/** Reads a 44-byte RIFF header: is this WAV what the endpoint accepts? */
export function wavFormat(bytes: Uint8Array): { ok: boolean; channels: number; sampleRate: number; bitsPerSample: number; reason?: string } {
  const text = (o: number, n: number) => String.fromCharCode(...bytes.subarray(o, o + n));
  if (bytes.length < 44 || text(0, 4) !== 'RIFF' || text(8, 4) !== 'WAVE') return { ok: false, channels: 0, sampleRate: 0, bitsPerSample: 0, reason: 'not a RIFF/WAVE file' };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Walk the chunks to the `fmt ` chunk: a WAV written by another tool may put a LIST chunk first.
  let at = 12;
  while (at + 8 <= bytes.length) {
    const id = text(at, 4); const size = view.getUint32(at + 4, true);
    if (id === 'fmt ') {
      const channels = view.getUint16(at + 10, true); const sampleRate = view.getUint32(at + 12, true); const bitsPerSample = view.getUint16(at + 22, true);
      const ok = channels === 1 && bitsPerSample === 16 && (sampleRate === 16000 || sampleRate === 24000);
      return { ok, channels, sampleRate, bitsPerSample, ...(ok ? {} : { reason: `expected mono s16le at 16000 or 24000 Hz, got channels=${channels} rate=${sampleRate} bits=${bitsPerSample}` }) };
    }
    at += 8 + size + (size % 2);
  }
  return { ok: false, channels: 0, sampleRate: 0, bitsPerSample: 0, reason: 'no fmt chunk' };
}

/** Any audio ffmpeg can read (Messenger's MP4/AAC, OGG, M4A, a 22 kHz WAV) → mono 16 kHz s16le WAV bytes. */
export function toPcmWav(input: Uint8Array, opts: { ffmpeg?: string; sampleRate?: 16000 | 24000 } = {}): Promise<Uint8Array> {
  const rate = opts.sampleRate ?? 16000;
  return new Promise((resolve, reject) => {
    const p = spawn(opts.ffmpeg ?? 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-ac', '1', '-ar', String(rate), '-acodec', 'pcm_s16le', '-f', 'wav', 'pipe:1']);
    const out: Buffer[] = []; const err: Buffer[] = [];
    p.stdout.on('data', (b: Buffer) => out.push(b)); p.stderr.on('data', (b: Buffer) => err.push(b));
    p.on('error', (e) => reject(new Error(`ffmpeg could not start: ${e.message}`)));
    p.on('close', (code) => code === 0 ? resolve(new Uint8Array(Buffer.concat(out))) : reject(new Error(`ffmpeg exited ${code}: ${Buffer.concat(err).toString().slice(0, 300)}`)));
    p.stdin.end(Buffer.from(input));
  });
}

/** The multipart body, exported so a test can read it without a network. */
export function transcribeForm(wav: Uint8Array, opts: TranscribeOptions = {}): FormData {
  const form = new FormData();
  form.append('request', new Blob([JSON.stringify({ model: opts.model ?? 'muse-voice-transcribe-1.0', audioEncoding: 'WAV', mode: opts.mode ?? 'PUSH_TO_TALK' })], { type: 'application/json' }));
  form.append('audio', new Blob([Buffer.from(wav)], { type: 'audio/wav' }), 'note.wav');
  return form;
}

/** Reads the endpoint's answer. Exported for tests and replay. */
export function readTranscribe(raw: string, latencyMs = 0): TranscribeResult {
  const d = JSON.parse(raw) as { sessionId?: string; transcript?: string; audioDurationMs?: number; turns?: TranscribeTurn[] };
  return { transcript: (d.transcript ?? '').trim(), audioDurationMs: d.audioDurationMs ?? 0, turns: d.turns ?? [], sessionId: d.sessionId ?? '', latencyMs };
}

/** Transcribe a mono 16/24 kHz s16le WAV. Convert first with `toPcmWav` when the note is anything else. */
export async function transcribe(apiKey: string, wav: Uint8Array, opts: TranscribeOptions = {}): Promise<TranscribeResult> {
  const fmt = wavFormat(wav);
  if (!fmt.ok) throw new TranscribeError(`unsupported WAV: ${fmt.reason}`, 0, '');
  const t0 = Date.now();
  const url = opts.sessionId ? `${META_ASR}?sessionId=${encodeURIComponent(opts.sessionId)}` : META_ASR;
  const res = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
    body: transcribeForm(wav, opts), signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000) });
  const raw = await res.text();
  if (!res.ok) throw new TranscribeError(`transcribe answered ${res.status}`, res.status, raw.slice(0, 2000));
  return readTranscribe(raw, Date.now() - t0);
}
