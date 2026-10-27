/** The shop's catalogue and a small word-overlap search over it: what a photo's search words are matched against. */
export interface Item {
  id: string;
  name: string;
  category: string;
  price: number;
  currency: string;
  description: string;
  imageUrl: string;
  keywords: string[];
}

/** Lower-cased words of three letters or more, plurals folded, each once. */
export function tokens(text: string): string[] {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 3) continue;
    out.add(raw.length > 3 && raw.endsWith('s') ? raw.slice(0, -1) : raw);
  }
  return [...out];
}

/** Items that share words with the query, best first: the item's kind counts three, a word in its name two, any other one. */
export function searchCatalogue(items: Item[], query: string, limit = 3): Array<{ item: Item; score: number }> {
  const q = tokens(query);
  if (q.length === 0) return [];
  return items
    .map((item) => {
      const kind = new Set(tokens(item.category));
      const name = new Set(tokens(item.name));
      const rest = new Set(tokens([item.description, ...item.keywords].join(' ')));
      let score = 0;
      for (const w of q) { if (kind.has(w)) score += 3; else if (name.has(w)) score += 2; else if (rest.has(w)) score += 1; }
      return { item, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name))
    .slice(0, limit);
}

export function catalogueLines(items: Item[]): string {
  return items.map((i) => `- ${i.name} (${i.category}): ${i.price} ${i.currency}. ${i.description}`).join('\n');
}

/** The kinds of things the shop sells, as SAM phrases, then the wide ones. */
export function phrasesOf(items: Item[]): string[] {
  const out: string[] = [];
  for (const w of [...items.map((i) => i.category.trim().toLowerCase()), 'jewelry', 'product']) if (w && !out.includes(w)) out.push(w);
  return out;
}
