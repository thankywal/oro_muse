/**
 * Chat with Muse Spark: Meta Model API (`muse-spark-1.3`) or a hosted Muse Spark Open
 * (`meta-models/muse-spark-open-1026` on Baseten). Both speak the OpenAI chat-completions
 * wire. Two things a caller must know, measured on 2026-10-27:
 *
 *   - Both models ALWAYS reason before they answer. The reasoning is billed as completion
 *     tokens. With max_tokens=200 every token went to reasoning and `content` came back
 *     null. Give an answer room (we default to 1,500) and set `reasoning_effort`.
 *   - Meta hides the reasoning and accepts reasoning_effort minimal|low|medium|high|xhigh|max.
 *     Baseten returns it as `message.reasoning_content` and also accepts
 *     `chat_template_kwargs: { enable_thinking: false }`, which brought a one-line
 *     shop answer from 909 reasoning tokens (3.7 s) to 35 (0.7 s).
 *
 * No dependencies: `fetch` from Node 20+.
 */

export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface MuseEndpoint {
  /** Where the OpenAI-compatible API lives, without the trailing `/chat/completions`. */
  baseUrl: string;
  apiKey: string;
  /** How the key travels. Meta: `Bearer`. Baseten: `Api-Key`. */
  authScheme?: 'Bearer' | 'Api-Key';
  /** Default model id for this endpoint. */
  model: string;
  /** The endpoint's own way to keep reasoning short (Baseten/vLLM). */
  thinkingToggle?: boolean;
  /** The tool_choice values the endpoint accepts. Meta Model API, measured 2026-10-27: `auto` only
   *  ("`none`, `required`, and named function choices are not currently supported", HTTP 400). */
  toolChoices?: ReadonlyArray<'auto' | 'none' | 'required'>;
}

/** Meta Model API: `MODEL_API_KEY` from dev.meta.ai. */
export function metaEndpoint(apiKey: string, model = 'muse-spark-1.3'): MuseEndpoint {
  return { baseUrl: 'https://api.meta.ai/v1', apiKey, authScheme: 'Bearer', model, toolChoices: ['auto'] };
}

/** Baseten's hosted Muse Spark Open. The hackathon credits cover `-1026` only. */
export function basetenEndpoint(apiKey: string, model = 'meta-models/muse-spark-open-1026'): MuseEndpoint {
  return { baseUrl: 'https://inference.baseten.co/v1', apiKey, authScheme: 'Api-Key', model, thinkingToggle: true };
}

export type ChatPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
export interface ChatMessage { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | ChatPart[]; name?: string; tool_call_id?: string }

export interface ChatTool { type: 'function'; function: { name: string; description?: string; parameters?: Record<string, unknown> } }

export interface ChatOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  reasoningEffort?: ReasoningEffort;
  /** Baseten only: turn the long think off for short answers. Ignored on Meta. */
  thinking?: boolean;
  tools?: ChatTool[];
  toolChoice?: 'auto' | 'none' | 'required';
  /** Ask for JSON (`{ type: 'json_object' }`) or a schema. Passed through as `response_format`. */
  responseFormat?: Record<string, unknown>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ChatUsage { promptTokens: number; completionTokens: number; reasoningTokens: number; cachedTokens: number }

export interface ChatResult {
  /** The answer. Empty when the model spent its whole budget reasoning. */
  text: string;
  /** Baseten returns the reasoning; Meta does not. */
  reasoning: string | null;
  toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  finishReason: string | null;
  usage: ChatUsage;
  model: string;
  latencyMs: number;
}

export class MuseError extends Error {
  constructor(message: string, readonly status: number, readonly body: string) { super(message); this.name = 'MuseError'; }
}

/** The request body, exported so a test or a record can read it without a network. */
export function chatBody(endpoint: MuseEndpoint, messages: readonly ChatMessage[], opts: ChatOptions = {}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: opts.model ?? endpoint.model,
    messages,
    max_tokens: opts.maxTokens ?? 1500,
  };
  if (opts.temperature !== undefined) body['temperature'] = opts.temperature;
  if (opts.reasoningEffort) body['reasoning_effort'] = opts.reasoningEffort;
  if (opts.thinking === false && endpoint.thinkingToggle) body['chat_template_kwargs'] = { enable_thinking: false };
  if (opts.tools?.length) {
    // A choice the endpoint cannot take is given in the nearest way it can: `none` is the same as sending no
    // tools; `required` becomes `auto`, and the caller reads the answer as it always does (a tool call or words).
    const choice = opts.toolChoice;
    const accepted = !choice || !endpoint.toolChoices || endpoint.toolChoices.includes(choice);
    if (choice === 'none' && !accepted) { /* no tools at all */ }
    else {
      body['tools'] = opts.tools;
      if (choice) body['tool_choice'] = accepted ? choice : 'auto';
    }
  }
  if (opts.responseFormat) body['response_format'] = opts.responseFormat;
  return body;
}

function authHeader(endpoint: MuseEndpoint): string {
  return `${endpoint.authScheme ?? 'Bearer'} ${endpoint.apiKey}`;
}

/** One chat completion. Throws `MuseError` on a non-2xx answer. */
export async function chat(endpoint: MuseEndpoint, messages: readonly ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
  const t0 = Date.now();
  const res = await fetch(`${endpoint.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: authHeader(endpoint) },
    body: JSON.stringify(chatBody(endpoint, messages, opts)),
    signal: opts.signal ?? AbortSignal.timeout(opts.timeoutMs ?? 60_000),
  });
  const raw = await res.text();
  if (!res.ok) throw new MuseError(`${endpoint.baseUrl} answered ${res.status}`, res.status, raw.slice(0, 2000));
  return readChat(raw, Date.now() - t0);
}

/** Reads a chat-completions answer. Exported for tests and replay. */
export function readChat(raw: string, latencyMs = 0): ChatResult {
  const d = JSON.parse(raw) as {
    model?: string;
    choices?: Array<{ finish_reason?: string | null; message?: { content?: string | null; reasoning_content?: string | null;
      tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number }; prompt_tokens_details?: { cached_tokens?: number } };
  };
  const choice = d.choices?.[0];
  const message = choice?.message ?? {};
  const toolCalls = (message.tool_calls ?? []).flatMap((c) => {
    const name = c.function?.name;
    if (!name) return [];
    let args: Record<string, unknown> = {};
    try { args = JSON.parse(c.function?.arguments || '{}'); } catch { /* the model wrote something that is not JSON: hand it over as text */ args = { _raw: c.function?.arguments }; }
    return [{ id: c.id ?? '', name, arguments: args }];
  });
  return {
    text: (message.content ?? '').trim(),
    reasoning: message.reasoning_content ?? null,
    toolCalls,
    finishReason: choice?.finish_reason ?? null,
    usage: {
      promptTokens: d.usage?.prompt_tokens ?? 0,
      completionTokens: d.usage?.completion_tokens ?? 0,
      reasoningTokens: d.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
      cachedTokens: d.usage?.prompt_tokens_details?.cached_tokens ?? 0,
    },
    model: d.model ?? '',
    latencyMs,
  };
}
