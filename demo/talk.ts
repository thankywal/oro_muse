// The same assistant at a terminal, without Messenger. Type a message; or `voice path/to/note.(wav|mp4|m4a)`;
// or `photo https://…` / `photo path/to/picture.jpg`. Test data only: the Meta key may run on free credits.
//   META_MODEL_API_KEY=… npx tsx demo/talk.ts
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { answer, Memory, museDeps, type Shop } from './src/assistant.js';
import type { Item } from './src/catalogue.js';

const key = process.env['META_MODEL_API_KEY']; if (!key) throw new Error('set META_MODEL_API_KEY');
const { shop, items } = JSON.parse(readFileSync(new URL('./shop.json', import.meta.url), 'utf8')) as { shop: Shop; items: Item[] };
const memory = new Memory();
const deps = museDeps(key);
const local = (p: string): Uint8Array => new Uint8Array(readFileSync(p));
deps.fetchBytes = async (url) => /^https?:/.test(url) ? new Uint8Array(await (await fetch(url)).arrayBuffer()) : local(url);
const asUrl = (p: string): string => /^https?:/.test(p) ? p : `data:image/${p.toLowerCase().endsWith('.png') ? 'png' : 'jpeg'};base64,${Buffer.from(local(p)).toString('base64')}`;

console.log(`${shop.name}: ${items.length} items. Type a message, "voice <file>", "photo <url|file>", or "quit".`);
async function say(s: string): Promise<void> {
  const turn = s.startsWith('voice ') ? { senderId: 'cli', audioUrl: s.slice(6).trim() }
    : s.startsWith('photo ') ? { senderId: 'cli', imageUrl: asUrl(s.slice(6).trim()) }
    : { senderId: 'cli', text: s };
  const t0 = Date.now();
  try {
    const r = await answer(turn, { shop, items, memory, deps });
    if (r.heard) console.log(`  heard: ${r.heard}`);
    if (r.shown) console.log(`  shown: ${r.shown}`);
    if (r.matches.length) console.log(`  matches: ${r.matches.map((i) => i.name).join('; ')}`);
    console.log(`shop> ${r.text}${r.imageUrl ? `\n  [sends picture: ${r.matches[0]?.name}]` : ''}   (${Date.now() - t0} ms)`);
  } catch (e) { console.error(`  failed: ${(e as Error).message}`); }
}

// Lines are answered one after another, in order, whether typed or piped in.
const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: 'you> ' });
let queue: Promise<void> = Promise.resolve();
rl.prompt();
rl.on('line', (line) => {
  const s = line.trim();
  if (!s) { rl.prompt(); return; }
  if (s === 'quit' || s === 'exit') { rl.close(); return; }
  queue = queue.then(() => say(s)).then(() => rl.prompt());
}).on('close', () => { void queue.then(() => process.exit(0)); });
