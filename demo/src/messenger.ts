/** Messenger's side: the webhook handshake, the events, the signature, and the Send API. */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Turn } from './assistant.js';

export function verifyChallenge(query: URLSearchParams, verifyToken: string): string | null {
  return query.get('hub.mode') === 'subscribe' && query.get('hub.verify_token') === verifyToken ? (query.get('hub.challenge') ?? '') : null;
}

/** True when the X-Hub-Signature-256 header is the HMAC of the raw body under the app secret. */
export function signed(rawBody: Uint8Array, header: string | undefined, appSecret: string): boolean {
  const given = (header ?? '').replace(/^sha256=/, '');
  const want = createHmac('sha256', appSecret).update(rawBody).digest('hex');
  return given.length === want.length && timingSafeEqual(Buffer.from(given, 'utf8'), Buffer.from(want, 'utf8'));
}

interface Event { sender?: { id?: string }; message?: { mid?: string; text?: string; is_echo?: boolean; attachments?: Array<{ type?: string; payload?: { url?: string } }> } }

/** One turn per customer message: text, the first audio attachment, the first image attachment. Echoes are skipped. */
export function turnsOf(body: unknown): Turn[] {
  const out: Turn[] = [];
  const b = body as { object?: string; entry?: Array<{ messaging?: Event[] }> } | null;
  if (b?.object !== 'page') return out;
  for (const entry of b.entry ?? []) {
    for (const ev of entry.messaging ?? []) {
      const msg = ev.message; const psid = ev.sender?.id;
      if (!msg || !psid || msg.is_echo) continue;
      const turn: Turn = { senderId: String(psid), text: msg.text ?? null, audioUrl: null, imageUrl: null };
      for (const a of msg.attachments ?? []) {
        const url = a.payload?.url; if (!url) continue;
        if (a.type === 'audio' && !turn.audioUrl) turn.audioUrl = url;
        if (a.type === 'image' && !turn.imageUrl) turn.imageUrl = url;
      }
      if (turn.text || turn.audioUrl || turn.imageUrl) out.push(turn);
    }
  }
  return out;
}

const GRAPH = 'https://graph.facebook.com/v21.0/me/messages';
async function send(pageToken: string, body: unknown): Promise<void> {
  const r = await fetch(`${GRAPH}?access_token=${encodeURIComponent(pageToken)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`Send API ${r.status}: ${(await r.text()).slice(0, 300)}`);
}
export const sendText = (pageToken: string, psid: string, text: string): Promise<void> =>
  send(pageToken, { recipient: { id: psid }, messaging_type: 'RESPONSE', message: { text: text.slice(0, 2000) } });
export const sendImage = (pageToken: string, psid: string, url: string): Promise<void> =>
  send(pageToken, { recipient: { id: psid }, messaging_type: 'RESPONSE', message: { attachment: { type: 'image', payload: { url, is_reusable: true } } } });
