/**
 * 模型接口层：DeepSeek（内置，无需填写 baseUrl）与任意 OpenAI 兼容接口
 *
 * 提供：连接检测、模型列表获取、模型能力推断（上下文 / 输出 / 识图）、流式对话（含工具调用）。
 */
import type { ModelInfo, ModelOverride, ProviderConfig, Settings, ThinkingLevel, ToolCall, Usage } from './types';
import { httpRequest, isAbort, readSSE } from '../lib/http';
import { errorMessage, safeJsonParse, truncate } from '../lib/util';

export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

/**
 * DeepSeek 当前在售模型（官方文档 2026-10）：
 * deepseek-flash（V4.1-Flash，支持识图）与 deepseek-v4-pro，均为 1M 上下文、最大输出 384K、默认开启思考。
 */
export const DEEPSEEK_MODELS: ModelInfo[] = [
	{ id: 'deepseek-flash', contextWindow: 1_000_000, maxOutput: 32_768, outputLimit: 384_000, vision: true, reasoning: true },
	{ id: 'deepseek-v4-pro', contextWindow: 1_000_000, maxOutput: 32_768, outputLimit: 384_000, vision: false, reasoning: true },
];

/** 已下线的旧模型名 */
export const DEEPSEEK_LEGACY = new Set(['deepseek-chat', 'deepseek-reasoner', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']);

export function defaultProviders(): ProviderConfig[] {
	return [
		{
			id: 'deepseek',
			kind: 'deepseek',
			name: 'DeepSeek',
			baseUrl: DEEPSEEK_BASE_URL,
			apiKey: '',
			builtin: true,
			models: DEEPSEEK_MODELS.map(m => ({ ...m })),
		},
	];
}

export const THINKING_LABEL: Record<ThinkingLevel, string> = {
	default: '默认',
	off: '关闭',
	low: '低',
	medium: '中',
	high: '高',
	max: '最大',
};

/** 各接口可选的思考强度 */
export function thinkingLevels(kind: ProviderConfig['kind']): ThinkingLevel[] {
	return kind === 'deepseek' ? ['off', 'low', 'high', 'max'] : ['default', 'off', 'low', 'medium', 'high'];
}

export function defaultThinking(kind: ProviderConfig['kind']): ThinkingLevel {
	return kind === 'deepseek' ? 'high' : 'default';
}

export function providerBaseUrl(p: ProviderConfig): string {
	const raw = p.kind === 'deepseek' ? DEEPSEEK_BASE_URL : (p.baseUrl || '').trim();
	return raw.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
}

function headers(p: ProviderConfig): Record<string, string> {
	const h: Record<string, string> = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' };
	if (p.apiKey.trim())
		h.Authorization = `Bearer ${p.apiKey.trim()}`;
	for (const [k, v] of Object.entries(p.extraHeaders ?? {})) {
		if (k.trim())
			h[k.trim()] = v;
	}
	return h;
}

/** 根据模型名推断能力（上下文窗口 / 最大输出 / 识图 / 推理） */
export function inferCapabilities(id: string): Omit<ModelInfo, 'id'> {
	const s = id.toLowerCase();
	const r: Omit<ModelInfo, 'id'> = { contextWindow: 128_000, maxOutput: 8192, vision: false, reasoning: false };
	const vision = /(vision|-vl\b|-vl-|vl-|4o|gpt-4\.1|gpt-4-turbo|gpt-5|o3|o4|claude-3|claude-(sonnet|opus|haiku)|gemini|pixtral|llava|qvq|glm-4v|glm-4\.5v|glm-4\.6v|internvl|minicpm-v|step-1v|doubao.*vision|kimi.*(vl|vision)|moonshot.*vision|qwen.*(vl|omni)|grok-(2-vision|4)|llama-4|mistral-(medium|small)-3)/;
	r.vision = vision.test(s);
	if (/deepseek/.test(s)) {
		const known = DEEPSEEK_MODELS.find(m => m.id === s);
		if (known)
			return { ...known, id: undefined } as Omit<ModelInfo, 'id'>;
		if (/flash|v4|v5/.test(s)) {
			return { contextWindow: 1_000_000, maxOutput: 32_768, outputLimit: 384_000, vision: /flash/.test(s), reasoning: true };
		}
		r.contextWindow = 128_000;
		r.maxOutput = /reasoner|r1/.test(s) ? 32_768 : 8192;
		r.reasoning = /reasoner|r1|think/.test(s);
		r.vision = /vl|ocr|janus/.test(s);
		return r;
	}
	if (/gpt-4\.1/.test(s)) {
		r.contextWindow = 1_000_000;
		r.maxOutput = 32_768;
	}
	else if (/gpt-5/.test(s)) {
		r.contextWindow = 400_000;
		r.maxOutput = 128_000;
		r.reasoning = true;
	}
	else if (/gpt-4o/.test(s)) {
		r.contextWindow = 128_000;
		r.maxOutput = 16_384;
	}
	else if (/^o\d|\/o\d/.test(s)) {
		r.contextWindow = 200_000;
		r.maxOutput = 100_000;
		r.reasoning = true;
	}
	else if (/claude/.test(s)) {
		r.contextWindow = 200_000;
		r.maxOutput = /opus/.test(s) ? 32_000 : 64_000;
	}
	else if (/gemini/.test(s)) {
		r.contextWindow = 1_000_000;
		r.maxOutput = 65_536;
	}
	else if (/qwen/.test(s)) {
		r.contextWindow = /long|turbo|plus|max|qwen3/.test(s) ? 131_072 : 32_768;
		r.maxOutput = 8192;
		r.reasoning = /qwq|think/.test(s);
	}
	else if (/kimi|moonshot/.test(s)) {
		r.contextWindow = /128k|k2|kimi/.test(s) ? 131_072 : /32k/.test(s) ? 32_768 : 8192;
		r.maxOutput = 8192;
	}
	else if (/glm/.test(s)) {
		r.contextWindow = 128_000;
		r.maxOutput = 16_384;
	}
	else if (/doubao/.test(s)) {
		r.contextWindow = 128_000;
		r.maxOutput = 16_384;
	}
	const m = s.match(/(\d+)k\b/);
	if (m && Number(m[1]) >= 4)
		r.contextWindow = Number(m[1]) * 1024;
	return r;
}

export function findProvider(settings: Settings, id = settings.activeProviderId): ProviderConfig | undefined {
	return settings.providers.find(p => p.id === id) ?? settings.providers[0];
}

export interface ResolvedModel {
	provider: ProviderConfig;
	model: string;
	contextWindow: number;
	maxOutput: number;
	vision: boolean;
	reasoning: boolean;
	temperature?: number;
	topP?: number;
	/** 生效的思考强度 */
	thinking: ThinkingLevel;
}

export function overrideKey(providerId: string, model: string): string {
	return `${providerId}::${model}`;
}

export function resolveModel(settings: Settings): ResolvedModel | undefined {
	const provider = findProvider(settings);
	if (!provider)
		return undefined;
	const model = settings.activeModel || provider.models[0]?.id || '';
	if (!model)
		return undefined;
	const info = provider.models.find(m => m.id === model);
	const inferred = inferCapabilities(model);
	const ov: ModelOverride = settings.overrides[overrideKey(provider.id, model)] ?? {};
	const vision = ov.vision === 'on' ? true : ov.vision === 'off' ? false : (info?.vision ?? inferred.vision ?? false);
	const levels = thinkingLevels(provider.kind);
	let thinking: ThinkingLevel = ov.thinking ?? defaultThinking(provider.kind);
	if (!levels.includes(thinking))
		thinking = defaultThinking(provider.kind);
	const reasoningModel = info?.reasoning ?? inferred.reasoning ?? false;
	return {
		provider,
		model,
		contextWindow: ov.contextWindow || info?.contextWindow || inferred.contextWindow || 128_000,
		maxOutput: ov.maxOutput || info?.maxOutput || inferred.maxOutput || 8192,
		vision,
		// 关闭思考后不再视为推理模型（允许 temperature 生效、无需回传思维链）
		reasoning: reasoningModel && thinking !== 'off',
		temperature: ov.temperature,
		topP: ov.topP,
		thinking,
	};
}

async function readError(res: Response): Promise<string> {
	let text = '';
	try {
		text = await res.text();
	}
	catch {}
	const j = safeJsonParse<any>(text, undefined);
	const msg = j?.error?.message || j?.message || j?.error || text;
	const hint: Record<number, string> = {
		400: '请求参数有误',
		401: 'API Key 无效或未填写',
		402: '账户余额不足',
		403: '无访问权限',
		404: '接口地址或模型不存在',
		413: '请求内容过大',
		422: '参数校验失败',
		429: '请求过于频繁或额度用尽',
		500: '服务端错误',
		502: '网关错误',
		503: '服务繁忙',
	};
	return `HTTP ${res.status}${hint[res.status] ? ` ${hint[res.status]}` : ''}${msg ? `：${truncate(typeof msg === 'string' ? msg : JSON.stringify(msg), 400, false)}` : ''}`;
}

/** 获取模型列表 */
export async function listModels(p: ProviderConfig, signal?: AbortSignal): Promise<ModelInfo[]> {
	const res = await httpRequest(`${providerBaseUrl(p)}/models`, { method: 'GET', headers: headers(p), signal, timeoutMs: 20_000 });
	if (!res.ok)
		throw new Error(await readError(res));
	const j = await res.json();
	const arr: any[] = Array.isArray(j?.data) ? j.data : Array.isArray(j?.models) ? j.models : Array.isArray(j) ? j : [];
	const models = arr.map((m) => {
		const id = String(m?.id ?? m?.name ?? m?.model ?? '').replace(/^models\//, '');
		const inf = inferCapabilities(id);
		const ctx = Number(m?.context_length ?? m?.context_window ?? m?.max_context_length ?? m?.inputTokenLimit ?? m?.top_provider?.context_length) || undefined;
		const out = Number(m?.max_output_tokens ?? m?.max_completion_tokens ?? m?.outputTokenLimit ?? m?.top_provider?.max_completion_tokens) || undefined;
		const modalities: string[] = m?.architecture?.input_modalities ?? m?.input_modalities ?? m?.modalities ?? [];
		const vision = Array.isArray(modalities) && modalities.length ? modalities.includes('image') : (m?.capabilities?.vision ?? inf.vision);
		return { id, contextWindow: ctx ?? inf.contextWindow, maxOutput: out ?? inf.maxOutput, vision: !!vision, reasoning: inf.reasoning } as ModelInfo;
	}).filter(m => m.id && !/embedding|embed|whisper|tts|dall-e|moderation|rerank|audio|image-gen|sora/i.test(m.id));
	models.sort((a, b) => a.id.localeCompare(b.id));
	return models;
}

/** 检测连接：先尝试 /models，失败时发送最小对话请求验证 */
export async function testConnection(p: ProviderConfig, model?: string): Promise<{ ok: boolean; message: string; models?: ModelInfo[] }> {
	if (p.kind !== 'deepseek' && !p.baseUrl.trim())
		return { ok: false, message: '请先填写接口地址（Base URL）' };
	const started = Date.now();
	let listErr = '';
	try {
		const models = await listModels(p);
		return { ok: true, message: `连接成功，${Date.now() - started} ms，可用模型 ${models.length} 个`, models };
	}
	catch (e) {
		listErr = errorMessage(e);
	}
	const m = model || p.models[0]?.id;
	if (!m)
		return { ok: false, message: `获取模型列表失败：${listErr}` };
	try {
		const res = await httpRequest(`${providerBaseUrl(p)}/chat/completions`, {
			method: 'POST',
			headers: headers(p),
			body: JSON.stringify({ model: m, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false }),
			timeoutMs: 30_000,
		});
		if (!res.ok)
			return { ok: false, message: await readError(res) };
		return { ok: true, message: `连接成功（${Date.now() - started} ms）。该接口不支持获取模型列表，请手动添加模型。` };
	}
	catch (e) {
		return { ok: false, message: errorMessage(e) || listErr };
	}
}

// ———————————————————————— 对话 ————————————————————————

export type WireContent = string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string; detail?: string } }>;

export interface WireMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: WireContent | null;
	tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
	tool_call_id?: string;
	name?: string;
	reasoning_content?: string;
}

export interface WireTool {
	type: 'function';
	function: { name: string; description: string; parameters: any };
}

export interface ChatRequest {
	model: ResolvedModel;
	messages: WireMessage[];
	tools?: WireTool[];
	stream: boolean;
	signal?: AbortSignal;
	maxTokens?: number;
}

export interface StreamHandlers {
	onContent?: (delta: string) => void;
	onReasoning?: (delta: string) => void;
	onToolCallDelta?: (calls: ToolCall[]) => void;
}

export interface ChatResult {
	content: string;
	reasoning: string;
	toolCalls: ToolCall[];
	usage?: Usage;
	finishReason?: string;
}

function buildBody(req: ChatRequest, stream: boolean): any {
	const m = req.model;
	const body: any = {
		model: m.model,
		messages: req.messages,
		stream,
		max_tokens: req.maxTokens ?? m.maxOutput,
	};
	if (stream)
		body.stream_options = { include_usage: true };
	if (req.tools?.length) {
		body.tools = req.tools;
		body.tool_choice = 'auto';
	}
	if (m.temperature !== undefined && !m.reasoning)
		body.temperature = m.temperature;
	if (m.topP !== undefined)
		body.top_p = m.topP;
	applyThinking(body, m);
	// OpenAI o 系列 / gpt-5 使用 max_completion_tokens
	if (/^(o\d|gpt-5)/i.test(m.model) && m.provider.kind === 'openai' && /openai\.com/.test(m.provider.baseUrl)) {
		body.max_completion_tokens = body.max_tokens;
		delete body.max_tokens;
	}
	return body;
}

/**
 * 思考强度参数
 * - DeepSeek：thinking.type 开关 + reasoning_effort（low/high/max）
 * - 其它 OpenAI 兼容接口：reasoning_effort（low/medium/high）；off 时发送 reasoning_effort=none 不通用，改为不发送
 */
function applyThinking(body: any, m: ResolvedModel): void {
	const t = m.thinking;
	if (m.provider.kind === 'deepseek') {
		if (t === 'off') {
			body.thinking = { type: 'disabled' };
			return;
		}
		body.thinking = { type: 'enabled' };
		if (t === 'low' || t === 'high' || t === 'max')
			body.reasoning_effort = t;
		return;
	}
	if (t === 'low' || t === 'medium' || t === 'high')
		body.reasoning_effort = t;
	else if (t === 'off' && m.reasoning === false && /^(o\d|gpt-5)/i.test(m.model))
		body.reasoning_effort = 'minimal';
}

function mergeToolDeltas(acc: Map<number, ToolCall>, deltas: any[]): void {
	for (const d of deltas) {
		const idx = typeof d.index === 'number' ? d.index : acc.size;
		const cur = acc.get(idx) ?? { id: '', name: '', arguments: '' };
		if (d.id)
			cur.id = d.id;
		if (d.function?.name)
			cur.name += d.function.name;
		if (d.function?.arguments)
			cur.arguments += d.function.arguments;
		acc.set(idx, cur);
	}
}

function parseUsage(u: any): Usage | undefined {
	if (!u)
		return undefined;
	return { prompt: Number(u.prompt_tokens ?? u.input_tokens ?? 0), completion: Number(u.completion_tokens ?? u.output_tokens ?? 0) };
}

function finalizeCalls(acc: Map<number, ToolCall>): ToolCall[] {
	return [...acc.entries()].sort((a, b) => a[0] - b[0]).map(([i, c]) => ({
		id: c.id || `call_${Date.now().toString(36)}_${i}`,
		name: c.name,
		arguments: c.arguments || '{}',
	})).filter(c => c.name);
}

export async function chatCompletion(req: ChatRequest, h: StreamHandlers = {}): Promise<ChatResult> {
	const p = req.model.provider;
	const url = `${providerBaseUrl(p)}/chat/completions`;
	const doRequest = async (stream: boolean) => httpRequest(url, {
		method: 'POST',
		headers: headers(p),
		body: JSON.stringify(buildBody(req, stream)),
		signal: req.signal,
		timeoutMs: 300_000,
	});

	let res = await doRequest(req.stream);
	if (!res.ok) {
		const err = await readError(res);
		// 部分接口不支持 stream_options 或流式，降级一次
		if (req.stream && res.status === 400 && /stream/i.test(err)) {
			res = await doRequest(false);
			if (!res.ok)
				throw new Error(await readError(res));
		}
		else {
			throw new Error(err);
		}
	}

	const ctype = res.headers.get('content-type') || '';
	if (!req.stream || (!ctype.includes('event-stream') && ctype.includes('json'))) {
		const j = await res.json();
		if (j?.error)
			throw new Error(j.error.message || JSON.stringify(j.error));
		const msg = j?.choices?.[0]?.message ?? {};
		const acc = new Map<number, ToolCall>();
		mergeToolDeltas(acc, (msg.tool_calls ?? []).map((t: any, i: number) => ({ ...t, index: i })));
		const result: ChatResult = {
			content: typeof msg.content === 'string' ? msg.content : '',
			reasoning: msg.reasoning_content ?? msg.reasoning ?? '',
			toolCalls: finalizeCalls(acc),
			usage: parseUsage(j?.usage),
			finishReason: j?.choices?.[0]?.finish_reason,
		};
		if (result.reasoning)
			h.onReasoning?.(result.reasoning);
		if (result.content)
			h.onContent?.(result.content);
		if (result.toolCalls.length)
			h.onToolCallDelta?.(result.toolCalls);
		return result;
	}

	const out: ChatResult = { content: '', reasoning: '', toolCalls: [] };
	const acc = new Map<number, ToolCall>();
	try {
		for await (const data of readSSE(res, req.signal)) {
			if (!data || data === '[DONE]')
				continue;
			const j = safeJsonParse<any>(data, undefined);
			if (!j)
				continue;
			if (j.error)
				throw new Error(j.error.message || JSON.stringify(j.error));
			if (j.usage)
				out.usage = parseUsage(j.usage);
			const choice = j.choices?.[0];
			if (!choice)
				continue;
			const d = choice.delta ?? choice.message ?? {};
			const rc = d.reasoning_content ?? d.reasoning;
			if (typeof rc === 'string' && rc) {
				out.reasoning += rc;
				h.onReasoning?.(rc);
			}
			if (typeof d.content === 'string' && d.content) {
				out.content += d.content;
				h.onContent?.(d.content);
			}
			if (Array.isArray(d.tool_calls) && d.tool_calls.length) {
				mergeToolDeltas(acc, d.tool_calls);
				h.onToolCallDelta?.(finalizeCalls(acc));
			}
			if (choice.finish_reason)
				out.finishReason = choice.finish_reason;
		}
	}
	catch (e) {
		if (isAbort(e))
			throw e;
		if (!out.content && !acc.size)
			throw e;
		out.finishReason = 'error';
	}
	out.toolCalls = finalizeCalls(acc);
	return out;
}
