import { afterEach, describe, expect, it, vi } from 'vitest';
import { basetenEndpoint, chat, chatBody, metaEndpoint, MuseError, readChat } from '../src/chat.js';

const meta = metaEndpoint('test-key');
const baseten = basetenEndpoint('test-key');
const ask = [{ role: 'user' as const, content: 'Do you have a ruby hand chain?' }];

describe('the request body', () => {
  it('gives the answer room by default and names the endpoint model', () => {
    expect(chatBody(meta, ask)).toEqual({ model: 'muse-spark-1.3', messages: ask, max_tokens: 1500 });
  });
  it('passes reasoning_effort through, and the thinking toggle only where the endpoint has one', () => {
    expect(chatBody(meta, ask, { reasoningEffort: 'low', thinking: false })).toMatchObject({ reasoning_effort: 'low' });
    expect(chatBody(meta, ask, { thinking: false })).not.toHaveProperty('chat_template_kwargs');
    expect(chatBody(baseten, ask, { thinking: false })).toMatchObject({ chat_template_kwargs: { enable_thinking: false } });
  });
  it('a tool choice the endpoint cannot take is given in the nearest way it can', () => {
    const tools = [{ type: 'function' as const, function: { name: 'find_item', parameters: { type: 'object' } } }];
    // Meta takes `auto` only (HTTP 400 on `required` and `none`, measured 2026-10-27).
    expect(chatBody(meta, ask, { tools, toolChoice: 'required' })).toMatchObject({ tools, tool_choice: 'auto' });
    expect(chatBody(meta, ask, { tools, toolChoice: 'none' })).not.toHaveProperty('tools');
    expect(chatBody(meta, ask, { tools, toolChoice: 'auto' })).toMatchObject({ tool_choice: 'auto' });
    // Baseten states no restriction, so the choice goes through as asked.
    expect(chatBody(baseten, ask, { tools, toolChoice: 'required' })).toMatchObject({ tool_choice: 'required' });
  });
  it('carries tools and a response format', () => {
    const tools = [{ type: 'function' as const, function: { name: 'find_item', parameters: { type: 'object' } } }];
    expect(chatBody(meta, ask, { tools, toolChoice: 'auto', responseFormat: { type: 'json_object' } }))
      .toMatchObject({ tools, tool_choice: 'auto', response_format: { type: 'json_object' } });
  });
});

describe('reading an answer', () => {
  it('Meta: the text, no reasoning, usage with reasoning tokens', () => {
    const r = readChat(JSON.stringify({ model: 'muse-spark-1.3', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Yes, $180.' } }],
      usage: { prompt_tokens: 42, completion_tokens: 587, completion_tokens_details: { reasoning_tokens: 566 }, prompt_tokens_details: { cached_tokens: 0 } } }), 4600);
    expect(r.text).toBe('Yes, $180.'); expect(r.reasoning).toBeNull(); expect(r.usage.reasoningTokens).toBe(566); expect(r.latencyMs).toBe(4600);
  });
  it('Baseten: the reasoning rides beside the text', () => {
    const r = readChat(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Yes, $199.', reasoning_content: 'The user wants the price.' } }], usage: {} }));
    expect(r.text).toBe('Yes, $199.'); expect(r.reasoning).toBe('The user wants the price.');
  });
  it('a budget spent entirely on reasoning is an empty answer, not a crash', () => {
    const r = readChat(JSON.stringify({ choices: [{ finish_reason: 'length', message: { role: 'assistant', content: null } }], usage: { completion_tokens: 200, completion_tokens_details: { reasoning_tokens: 198 } } }));
    expect(r.text).toBe(''); expect(r.finishReason).toBe('length');
  });
  it('tool calls are parsed, and unparseable arguments are kept raw', () => {
    const r = readChat(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [
      { id: 'c1', function: { name: 'find_item', arguments: '{"query":"ruby"}' } },
      { id: 'c2', function: { name: 'find_item', arguments: 'not json' } } ] } }] }));
    expect(r.toolCalls).toEqual([{ id: 'c1', name: 'find_item', arguments: { query: 'ruby' } }, { id: 'c2', name: 'find_item', arguments: { _raw: 'not json' } }]);
  });
});

describe('the call', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('sends the key with the endpoint\'s scheme and throws a MuseError on a refusal', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
      seen.push({ url, headers: init.headers });
      return new Response(JSON.stringify({ error: { message: 'reasoning_effort none is not supported' } }), { status: 400 });
    }));
    await expect(chat(baseten, ask)).rejects.toBeInstanceOf(MuseError);
    expect(seen[0]!.url).toBe('https://inference.baseten.co/v1/chat/completions');
    expect(seen[0]!.headers['authorization']).toBe('Api-Key test-key');
  });
});
