/**
 * 持久化：设置、对话索引（按工程区分）、对话正文
 *
 * key 约定：
 *   settings                  全局设置
 *   index:<projectKey>        该工程下的对话列表（ConversationMeta[]）
 *   conv:<id>                 对话正文
 *   open:<projectKey>         该工程打开的标签页 id 列表
 */
import type { ChatMessage, Conversation, ConversationMeta, PermissionMode, Settings } from './types';
import { storage } from '../lib/storage';
import { uid } from '../lib/util';
import { DEEPSEEK_BASE_URL, DEEPSEEK_LEGACY, DEEPSEEK_MODELS, defaultProviders, inferCapabilities } from './providers';

export function defaultSettings(): Settings {
	return {
		providers: defaultProviders(),
		activeProviderId: 'deepseek',
		activeModel: 'deepseek-flash',
		theme: 'system',
		defaultPermissionMode: 'ask',
		toolRules: {},
		overrides: {},
		autoContext: true,
		maxToolRounds: 40,
		transport: 'auto',
		streaming: true,
		dockMode: 'float',
		uiScale: 1,
		scope: 'project',
		autoOpenOnProject: true,
		showReasoning: true,
		simEngineMode: 'takeover',
		customInstructions: '',
		sendKey: 'enter',
	};
}

export async function loadSettings(): Promise<Settings> {
	const def = defaultSettings();
	const s = await storage.get<Partial<Settings>>('settings', {});
	const merged: Settings = { ...def, ...s, toolRules: { ...(s.toolRules ?? {}) }, overrides: { ...(s.overrides ?? {}) } };
	// 确保内置 DeepSeek 始终存在
	const providers = Array.isArray(s.providers) && s.providers.length ? s.providers : def.providers;
	if (!providers.some(p => p.kind === 'deepseek'))
		providers.unshift(def.providers[0]);
	merged.providers = providers.map((p) => {
		if (p.kind === 'deepseek') {
			// 迁移：DeepSeek 只保留当前在售模型（deepseek-chat / reasoner 已下线），保留用户手动添加的其它模型
			const extra = (p.models ?? []).filter(m => !DEEPSEEK_LEGACY.has(m.id) && !DEEPSEEK_MODELS.some(d => d.id === m.id));
			return { ...p, baseUrl: DEEPSEEK_BASE_URL, models: [...DEEPSEEK_MODELS.map(m => ({ ...m })), ...extra.map(m => ({ ...inferCapabilities(m.id), ...m }))] };
		}
		return { ...p, models: (p.models ?? []).map(m => ({ ...inferCapabilities(m.id), ...m })) };
	});
	if (!merged.providers.some(p => p.id === merged.activeProviderId))
		merged.activeProviderId = merged.providers[0].id;
	if (DEEPSEEK_LEGACY.has(merged.activeModel))
		merged.activeModel = 'deepseek-flash';
	// 迁移旧版 reasoningEffort → thinking
	for (const [k, ov] of Object.entries(merged.overrides)) {
		if (ov.reasoningEffort && !ov.thinking)
			ov.thinking = (ov.reasoningEffort === 'medium' ? 'high' : ov.reasoningEffort) as any;
		delete ov.reasoningEffort;
		merged.overrides[k] = ov;
	}
	merged.uiScale = Math.min(1.6, Math.max(0.7, Number(merged.uiScale) || 1));
	if (merged.scope !== 'global')
		merged.scope = 'project';
	return merged;
}

export function saveSettings(s: Settings): Promise<void> {
	return storage.set('settings', s);
}

export function newConversation(projectKey: string, mode: PermissionMode): Conversation {
	const now = Date.now();
	return {
		id: uid('c_'),
		projectKey,
		title: '新对话',
		createdAt: now,
		updatedAt: now,
		messages: [],
		changes: [],
		permissionMode: mode,
		sessionAllow: [],
	};
}

export function metaOf(c: Conversation): ConversationMeta {
	return { id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt, count: c.messages.filter(m => m.role === 'user' && m.kind !== 'injection').length };
}

export async function loadIndex(projectKey: string): Promise<ConversationMeta[]> {
	const list = await storage.get<ConversationMeta[]>(`index:${projectKey}`, []);
	return Array.isArray(list) ? list.sort((a, b) => b.updatedAt - a.updatedAt) : [];
}

export function saveIndex(projectKey: string, list: ConversationMeta[]): Promise<void> {
	return storage.set(`index:${projectKey}`, list);
}

export async function loadOpenTabs(projectKey: string): Promise<string[]> {
	const v = await storage.get<string[]>(`open:${projectKey}`, []);
	return Array.isArray(v) ? v : [];
}

export function saveOpenTabs(projectKey: string, ids: string[]): Promise<void> {
	return storage.set(`open:${projectKey}`, ids);
}

/**
 * 修复历史数据：保证每个 assistant.tool_calls 都有对应的 tool 消息，
 * 清除中断时残留的 streaming 标记与未完成的工具状态。
 */
export function sanitizeConversation(c: Conversation): Conversation {
	const out: ChatMessage[] = [];
	const msgs = c.messages ?? [];
	for (let i = 0; i < msgs.length; i++) {
		const m = { ...msgs[i], streaming: false };
		if (m.toolRuns)
			m.toolRuns = m.toolRuns.map(r => (r.status === 'running' || r.status === 'pending' || r.status === 'awaiting') ? { ...r, status: 'cancelled', error: r.error ?? '已中断' } : r);
		out.push(m);
		if (m.role === 'assistant' && m.toolCalls?.length) {
			const answered = new Set<string>();
			let j = i + 1;
			while (j < msgs.length && (msgs[j].role === 'tool' || msgs[j].kind === 'injection')) {
				if (msgs[j].role === 'tool' && msgs[j].toolCallId)
					answered.add(msgs[j].toolCallId!);
				j++;
			}
			const missing = m.toolCalls.filter(tc => !answered.has(tc.id));
			// 先把已有的 tool 消息原样推入，再补齐缺失项
			for (let k = i + 1; k < j; k++)
				out.push(msgs[k]);
			for (const tc of missing)
				out.push({ id: uid('m_'), role: 'tool', toolCallId: tc.id, toolName: tc.name, content: '工具调用已中断，未执行。', createdAt: Date.now() });
			i = j - 1;
		}
	}
	return {
		...c,
		messages: out,
		changes: c.changes ?? [],
		sessionAllow: c.sessionAllow ?? [],
		permissionMode: c.permissionMode ?? 'ask',
	};
}

export async function loadConversation(id: string): Promise<Conversation | undefined> {
	const c = await storage.get<Conversation | null>(`conv:${id}`, null);
	return c ? sanitizeConversation(c) : undefined;
}

export function saveConversation(c: Conversation): Promise<void> {
	return storage.set(`conv:${c.id}`, c);
}

export function deleteConversationData(id: string): Promise<void> {
	return storage.remove(`conv:${id}`);
}

/** 导出为 Markdown */
export function conversationToMarkdown(c: Conversation): string {
	const lines: string[] = [`# ${c.title}`, '', `> 导出时间：${new Date().toLocaleString()}`, ''];
	for (const m of c.messages) {
		if (m.kind === 'injection')
			continue;
		if (m.role === 'user') {
			lines.push('## 用户', '', m.content);
			for (const a of m.attachments ?? [])
				lines.push(`- 附件：${a.name}`);
			lines.push('');
		}
		else if (m.role === 'assistant') {
			lines.push('## EDA Agent', '');
			if (m.content)
				lines.push(m.content, '');
			for (const r of m.toolRuns ?? [])
				lines.push(`- 工具 \`${r.name}\`（${r.status}）${r.summary ? `：${r.summary}` : ''}`);
			lines.push('');
		}
	}
	return lines.join('\n');
}
