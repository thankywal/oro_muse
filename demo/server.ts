// The Messenger webhook. Run it, put it behind a public URL (ngrok, cloudflared), and point the Page's
// webhook at https://<host>/webhook with your VERIFY_TOKEN; subscribe to `messages`.
//   PAGE_ACCESS_TOKEN=… VERIFY_TOKEN=… META_MODEL_API_KEY=… APP_SECRET=… [PORT=3000] npx tsx demo/server.ts
// APP_SECRET is the Meta app's secret: every POST must carry Meta's signature, or anyone who finds the URL could
// make the demo answer forged events.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { answer, Memory, museDeps, type Shop, type Turn } from './src/assistant.js';
import type { Item } from './src/catalogue.js';
import { sendImage, sendText, signed, turnsOf, verifyChallenge } from './src/messenger.js';

const need = (k: string): string => { const v = process.env[k]; if (!v) throw new Error(`set ${k}`); return v; };
const PAGE_TOKEN = need('PAGE_ACCESS_TOKEN'); const VERIFY = need('VERIFY_TOKEN'); const META = need('META_MODEL_API_KEY');
const APP_SECRET = need('APP_SECRET'); const PORT = Number(process.env['PORT'] ?? 3000);
const { shop, items } = JSON.parse(readFileSync(new URL('./shop.json', import.meta.url), 'utf8')) as { shop: Shop; items: Item[] };
const memory = new Memory(); const deps = museDeps(META);

async function handle(turn: Turn): Promise<void> {
  const t0 = Date.now();
  const r = await answer(turn, { shop, items, memory, deps });
  await sendText(PAGE_TOKEN, turn.senderId, r.text);
  if (r.imageUrl) await sendImage(PAGE_TOKEN, turn.senderId, r.imageUrl);
  console.log(JSON.stringify({ sender: `…${turn.senderId.slice(-4)}`, heard: r.heard, shown: r.shown, matches: r.matches.map((i) => i.name), ms: Date.now() - t0 }));
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/health') { res.end('ok'); return; }
  if (req.method === 'GET' && url.pathname === '/webhook') {
    const c = verifyChallenge(url.searchParams, VERIFY);
    res.statusCode = c === null ? 403 : 200; res.end(c ?? 'forbidden'); return;
  }
  if (req.method === 'POST' && url.pathname === '/webhook') {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks);
    if (!signed(raw, req.headers['x-hub-signature-256'] as string | undefined, APP_SECRET)) { res.statusCode = 401; res.end(); return; }
    let body: unknown; try { body = JSON.parse(raw.toString('utf8')); } catch { res.statusCode = 400; res.end(); return; }
    res.statusCode = 200; res.end('EVENT_RECEIVED'); // Messenger wants its 200 at once; the answers follow
    for (const turn of turnsOf(body)) handle(turn).catch((e: Error) => console.error('turn failed:', e.message));
    return;
  }
  res.statusCode = 404; res.end();
}).listen(PORT, () => console.log(`Oro on Muse demo on :${PORT}  (GET /webhook verifies, POST /webhook answers, GET /health)`));
