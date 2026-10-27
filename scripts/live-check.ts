// Live check of @oro-muse/provider against the real endpoints, with TEST data only.
// Keys come from the environment (META_MODEL_API_KEY, BASETEN_API_KEY); nothing is printed but results.
//   META_MODEL_API_KEY=… BASETEN_API_KEY=… npx tsx scripts/live-check.ts [path/to/16k-mono.wav] [image-url]
import { readFileSync } from 'node:fs';
import { basetenEndpoint, chat, generateImage, largestMatch, metaEndpoint, photoFact, photoMatch, segment, transcribe } from '../packages/muse-provider/src/index.js';

const metaKey = process.env['META_MODEL_API_KEY'] ?? ''; const basetenKey = process.env['BASETEN_API_KEY'] ?? '';
if (!metaKey || !basetenKey) throw new Error('set META_MODEL_API_KEY and BASETEN_API_KEY');
const wavPath = process.argv[2]; const imageUrl = process.argv[3] ?? 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/ce/02024_Silver_finger-ring_discovered_in_the_town_of_Brzesko.jpg/1280px-02024_Silver_finger-ring_discovered_in_the_town_of_Brzesko.jpg';

const shop = [
  { role: 'system' as const, content: 'You are the Messenger assistant of Muse Demo Jewellery, a small shop. Catalogue: Ruby Hand Chain 18K gold, 4,500 THB, in stock; Pearl Drop Earrings, 2,200 THB, in stock. Answer in one or two short sentences in the customer\'s language.' },
  { role: 'user' as const, content: 'Do you still have the ruby hand chain? How much is it, and can you deliver to Sukhumvit tomorrow?' },
];
for (const [name, ep, opts] of [
  ['Meta muse-spark-1.3 (reasoning low)', metaEndpoint(metaKey), { reasoningEffort: 'low' as const }],
  ['Baseten muse-spark-open-1026 (thinking off)', basetenEndpoint(basetenKey), { thinking: false }],
] as const) {
  const r = await chat(ep, shop, opts);
  console.log(`\n== ${name}: ${r.latencyMs} ms, completion ${r.usage.completionTokens} (reasoning ${r.usage.reasoningTokens}), finish ${r.finishReason}`);
  console.log('   ', r.text.replace(/\n/g, ' ').slice(0, 300));
}

if (wavPath) {
  const t = await transcribe(metaKey, new Uint8Array(readFileSync(wavPath)), { mode: 'ENDPOINTING' });
  console.log(`\n== transcribe: ${t.latencyMs} ms, ${t.audioDurationMs} ms of audio, ${t.turns.length} turn(s)`);
  console.log('   ', t.transcript);
}

for (const phrase of ['ring', 'jewelry', 'bracelet']) {
  const s = await segment(metaKey, imageUrl, phrase);
  const best = largestMatch(s.matches);
  console.log(`\n== sam-3.1 "${phrase}": ${s.latencyMs} ms, ${s.matches.length} match(es)` + (best ? `, largest id ${best.id} box ${best.box.x1},${best.box.y1}-${best.box.x2},${best.box.y2} of ${best.box.frameWidth}x${best.box.frameHeight} c=${best.box.confidence?.toFixed(2)}` : ''));
}

{
  const m = await photoMatch(metaKey, metaEndpoint(metaKey), imageUrl, { phrases: ['ring', 'necklace', 'bracelet', 'jewelry'] });
  console.log(`\n== photo match: ${m.latencyMs} ms, SAM calls ${m.usage.samCalls}, phrase ${m.phrase}, box ${m.box ? `${m.box.x1},${m.box.y1}-${m.box.x2},${m.box.y2}` : 'none'}`);
  console.log('   ', photoFact(m));
}

if (process.argv.includes('--image')) {
  const t0 = Date.now();
  const [img] = await generateImage(metaKey, 'A clean product photo of a ruby hand chain bracelet on a white background, soft studio light, no text');
  console.log(`\n== muse-image-1.0: ${Date.now() - t0} ms, ${img?.format} ${img?.bytes.length} bytes`);
}
