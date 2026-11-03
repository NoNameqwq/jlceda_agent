/**
 * Agent 引擎：单个对话的完整运行循环
 *
 * 用户消息 → 自动获取编辑器上下文 → 构建系统提示词与工具列表 → 流式请求模型
 * → 解析工具调用 → 权限判定（必要时等待用户审批）→ 执行工具并记录改动 → 回填结果 → 继续，直到模型给出最终回复。
 *
 * 另外负责：上下文压缩、标题生成、回溯（rewind）、分叉、改动撤销。
 */
import type { AskRequest, ToolContext } from '../tools/registry';
import type { WireMessage, WireTool } from './providers';
import type { Attachment, ChangeItem, ChangeRecord, ChatMessage, ContextBreakdown, ContextSegment, Conversation, EditorContext, PermissionMode, PlanStep, ProjectOverview, RiskLevel, Settings, ToolRun, Usage } from './types';
import { isAbort } from '../lib/http';
import { errorMessage, estimateTokens, safeJsonParse, safeStringify, truncate, uid } from '../lib/util';
import { getTool, resultToString, toolRisk, toolsForScene, toWire } from '../tools/registry';
import { decide } from './permissions';
import { buildSystemPrompt, SUMMARY_PROMPT, TITLE_PROMPT } from './prompt';
import { chatCompletion, resolveModel } from './providers';
import { buildToolPrimer } from './tool-primer';
import { undoChange } from './undo';

export type ApprovalChoice = 'allow' | 'allow-session' | 'deny';

export interface PendingApproval {
	callId: string;
	tool: string;
	title: string;
	summary: string;
	args: any;
	risk: RiskLevel;
	reason: string;
	resolve: (choice: ApprovalChoice, feedback?: string) => void;
}

export interface PendingQuestion extends AskRequest {
	callId: string;
	resolve: (answer: string) => void;
}

export interface SessionDeps {
	getSettings: () => Settings;
	getEditor: () => Promise<EditorContext>;
	getOverview?: (ctx: EditorContext) => Promise<ProjectOverview | undefined>;
	persist: (c: Conversation) => void;
	onTitle?: (c: Conversation) => void;
}

const RECREATABLE = new Set(['sch_PrimitiveWire', 'sch_PrimitiveText', 'pcb_PrimitiveLine', 'pcb_PrimitiveVia']);

/** 当前轮可以把 reasoning_content 回传的模型（DeepSeek 思考模式工具调用要求同一轮内回传） */
function passReasoning(providerKind: string, reasoning: boolean): boolean {
	return providerKind === 'deepseek' && reasoning;
}

export class Session {
	conv: Conversation;
	running = false;
	/** 状态文字最近一次变化的时间（界面据此显示已等待秒数） */
	statusAt = Date.now();
	private _status = '';
	get status(): string {
		return this._status;
	}

	set status(v: string) {
		if (v !== this._status) {
			this._status = v;
			this.statusAt = Date.now();
		}
	}
	approval?: PendingApproval;
	question?: PendingQuestion;
	lastError?: string;
	contextTokens = 0;
	contextWindow = 0;
	breakdown?: ContextBreakdown;
	lastUsage?: Usage;
	private listeners = new Set<() => void>();
	private abort?: AbortController;
	private emitTimer?: ReturnType<typeof setTimeout>;
	private persistTimer?: ReturnType<typeof setTimeout>;

	constructor(conv: Conversation, private deps: SessionDeps) {
		this.conv = conv;
	}

	// ———————————————————— 订阅 ————————————————————

	subscribe(fn: () => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	emit(immediate = true): void {
		if (immediate) {
			if (this.emitTimer) {
				clearTimeout(this.emitTimer);
				this.emitTimer = undefined;
			}
			for (const l of this.listeners) l();
			return;
		}
		if (this.emitTimer)
			return;
		this.emitTimer = setTimeout(() => {
			this.emitTimer = undefined;
			for (const l of this.listeners) l();
		}, 40);
	}

	private persist(immediate = false): void {
		this.conv.updatedAt = Date.now();
		if (this.persistTimer)
			clearTimeout(this.persistTimer);
		if (immediate) {
			this.persistTimer = undefined;
			this.deps.persist(this.conv);
			return;
		}
		this.persistTimer = setTimeout(() => {
			this.persistTimer = undefined;
			this.deps.persist(this.conv);
		}, 600);
	}

	// ———————————————————— 公共操作 ————————————————————

	setMode(mode: PermissionMode): void {
		this.conv.permissionMode = mode;
		this.persist(true);
		this.emit();
	}

	stop(): void {
		this.abort?.abort();
		this.approval?.resolve('deny', '用户中止了本轮任务');
		this.question?.resolve('（用户中止了本轮任务，未回答）');
	}

	async send(text: string, attachments: Attachment[] = []): Promise<void> {
		if (this.running)
			return;
		const content = text.trim();
		if (!content && !attachments.length)
			return;
		const msg: ChatMessage = { id: uid('m_'), role: 'user', content, attachments: attachments.length ? attachments : undefined, createdAt: Date.now() };
		this.conv.messages.push(msg);
		if (this.conv.title === '新对话' && content)
			this.conv.title = truncate(content.replace(/\s+/g, ' '), 18, false);
		this.persist(true);
		await this.runTurn(msg.id);
	}

	/** 重新生成最后一轮回复 */
	async regenerate(): Promise<void> {
		if (this.running)
			return;
		const idx = this.lastUserIndex();
		if (idx < 0)
			return;
		this.conv.messages = this.conv.messages.slice(0, idx + 1);
		this.persist(true);
		await this.runTurn(this.conv.messages[idx].id);
	}

	/** 当最后一轮因错误中断时继续 */
	async continueTurn(): Promise<void> {
		if (this.running)
			return;
		const idx = this.lastUserIndex();
		if (idx < 0)
			return;
		await this.runTurn(this.conv.messages[idx].id);
	}

	/** 某条用户消息之后产生的改动 */
	changesAfter(messageId: string): ChangeRecord[] {
		const idx = this.conv.messages.findIndex(m => m.id === messageId);
		if (idx < 0)
			return [];
		const turnIds = new Set(this.conv.messages.slice(idx).filter(m => m.role === 'user').map(m => m.id));
		return this.conv.changes.filter(c => turnIds.has(c.messageId) && c.status !== 'undone');
	}

	/**
	 * 回溯到某条用户消息之前：删除该消息及之后的全部内容，可选同时撤销这些轮次产生的设计改动。
	 * 返回被删除的用户消息（供界面回填到输入框重新编辑）。
	 */
	async rewindTo(messageId: string, undoDesign: boolean): Promise<{ message?: ChatMessage; errors: string[] }> {
		if (this.running)
			this.stop();
		const idx = this.conv.messages.findIndex(m => m.id === messageId);
		if (idx < 0)
			return { errors: [] };
		const message = this.conv.messages[idx];
		const affected = this.changesAfter(messageId);
		const errors: string[] = [];
		if (undoDesign) {
			for (const rec of [...affected].reverse()) {
				if (!rec.undoable) {
					errors.push(`「${rec.title}」无法自动撤销${rec.note ? `（${rec.note}）` : ''}`);
					continue;
				}
				errors.push(...await undoChange(rec));
			}
		}
		const turnIds = new Set(this.conv.messages.slice(idx).filter(m => m.role === 'user').map(m => m.id));
		this.conv.messages = this.conv.messages.slice(0, idx);
		// 已撤销的改动从记录中移除；未撤销的保留并标注
		this.conv.changes = this.conv.changes.filter(c => !(turnIds.has(c.messageId) && c.status === 'undone')).map(c => turnIds.has(c.messageId) ? { ...c, note: c.note ?? '所属对话已回溯，设计改动仍保留' } : c);
		if ((this.conv.compactedCount ?? 0) > this.conv.messages.length) {
			this.conv.compactedCount = 0;
			this.conv.summary = undefined;
		}
		this.conv.plan = undefined;
		this.lastError = undefined;
		this.persist(true);
		this.emit();
		return { message, errors };
	}

	async undoRecord(id: string): Promise<string[]> {
		const rec = this.conv.changes.find(c => c.id === id);
		if (!rec)
			return ['未找到改动记录'];
		if (!rec.undoable)
			return [rec.note ?? '该改动无法自动撤销，请在 EDA 中使用 Ctrl+Z'];
		const errors = await undoChange(rec);
		this.persist(true);
		this.emit();
		return errors;
	}

	async undoAll(): Promise<string[]> {
		const errors: string[] = [];
		for (const rec of [...this.conv.changes].reverse()) {
			if (rec.status === 'undone')
				continue;
			if (!rec.undoable) {
				errors.push(`「${rec.title}」无法自动撤销`);
				continue;
			}
			errors.push(...await undoChange(rec));
		}
		this.persist(true);
		this.emit();
		return errors;
	}

	/** 手动压缩上下文 */
	async compactNow(): Promise<void> {
		if (this.running)
			return;
		this.running = true;
		this.status = '正在压缩上下文…';
		this.emit();
		try {
			const ok = await this.compact(new AbortController().signal, true);
			if (!ok)
				this.lastError = '对话太短，无需压缩';
		}
		catch (e) {
			this.lastError = `压缩失败：${errorMessage(e)}`;
		}
		finally {
			this.running = false;
			this.status = '';
			this.persist(true);
			this.emit();
		}
	}

	private lastUserIndex(): number {
		for (let i = this.conv.messages.length - 1; i >= 0; i--) {
			const m = this.conv.messages[i];
			if (m.role === 'user' && m.kind !== 'injection')
				return i;
		}
		return -1;
	}

	// ———————————————————— 消息构建 ————————————————————

	private userWire(m: ChatMessage, vision: boolean, lean: boolean): WireMessage {
		const parts: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = [];
		let text = m.content || '';
		for (const a of m.attachments ?? []) {
			if (a.kind === 'file') {
				const body = a.text !== undefined
					? `\n\n附件「${a.name}」${a.truncated ? '（已截断）' : ''}：\n\`\`\`\n${lean ? truncate(a.text, 1500) : a.text}\n\`\`\``
					: `\n\n[附件「${a.name}」为二进制文件（${a.mime || '未知类型'}），无法读取内容]`;
				text += body;
			}
		}
		const images = (m.attachments ?? []).filter(a => a.kind === 'image' && a.dataUrl);
		if (images.length && vision && !lean) {
			if (text)
				parts.push({ type: 'text', text });
			for (const img of images)
				parts.push({ type: 'image_url', image_url: { url: img.dataUrl! } });
			return { role: 'user', content: parts };
		}
		if (images.length)
			text += `\n\n[用户附带了 ${images.length} 张图片：${images.map(i => i.name).join('、')}${vision ? '（早前图片已省略）' : '（当前模型不支持识图，无法查看）'}]`;
		return { role: 'user', content: text || '(空消息)' };
	}

	/** 把对话转换为接口消息；leanBefore 之前的消息使用精简形式（截断工具结果、省略图片） */
	private buildWire(system: string, vision: boolean, reasoningPass: boolean, leanBefore = 0): WireMessage[] {
		const out: WireMessage[] = [{ role: 'system', content: system }];
		const start = this.conv.compactedCount ?? 0;
		const msgs = this.conv.messages.slice(start);
		const lastUser = (() => {
			for (let i = msgs.length - 1; i >= 0; i--) {
				if (msgs[i].role === 'user' && msgs[i].kind !== 'injection')
					return i;
			}
			return 0;
		})();
		msgs.forEach((m, i) => {
			const lean = i + start < leanBefore;
			if (m.role === 'user') {
				if (m.kind === 'injection') {
					if (lean || !vision)
						return;
					out.push(this.userWire(m, vision, false));
					return;
				}
				out.push(this.userWire(m, vision, lean));
			}
			else if (m.role === 'assistant') {
				if (m.error && !m.content && !m.toolCalls?.length)
					return;
				const w: WireMessage = { role: 'assistant', content: m.content || (m.toolCalls?.length ? '' : '(无内容)') };
				if (m.toolCalls?.length)
					w.tool_calls = m.toolCalls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments || '{}' } }));
				if (reasoningPass)
					w.reasoning_content = m.reasoning ?? '';
				void lastUser;
				out.push(w);
			}
			else if (m.role === 'tool') {
				out.push({ role: 'tool', tool_call_id: m.toolCallId!, content: lean ? truncate(m.content, 900) : m.content });
			}
		});
		return out;
	}

	private estimate(wire: WireMessage[], tools: WireTool[]): number {
		let n = estimateTokens(JSON.stringify(tools));
		for (const m of wire) {
			if (typeof m.content === 'string')
				n += estimateTokens(m.content);
			else if (Array.isArray(m.content)) {
				for (const p of m.content)
					n += p.type === 'text' ? estimateTokens(p.text) : 1100;
			}
			if (m.tool_calls)
				n += estimateTokens(JSON.stringify(m.tool_calls));
			if (m.reasoning_content)
				n += estimateTokens(m.reasoning_content);
			n += 6;
		}
		return n;
	}

	/** 按类别统计上下文占用（估算） */
	private computeBreakdown(wire: WireMessage[], tools: WireTool[], window: number, reservedOutput: number, threshold: number, model: string): ContextBreakdown {
		const seg: Record<string, ContextSegment> = {
			system: { key: 'system', label: '系统提示词', tokens: 0, note: '身份、规则、工程概览、编辑器状态' },
			tools: { key: 'tools', label: '工具定义', tokens: estimateTokens(JSON.stringify(tools)), note: `${tools.length} 个工具` },
			summary: { key: 'summary', label: '早前摘要', tokens: 0 },
			user: { key: 'user', label: '用户消息', tokens: 0 },
			assistant: { key: 'assistant', label: '助手回复', tokens: 0 },
			reasoning: { key: 'reasoning', label: '思维链回传', tokens: 0 },
			toolResults: { key: 'toolResults', label: '工具结果', tokens: 0 },
			images: { key: 'images', label: '图片', tokens: 0 },
		};
		let imgCount = 0;
		let toolCount = 0;
		const sumTokens = this.conv.summary ? estimateTokens(this.conv.summary) : 0;
		for (const m of wire) {
			if (m.role === 'system') {
				seg.system.tokens += estimateTokens(String(m.content ?? '')) - sumTokens;
				seg.summary.tokens += sumTokens;
			}
			else if (m.role === 'user') {
				if (typeof m.content === 'string') {
					seg.user.tokens += estimateTokens(m.content);
				}
				else if (Array.isArray(m.content)) {
					for (const p of m.content) {
						if (p.type === 'text') {
							seg.user.tokens += estimateTokens(p.text);
						}
						else {
							seg.images.tokens += 1100;
							imgCount++;
						}
					}
				}
			}
			else if (m.role === 'assistant') {
				seg.assistant.tokens += estimateTokens(typeof m.content === 'string' ? m.content : '') + (m.tool_calls ? estimateTokens(JSON.stringify(m.tool_calls)) : 0);
				if (m.reasoning_content)
					seg.reasoning.tokens += estimateTokens(m.reasoning_content);
			}
			else if (m.role === 'tool') {
				seg.toolResults.tokens += estimateTokens(typeof m.content === 'string' ? m.content : '');
				toolCount++;
			}
		}
		if (imgCount)
			seg.images.note = `${imgCount} 张`;
		if (toolCount)
			seg.toolResults.note = `${toolCount} 条`;
		if (this.conv.compactedCount)
			seg.summary.note = `已压缩 ${this.conv.compactedCount} 条消息`;
		const segments = Object.values(seg).filter(s => s.tokens > 0).map(s => ({ ...s, tokens: Math.max(0, Math.round(s.tokens)) }));
		const total = segments.reduce((a, s) => a + s.tokens, 0);
		return { segments, total, window, reservedOutput, threshold: Math.round(threshold), compacted: this.conv.compactedCount ?? 0, lastUsage: this.lastUsage, model };
	}

	/** 界面打开详情时调用：未发送过消息也能看到当前估算 */
	previewBreakdown(editor: EditorContext): ContextBreakdown | undefined {
		const settings = this.deps.getSettings();
		const resolved = resolveModel(settings);
		if (!resolved)
			return undefined;
		const defs = toolsForScene(editor.available ? editor.scene : 'none', n => settings.toolRules[n] === 'deny');
		const tools = defs.map(toWire);
		const system = buildSystemPrompt({ editor, mode: this.conv.permissionMode, vision: resolved.vision, model: resolved.model, plan: this.conv.plan, custom: settings.customInstructions, summary: this.conv.summary, autoContext: settings.autoContext, scope: settings.scope, toolPrimer: buildToolPrimer(defs), skills: settings.enabledSkills });
		const wire = this.buildWire(system, resolved.vision, passReasoning(resolved.provider.kind, resolved.reasoning));
		const budget = Math.max(4000, resolved.contextWindow - resolved.maxOutput - 1500);
		return this.computeBreakdown(wire, tools, resolved.contextWindow, resolved.maxOutput, budget * 0.85, resolved.model);
	}

	/** 将较早的对话压缩为摘要。返回是否执行了压缩 */
	private async compact(signal: AbortSignal, force = false): Promise<boolean> {
		const resolved = resolveModel(this.deps.getSettings());
		if (!resolved)
			throw new Error('未配置模型');
		// 保留最近 2 轮用户消息
		const userIdx = this.conv.messages.map((m, i) => (m.role === 'user' && m.kind !== 'injection') ? i : -1).filter(i => i >= 0);
		const keep = force ? 1 : 2;
		if (userIdx.length <= keep)
			return false;
		const cut = userIdx[userIdx.length - keep];
		const start = this.conv.compactedCount ?? 0;
		if (cut <= start)
			return false;
		const slice = this.conv.messages.slice(start, cut);
		const transcript = slice.map((m) => {
			if (m.kind === 'injection')
				return '';
			if (m.role === 'user')
				return `用户：${m.content}${m.attachments?.length ? `（附件：${m.attachments.map(a => a.name).join('、')}）` : ''}`;
			if (m.role === 'assistant')
				return `助手：${m.content}${m.toolCalls?.length ? `\n调用工具：${m.toolCalls.map(c => `${c.name}(${truncate(c.arguments, 200, false)})`).join('；')}` : ''}`;
			return `工具结果[${m.toolName}]：${truncate(m.content, 600, false)}`;
		}).filter(Boolean).join('\n');
		const prev = this.conv.summary ? `已有摘要：\n${this.conv.summary}\n\n` : '';
		const r = await chatCompletion({
			model: resolved,
			messages: [
				{ role: 'system', content: '你是对话摘要助手。' },
				{ role: 'user', content: `${prev}需要压缩的对话：\n${truncate(transcript, Math.max(8000, (resolved.contextWindow - resolved.maxOutput) * 2), true)}\n\n${SUMMARY_PROMPT}` },
			],
			stream: false,
			signal,
			maxTokens: Math.min(1500, resolved.maxOutput),
		});
		const summary = r.content.trim();
		if (!summary)
			throw new Error('模型未返回摘要');
		this.conv.summary = summary;
		this.conv.compactedCount = cut;
		return true;
	}

	private async generateTitle(): Promise<void> {
		if (this.conv.titleLocked)
			return;
		const resolved = resolveModel(this.deps.getSettings());
		if (!resolved)
			return;
		const firstUser = this.conv.messages.find(m => m.role === 'user' && m.kind !== 'injection');
		const firstReply = this.conv.messages.find(m => m.role === 'assistant' && m.content);
		if (!firstUser)
			return;
		try {
			const r = await chatCompletion({
				model: { ...resolved, thinking: resolved.provider.kind === 'deepseek' ? 'off' : 'default', reasoning: false },
				messages: [
					{ role: 'user', content: `用户：${truncate(firstUser.content, 400, false)}\n助手：${truncate(firstReply?.content ?? '', 300, false)}\n\n${TITLE_PROMPT}` },
				],
				stream: false,
				maxTokens: 60,
			});
			const t = r.content.replace(/["'“”‘’《》。.\n#*]/g, '').trim();
			if (t && t.length <= 30) {
				this.conv.title = t;
				this.conv.titleLocked = true;
				this.persist(true);
				this.deps.onTitle?.(this.conv);
				this.emit();
			}
		}
		catch {}
	}

	// ———————————————————— 主循环 ————————————————————

	private async runTurn(turnId: string): Promise<void> {
		const settings = this.deps.getSettings();
		const resolved = resolveModel(settings);
		this.lastError = undefined;
		if (!resolved) {
			this.lastError = '尚未配置模型，请在设置中填写 API Key 并选择模型。';
			this.emit();
			return;
		}
		if (!resolved.provider.apiKey.trim() && resolved.provider.kind === 'deepseek') {
			this.lastError = '请先在设置 → 模型接口中填写 DeepSeek API Key。';
			this.emit();
			return;
		}
		this.running = true;
		this.abort = new AbortController();
		const signal = this.abort.signal;
		this.contextWindow = resolved.contextWindow;
		const isFirstTurn = this.conv.messages.filter(m => m.role === 'user' && m.kind !== 'injection').length === 1;
		this.emit();

		try {
			const maxRounds = Math.max(1, settings.maxToolRounds || 40);
			for (let round = 0; round < maxRounds; round++) {
				if (signal.aborted)
					break;
				this.status = round === 0 ? '读取编辑器状态…' : '继续思考…';
				this.emit();
				const editor = await this.deps.getEditor();
				const mode = this.conv.permissionMode;
				const rules = settings.toolRules;
				const tools = editor.available
					? toolsForScene(editor.scene, n => rules[n] === 'deny').filter((t) => {
							if (mode !== 'readonly')
								return true;
							return typeof t.risk === 'function' || t.risk === 'read';
						})
					: toolsForScene('none', n => rules[n] === 'deny').filter(t => t.group === 'meta' && t.name !== 'eda_help');
				const wireTools = tools.map(toWire);
				const overview = settings.scope !== 'global' && editor.available ? await this.deps.getOverview?.(editor).catch(() => undefined) : undefined;
				const promptOpts = () => ({
					editor,
					mode,
					vision: resolved.vision,
					model: resolved.model,
					plan: this.conv.plan,
					custom: settings.customInstructions,
					summary: this.conv.summary,
					autoContext: settings.autoContext,
					scope: settings.scope,
					overview,
					toolPrimer: buildToolPrimer(tools),
					skills: settings.enabledSkills,
				});
				const system = buildSystemPrompt(promptOpts());
				const reasoningPass = passReasoning(resolved.provider.kind, resolved.reasoning);

				// 上下文预算检查：先精简旧消息，仍然超出时压缩为摘要
				const budget = Math.max(4000, resolved.contextWindow - resolved.maxOutput - 1500);
				let wire = this.buildWire(system, resolved.vision, reasoningPass);
				let est = this.estimate(wire, wireTools);
				if (est > budget * 0.85) {
					const lastUser = this.lastUserIndex();
					wire = this.buildWire(system, resolved.vision, reasoningPass, lastUser);
					est = this.estimate(wire, wireTools);
					if (est > budget * 0.85) {
						this.status = '上下文接近上限，正在压缩早前对话…';
						this.emit();
						try {
							if (await this.compact(signal)) {
								const sys2 = buildSystemPrompt(promptOpts());
								wire = this.buildWire(sys2, resolved.vision, reasoningPass, lastUser);
								est = this.estimate(wire, wireTools);
							}
						}
						catch (e) {
							if (isAbort(e))
								throw e;
						}
					}
				}
				this.contextTokens = est;
				this.breakdown = this.computeBreakdown(wire, wireTools, resolved.contextWindow, resolved.maxOutput, budget * 0.85, resolved.model);

				// —— 请求模型 ——
				const am: ChatMessage = { id: uid('m_'), role: 'assistant', content: '', reasoning: '', createdAt: Date.now(), model: resolved.model, streaming: true };
				this.conv.messages.push(am);
				this.status = '思考中…';
				this.emit();
				const t0 = Date.now();
				let result;
				try {
					result = await chatCompletion({ model: resolved, messages: wire, tools: wireTools.length ? wireTools : undefined, stream: settings.streaming, signal }, {
						onReset: () => {
							am.content = '';
							am.reasoning = '';
							this.emit();
						},
						onRetry: (n, reason) => {
							this.status = `连接不稳定，正在重试（第 ${n} 次）：${truncate(reason, 40, false)}`;
							this.emit();
						},
						onContent: (d) => {
							am.content += d;
							this.status = '正在回复…';
							this.emit(false);
						},
						onReasoning: (d) => {
							am.reasoning = (am.reasoning ?? '') + d;
							this.status = '深度思考中…';
							this.emit(false);
						},
						onToolCallDelta: (calls) => {
							this.status = `准备调用 ${calls.map(c => getTool(c.name)?.title ?? c.name).join('、')}…`;
							this.emit(false);
						},
					});
				}
				catch (e) {
					am.streaming = false;
					if (isAbort(e)) {
						if (!am.content && !am.reasoning)
							this.conv.messages.pop();
						break;
					}
					am.error = errorMessage(e);
					this.lastError = am.error;
					break;
				}
				am.streaming = false;
				am.content = result.content;
				am.reasoning = result.reasoning || am.reasoning;
				am.usage = result.usage;
				am.durationMs = Date.now() - t0;
				if (result.usage) {
					this.contextTokens = result.usage.prompt + result.usage.completion;
					this.lastUsage = result.usage;
					if (this.breakdown)
						this.breakdown = { ...this.breakdown, lastUsage: result.usage };
				}
				this.conv.lastPromptTokens = this.contextTokens;
				if (!am.reasoning)
					delete am.reasoning;
				if (result.finishReason === 'error' && !result.toolCalls.length)
					am.error = '回复中途断开，内容可能不完整。可点「重试」继续。';
				if (result.finishReason === 'length' && !result.toolCalls.length)
					am.error = '回复达到最大输出长度被截断，可在高级设置中调大「最大输出」。';

				if (!result.toolCalls.length) {
					this.persist(true);
					break;
				}

				// —— 执行工具 ——
				am.toolCalls = result.toolCalls;
				const runs = result.toolCalls.map((c): ToolRun => {
					const def = getTool(c.name);
					const args = safeJsonParse<any>(c.arguments, undefined);
					return {
						callId: c.id,
						name: c.name,
						title: def?.title ?? c.name,
						summary: def?.summarize && args ? safeSummary(() => def.summarize!(args)) : undefined,
						args: args ?? c.arguments,
						risk: def ? toolRisk(def, args ?? {}) : 'read',
						status: 'pending',
					};
				});
				am.toolRuns = runs;
				this.persist();
				this.emit();

				const injections: ChatMessage[] = [];
				let ctxEditor = editor;
				for (const [i, call] of result.toolCalls.entries()) {
					const run = runs[i];
					if (signal.aborted) {
						run.status = 'cancelled';
						this.pushToolResult(call.id, call.name, '用户中止，未执行。');
						continue;
					}
					const output = await this.executeTool(call.id, call.name, call.arguments, run, ctxEditor, turnId, am.id, resolved.vision, signal, injections);
					this.pushToolResult(call.id, call.name, output);
					if (call.name === 'open_document' || call.name === 'create_document')
						ctxEditor = await this.deps.getEditor();
					this.persist();
					this.emit();
				}
				this.conv.messages.push(...injections);
				this.persist();
				if (signal.aborted)
					break;
				if (round === maxRounds - 1) {
					this.conv.messages.push({ id: uid('m_'), role: 'assistant', content: '', error: `已达到单轮最大工具调用次数（${maxRounds}），已暂停。可回复「继续」让我接着做。`, createdAt: Date.now() });
				}
			}
		}
		catch (e) {
			if (!isAbort(e))
				this.lastError = errorMessage(e);
		}
		finally {
			this.running = false;
			this.status = '';
			this.approval = undefined;
			this.question = undefined;
			this.abort = undefined;
			for (const m of this.conv.messages) {
				if (m.streaming)
					m.streaming = false;
				m.toolRuns?.forEach((r) => {
					if (r.status === 'pending' || r.status === 'running' || r.status === 'awaiting')
						r.status = 'cancelled';
				});
			}
			this.persist(true);
			this.emit();
		}
		if (isFirstTurn && !this.lastError)
			void this.generateTitle();
	}

	private pushToolResult(callId: string, name: string, content: string): void {
		this.conv.messages.push({ id: uid('m_'), role: 'tool', toolCallId: callId, toolName: name, content, createdAt: Date.now() });
	}

	private async executeTool(
		callId: string,
		name: string,
		rawArgs: string,
		run: ToolRun,
		editor: EditorContext,
		turnId: string,
		assistantId: string,
		vision: boolean,
		signal: AbortSignal,
		injections: ChatMessage[],
	): Promise<string> {
		const def = getTool(name);
		if (!def) {
			run.status = 'error';
			run.error = '未知工具';
			return `错误：不存在名为 ${name} 的工具。`;
		}
		const args = safeJsonParse<any>(rawArgs || '{}', undefined);
		if (args === undefined || typeof args !== 'object') {
			run.status = 'error';
			run.error = '参数不是合法 JSON';
			return `错误：参数不是合法的 JSON 对象，请修正后重试。收到：${truncate(rawArgs, 300, false)}`;
		}
		const settings = this.deps.getSettings();
		const risk = toolRisk(def, args);
		run.risk = risk;
		const { decision, reason } = decide({ tool: name, risk, mode: this.conv.permissionMode, rules: settings.toolRules, sessionAllow: this.conv.sessionAllow });
		if (decision === 'deny') {
			run.status = 'denied';
			run.denyReason = reason;
			return `操作被权限系统拒绝：${reason}。不要重复尝试；如确有必要，请告诉用户需要调整权限。`;
		}
		if (decision === 'ask') {
			run.status = 'awaiting';
			this.status = `等待确认：${def.title}`;
			this.emit();
			const { choice, feedback } = await new Promise<{ choice: ApprovalChoice; feedback?: string }>((resolve) => {
				this.approval = {
					callId,
					tool: name,
					title: def.title,
					summary: run.summary ?? '',
					args,
					risk,
					reason,
					resolve: (c, f) => {
						this.approval = undefined;
						resolve({ choice: c, feedback: f });
					},
				};
				this.emit();
			});
			if (choice === 'deny') {
				run.status = 'denied';
				run.denyReason = feedback || '用户拒绝';
				this.emit();
				return `用户拒绝执行此操作${feedback ? `，原因 / 意见：${feedback}` : ''}。请根据用户意见调整方案，或询问用户希望怎么做；不要原样重试。`;
			}
			if (choice === 'allow-session' && !this.conv.sessionAllow.includes(name))
				this.conv.sessionAllow.push(name);
		}

		run.status = 'running';
		run.startedAt = Date.now();
		this.status = `执行：${def.title}${run.summary ? ` · ${truncate(run.summary, 40, false)}` : ''}`;
		this.emit();

		const ctx: ToolContext = {
			signal,
			editor,
			vision,
			askUser: (q: AskRequest) => new Promise<string>((resolve) => {
				this.status = '等待你的回答…';
				this.question = {
					...q,
					callId,
					resolve: (answer) => {
						this.question = undefined;
						this.status = '继续执行…';
						resolve(answer);
						this.emit();
					},
				};
				this.emit();
			}),
			setPlan: (steps: PlanStep[]) => {
				this.conv.plan = steps;
				this.emit();
			},
			recordChange: (items: ChangeItem[], opts) => {
				if (!items.length)
					return;
				let rec = this.conv.changes.find(c => c.callId === callId);
				if (!rec) {
					rec = {
						id: uid('chg_'),
						messageId: turnId,
						callId,
						tool: name,
						title: def.title,
						summary: opts?.summary ?? run.summary ?? '',
						createdAt: Date.now(),
						docUuid: editor.documentUuid,
						scene: editor.scene,
						items: [],
						undoable: true,
						status: 'applied',
					};
					this.conv.changes.push(rec);
				}
				rec.items.push(...items);
				const autoUndoable = items.every(it => it.op === 'create' || it.op === 'modify' || (it.op === 'delete' && RECREATABLE.has(it.kind)));
				rec.undoable = rec.undoable && (opts?.undoable ?? autoUndoable);
				if (opts?.note)
					rec.note = opts.note;
				run.changeId = rec.id;
				void assistantId;
			},
			attachImage: (dataUrl: string, caption: string) => {
				injections.push({
					id: uid('m_'),
					role: 'user',
					kind: 'injection',
					content: `[工具 ${name} 返回的图像：${caption}]`,
					attachments: [{ id: uid('a_'), kind: 'image', name: caption, mime: 'image/jpeg', size: dataUrl.length, dataUrl }],
					createdAt: Date.now(),
				});
			},
		};

		try {
			const limit = toolTimeout(name);
			const r: any = limit ? await withToolTimeout(def.run(args, ctx), limit, def.title, signal) : await def.run(args, ctx);
			const isRich = r && typeof r === 'object' && 'content' in r && Object.keys(r).every(k => k === 'content' || k === 'display');
			const content = isRich ? r.content : r;
			if (isRich && r.display)
				run.display = r.display;
			const text = resultToString(content === undefined ? '完成' : content);
			run.status = 'done';
			run.result = truncate(text, 6000);
			run.endedAt = Date.now();
			return text;
		}
		catch (e) {
			run.endedAt = Date.now();
			if (isAbort(e) || signal.aborted) {
				run.status = 'cancelled';
				return '用户中止，未完成。';
			}
			const msg = errorMessage(e);
			run.status = 'error';
			run.error = msg;
			return `工具执行出错：${msg}`;
		}
	}
}

/** 工具超时（毫秒）：交互类不限时；自动布线/导出等耗时操作放宽 */
function toolTimeout(name: string): number {
	if (name === 'ask_user')
		return 0;
	if (/^(pcb_auto|sch_auto_arrange|place_order|run_script)$/.test(name))
		return 10 * 60_000;
	if (/^(export_|pcb_drc|sch_drc|pcb_import_changes|sch_import_changes|view_screenshot|lib_)/.test(name))
		return 120_000;
	return 45_000;
}

/** EDA 接口偶尔不返回，超时后放弃等待并把结果告诉模型，避免整轮卡死 */
function withToolTimeout<T>(p: Promise<T>, ms: number, title: string, signal: AbortSignal): Promise<T> {
	return new Promise((resolve, reject) => {
		const t = setTimeout(() => {
			cleanup();
			reject(new Error(`「${title}」超过 ${Math.round(ms / 1000)} 秒未返回，已放弃等待。EDA 可能仍在后台执行，请用查询工具确认结果后再继续，不要直接重复该操作。`));
		}, ms);
		const onAbort = () => {
			cleanup();
			const e = new Error('已中止');
			e.name = 'AbortError';
			reject(e);
		};
		const cleanup = () => {
			clearTimeout(t);
			signal.removeEventListener('abort', onAbort);
		};
		signal.addEventListener('abort', onAbort);
		p.then((v) => {
			cleanup();
			resolve(v);
		}, (e) => {
			cleanup();
			reject(e);
		});
	});
}

function safeSummary(fn: () => string): string | undefined {
	try {
		const s = fn();
		return s ? truncate(String(s), 120, false) : undefined;
	}
	catch {
		return undefined;
	}
}

/** 从某条消息处分叉出新对话（复制之前的全部消息，不含改动记录） */
export function forkConversation(src: Conversation, messageId: string, projectKey: string): Conversation {
	const idx = src.messages.findIndex(m => m.id === messageId);
	const msgs = idx >= 0 ? src.messages.slice(0, idx + 1) : [...src.messages];
	// 保证分叉点不以未回填的 tool_calls 结尾
	while (msgs.length) {
		const last = msgs[msgs.length - 1];
		if (last.role === 'assistant' && last.toolCalls?.length)
			msgs.pop();
		else break;
	}
	const now = Date.now();
	return {
		id: uid('c_'),
		projectKey,
		title: `${src.title}（分支）`,
		createdAt: now,
		updatedAt: now,
		messages: JSON.parse(safeStringify(msgs)),
		changes: [],
		permissionMode: src.permissionMode,
		sessionAllow: [],
		summary: src.summary,
		compactedCount: Math.min(src.compactedCount ?? 0, msgs.length),
		titleLocked: true,
	};
}
