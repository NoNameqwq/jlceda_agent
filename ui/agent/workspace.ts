/**
 * 工作区：管理当前工程下的多个对话（标签页）、设置与编辑器上下文
 */
import type { AgentScope, ConversationMeta, EditorContext, Settings } from './types';
import { getEda } from '../lib/eda';
import { setEdaConfig } from '../lib/storage';
import { setTransport } from '../lib/http';
import { debounce } from '../lib/util';
import { EMPTY_CONTEXT, projectKeyOf, readEditorContext, readProjectOverview } from './context';
import { forkConversation, Session } from './engine';
import {
	deleteConversationData,
	loadConversation,
	loadIndex,
	loadOpenTabs,
	loadSettings,
	metaOf,
	newConversation,
	saveConversation,
	saveIndex,
	saveOpenTabs,
	saveSettings,
} from './store';

type Listener = () => void;

export class Workspace {
	settings!: Settings;
	editor: EditorContext = { ...EMPTY_CONTEXT };
	projectKey = 'global';
	index: ConversationMeta[] = [];
	openIds: string[] = [];
	activeId = '';
	sessions = new Map<string, Session>();
	ready = false;
	private listeners = new Set<Listener>();
	private pollTimer?: ReturnType<typeof setInterval>;
	private saveSettingsDebounced = debounce((s: Settings) => void saveSettings(s), 400);

	subscribe(fn: Listener): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	emit(): void {
		for (const l of this.listeners) l();
	}

	async init(): Promise<void> {
		this.settings = await loadSettings();
		setTransport(this.settings.transport);
		// 主线程菜单（工程 Agent / 独立 Agent）通过扩展配置 + 消息总线指定范围
		const pending = readEdaConfig<AgentScope | undefined>('pendingScope', undefined);
		if (pending === 'project' || pending === 'global')
			this.settings = { ...this.settings, scope: pending };
		setEdaConfig('dockMode', this.settings.dockMode);
		setEdaConfig('autoOpenOnProject', this.settings.autoOpenOnProject);
		this.editor = await readEditorContext();
		await this.switchProject(this.keyFor(this.editor));
		this.ready = true;
		this.emit();
		this.pollTimer = setInterval(() => void this.refreshEditor(), 2500);
		try {
			getEda()?.sys_MessageBus?.subscribe?.('jlc-agent:scope', (m: any) => {
				if (m?.scope === 'project' || m?.scope === 'global')
					void this.setScope(m.scope);
			});
		}
		catch {}
	}

	/** 对话集合的键：独立模式固定为 global，工程模式按工程区分 */
	keyFor(ctx: EditorContext): string {
		return this.settings.scope === 'global' ? 'global' : projectKeyOf(ctx);
	}

	async setScope(scope: AgentScope): Promise<void> {
		if (this.settings.scope !== scope) {
			this.settings = { ...this.settings, scope };
			this.saveSettingsDebounced(this.settings);
		}
		setEdaConfig('pendingScope', scope);
		const key = this.keyFor(this.editor);
		if (key !== this.projectKey && !this.anyRunning())
			await this.switchProject(key);
		this.emit();
	}

	dispose(): void {
		if (this.pollTimer)
			clearInterval(this.pollTimer);
	}

	/** 轮询编辑器状态；工程变化时切换对话集合 */
	async refreshEditor(): Promise<EditorContext> {
		const ctx = await readEditorContext();
		const prev = this.editor;
		this.editor = ctx;
		const key = this.keyFor(ctx);
		if (key !== this.projectKey && !this.anyRunning())
			await this.switchProject(key);
		if (prev.scene !== ctx.scene || prev.documentUuid !== ctx.documentUuid || prev.selectionCount !== ctx.selectionCount || prev.theme !== ctx.theme || prev.projectUuid !== ctx.projectUuid)
			this.emit();
		return ctx;
	}

	anyRunning(): boolean {
		for (const s of this.sessions.values()) {
			if (s.running)
				return true;
		}
		return false;
	}

	private async switchProject(key: string): Promise<void> {
		this.projectKey = key;
		this.sessions.clear();
		this.index = await loadIndex(key);
		const open = (await loadOpenTabs(key)).filter(id => this.index.some(m => m.id === id));
		for (const id of open) {
			const c = await loadConversation(id);
			if (c)
				this.attach(new Session(c, this.deps()));
		}
		this.openIds = open.filter(id => this.sessions.has(id));
		if (!this.openIds.length)
			this.create();
		else this.activeId = this.openIds[0];
		this.emit();
	}

	private deps() {
		return {
			getSettings: () => this.settings,
			getEditor: () => this.refreshEditor(),
			getOverview: (ctx: EditorContext) => readProjectOverview(ctx),
			persist: (c: any) => {
				void saveConversation(c);
				this.upsertMeta(metaOf(c));
			},
			onTitle: () => this.emit(),
		};
	}

	private attach(s: Session): void {
		this.sessions.set(s.conv.id, s);
	}

	private upsertMeta(m: ConversationMeta): void {
		const i = this.index.findIndex(x => x.id === m.id);
		if (i >= 0)
			this.index[i] = m;
		else this.index.unshift(m);
		this.index.sort((a, b) => b.updatedAt - a.updatedAt);
		void saveIndex(this.projectKey, this.index);
	}

	private saveTabs(): void {
		void saveOpenTabs(this.projectKey, this.openIds);
	}

	get active(): Session | undefined {
		return this.sessions.get(this.activeId);
	}

	create(): Session {
		const c = newConversation(this.projectKey, this.settings.defaultPermissionMode);
		const s = new Session(c, this.deps());
		this.attach(s);
		this.openIds = [...this.openIds, c.id];
		this.activeId = c.id;
		this.saveTabs();
		this.emit();
		return s;
	}

	/** 打开新对话；当前对话为空时直接复用 */
	newChat(): void {
		const a = this.active;
		if (a && !a.conv.messages.length) {
			this.emit();
			return;
		}
		this.create();
	}

	activate(id: string): void {
		if (!this.sessions.has(id))
			return;
		this.activeId = id;
		this.emit();
	}

	async open(id: string): Promise<void> {
		if (!this.sessions.has(id)) {
			const c = await loadConversation(id);
			if (!c)
				return;
			this.attach(new Session(c, this.deps()));
		}
		if (!this.openIds.includes(id))
			this.openIds = [...this.openIds, id];
		// 清理空白的当前标签
		const cur = this.active;
		if (cur && cur.conv.id !== id && !cur.conv.messages.length && !cur.running) {
			this.openIds = this.openIds.filter(x => x !== cur.conv.id);
			this.sessions.delete(cur.conv.id);
		}
		this.activeId = id;
		this.saveTabs();
		this.emit();
	}

	close(id: string): void {
		const s = this.sessions.get(id);
		if (s?.running)
			s.stop();
		const idx = this.openIds.indexOf(id);
		this.openIds = this.openIds.filter(x => x !== id);
		this.sessions.delete(id);
		if (s && !s.conv.messages.length) {
			this.index = this.index.filter(m => m.id !== id);
			void saveIndex(this.projectKey, this.index);
			void deleteConversationData(id);
		}
		if (!this.openIds.length) {
			this.create();
			return;
		}
		if (this.activeId === id)
			this.activeId = this.openIds[Math.max(0, idx - 1)];
		this.saveTabs();
		this.emit();
	}

	async remove(id: string): Promise<void> {
		if (this.openIds.includes(id))
			this.close(id);
		this.index = this.index.filter(m => m.id !== id);
		await saveIndex(this.projectKey, this.index);
		await deleteConversationData(id);
		this.emit();
	}

	rename(id: string, title: string): void {
		const t = title.trim();
		if (!t)
			return;
		const s = this.sessions.get(id);
		if (s) {
			s.conv.title = t;
			s.conv.titleLocked = true;
			void saveConversation(s.conv);
			this.upsertMeta(metaOf(s.conv));
		}
		else {
			void loadConversation(id).then((c) => {
				if (!c)
					return;
				c.title = t;
				c.titleLocked = true;
				void saveConversation(c);
				this.upsertMeta(metaOf(c));
				this.emit();
			});
		}
		this.emit();
	}

	fork(messageId: string): void {
		const src = this.active;
		if (!src)
			return;
		const c = forkConversation(src.conv, messageId, this.projectKey);
		const s = new Session(c, this.deps());
		this.attach(s);
		void saveConversation(c);
		this.upsertMeta(metaOf(c));
		this.openIds = [...this.openIds, c.id];
		this.activeId = c.id;
		this.saveTabs();
		this.emit();
	}

	updateSettings(patch: Partial<Settings>): void {
		this.settings = { ...this.settings, ...patch };
		if (patch.transport)
			setTransport(patch.transport);
		if (patch.dockMode)
			setEdaConfig('dockMode', patch.dockMode);
		if (patch.autoOpenOnProject !== undefined)
			setEdaConfig('autoOpenOnProject', patch.autoOpenOnProject);
		if (patch.scope) {
			setEdaConfig('pendingScope', patch.scope);
			const key = this.keyFor(this.editor);
			if (key !== this.projectKey && !this.anyRunning())
				void this.switchProject(key);
		}
		this.saveSettingsDebounced(this.settings);
		this.emit();
	}

	/** 界面缩放（0.7 – 1.6） */
	setScale(v: number): void {
		const s = Math.round(Math.min(1.6, Math.max(0.7, v)) * 100) / 100;
		if (s !== this.settings.uiScale)
			this.updateSettings({ uiScale: s });
	}

	flush(): void {
		this.saveSettingsDebounced.flush();
	}
}

function readEdaConfig<T>(key: string, fallback: T): T {
	try {
		const v = getEda()?.sys_Storage?.getExtensionUserConfig?.(key);
		return v === undefined || v === null ? fallback : v as T;
	}
	catch {
		return fallback;
	}
}

export const workspace = new Workspace();
