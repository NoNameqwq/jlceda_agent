/**
 * 设置：模型接口（DeepSeek 内置 / 自定义 OpenAI 兼容）、高级模型参数、权限、外观、通用
 */
import type { ModelInfo, ModelOverride, PermissionMode, ProviderConfig, Settings, ThemeMode, ToolRule } from '../agent/types';
import type { Workspace } from '../agent/workspace';
import { useMemo, useState } from 'preact/hooks';
import { MODE_DESC, MODE_LABEL, RISK_LABEL } from '../agent/permissions';
import { DEEPSEEK_BASE_URL, inferCapabilities, overrideKey, resolveModel, testConnection } from '../agent/providers';
import { getEda } from '../lib/eda';
import { storageBackend } from '../lib/storage';
import { errorMessage, formatTokens, uid } from '../lib/util';
import { allTools, GROUP_LABEL, toolRisk } from '../tools/registry';
import { confirmDialog, notify, Select, Spinner, Toggle } from './common';
import { hasOverride, ModelParams } from './ModelParams';
import { Drawer } from './Panels';
import { IconCheck, IconEye, IconFolder, IconGlobe, IconSliders, IconEyeOff, IconMonitor, IconMoon, IconPlug, IconPlus, IconRefresh, IconSettings, IconShield, IconSun, IconTrash, IconX } from './icons';

type Tab = 'model' | 'permission' | 'general';

function Field(props: { label: string; hint?: string; children: preact.ComponentChildren }) {
	return (
		<label class="field">
			<span class="field-label">{props.label}</span>
			{props.children}
			{props.hint && <span class="field-hint">{props.hint}</span>}
		</label>
	);
}

function NumInput(props: { value?: number; placeholder?: string; onChange: (v: number | undefined) => void; step?: number; min?: number; max?: number }) {
	return (
		<input
			type="number"
			class="input"
			value={props.value ?? ''}
			placeholder={props.placeholder}
			step={props.step}
			min={props.min}
			max={props.max}
			onChange={(e) => {
				const raw = (e.target as HTMLInputElement).value.trim();
				const n = Number(raw);
				props.onChange(raw === '' || Number.isNaN(n) ? undefined : n);
			}}
		/>
	);
}

// ———————————————————— 模型接口 ————————————————————

function ProviderEditor(props: { ws: Workspace; p: ProviderConfig }) {
	const { ws, p } = props;
	const [showKey, setShowKey] = useState(false);
	const [testing, setTesting] = useState(false);
	const [newModel, setNewModel] = useState('');
	const [filter, setFilter] = useState('');
	const [expanded, setExpanded] = useState<string>();
	const [headersText, setHeadersText] = useState(() => Object.entries(p.extraHeaders ?? {}).map(([k, v]) => `${k}: ${v}`).join('\n'));

	const patch = (x: Partial<ProviderConfig>) => {
		ws.updateSettings({ providers: ws.settings.providers.map(it => it.id === p.id ? { ...it, ...x } : it) });
	};

	const test = async () => {
		setTesting(true);
		try {
			const r = await testConnection(p, ws.settings.activeProviderId === p.id ? ws.settings.activeModel : undefined);
			const x: Partial<ProviderConfig> = { lastCheck: { ok: r.ok, message: r.message, at: Date.now() } };
			if (r.ok && r.models?.length) {
				// 合并：保留用户手动添加且接口未返回的模型
				const fetched = new Map(r.models.map(m => [m.id, m]));
				const manual = p.models.filter(m => !fetched.has(m.id));
				x.models = [...r.models, ...manual];
			}
			patch(x);
			notify(r.message, r.ok ? 'success' : 'error');
			if (r.ok && ws.settings.activeProviderId === p.id && x.models && !x.models.some(m => m.id === ws.settings.activeModel))
				ws.updateSettings({ activeModel: x.models[0].id });
		}
		catch (e) {
			const message = errorMessage(e);
			patch({ lastCheck: { ok: false, message, at: Date.now() } });
			notify(message, 'error');
		}
		finally {
			setTesting(false);
		}
	};

	const addModel = () => {
		const id = newModel.trim();
		if (!id || p.models.some(m => m.id === id))
			return;
		patch({ models: [...p.models, { id, ...inferCapabilities(id) }] });
		setNewModel('');
	};

	const removeModel = (id: string) => patch({ models: p.models.filter(m => m.id !== id) });

	const useModel = (id: string) => {
		ws.updateSettings({ activeProviderId: p.id, activeModel: id });
		notify(`已切换到 ${id}`);
	};

	const removeProvider = async () => {
		const r = await confirmDialog({ title: `删除接口「${p.name}」？`, ok: '删除', danger: true });
		if (!r.ok)
			return;
		const providers = ws.settings.providers.filter(x => x.id !== p.id);
		ws.updateSettings({
			providers,
			activeProviderId: ws.settings.activeProviderId === p.id ? providers[0].id : ws.settings.activeProviderId,
			activeModel: ws.settings.activeProviderId === p.id ? (providers[0].models[0]?.id ?? '') : ws.settings.activeModel,
		});
	};

	const models = p.models.filter(m => !filter || m.id.toLowerCase().includes(filter.toLowerCase()));
	const isDeepseek = p.kind === 'deepseek';

	return (
		<div class="provider-editor">
			{!isDeepseek && (
				<Field label="名称">
					<input class="input" value={p.name} onInput={e => patch({ name: (e.target as HTMLInputElement).value })} />
				</Field>
			)}
			<Field label="接口地址（Base URL）" hint={isDeepseek ? '内置 DeepSeek 官方地址，无需填写' : 'OpenAI 兼容地址，例如 https://api.openai.com/v1、https://dashscope.aliyuncs.com/compatible-mode/v1、http://localhost:11434/v1'}>
				<input
					class="input mono"
					value={isDeepseek ? DEEPSEEK_BASE_URL : p.baseUrl}
					disabled={isDeepseek}
					placeholder="https://…/v1"
					onInput={e => patch({ baseUrl: (e.target as HTMLInputElement).value })}
				/>
			</Field>
			<Field label="API Key" hint={isDeepseek ? '在 platform.deepseek.com 创建' : '本地模型可留空'}>
				<div class="input-group">
					<input
						class="input mono"
						type={showKey ? 'text' : 'password'}
						value={p.apiKey}
						placeholder="sk-…"
						autoComplete="off"
						onInput={e => patch({ apiKey: (e.target as HTMLInputElement).value })}
					/>
					<button type="button" class="icon-btn" title={showKey ? '隐藏' : '显示'} onClick={() => setShowKey(!showKey)}>
						{showKey ? <IconEyeOff size={15} /> : <IconEye size={15} />}
					</button>
				</div>
			</Field>
			{!isDeepseek && (
				<Field label="附加请求头（可选）" hint="每行一个，格式 Header: value">
					<textarea
						class="input mono"
						rows={2}
						value={headersText}
						onInput={e => setHeadersText((e.target as HTMLTextAreaElement).value)}
						onBlur={() => {
							const h: Record<string, string> = {};
							for (const line of headersText.split('\n')) {
								const i = line.indexOf(':');
								if (i > 0)
									h[line.slice(0, i).trim()] = line.slice(i + 1).trim();
							}
							patch({ extraHeaders: h });
						}}
					/>
				</Field>
			)}

			<div class="test-row">
				<button type="button" class="btn primary" disabled={testing} onClick={() => void test()}>
					{testing ? <Spinner size={13} /> : <IconPlug size={14} />}
					检测连接并获取模型
				</button>
				{p.lastCheck && (
					<span class={`check-msg ${p.lastCheck.ok ? 'ok' : 'err'}`}>
						{p.lastCheck.ok ? <IconCheck size={13} /> : <IconX size={13} />}
						{p.lastCheck.message}
					</span>
				)}
			</div>

			<div class="model-list-head">
				<span>
					模型（
					{p.models.length}
					）
				</span>
				{p.models.length > 8 && <input class="input sm" placeholder="筛选" value={filter} onInput={e => setFilter((e.target as HTMLInputElement).value)} />}
			</div>
			<div class="model-list">
				{models.map((m: ModelInfo) => {
					const active = ws.settings.activeProviderId === p.id && ws.settings.activeModel === m.id;
					return (
						<div key={m.id} class={`model-item ${expanded === m.id ? 'open' : ''}`}>
							<div class={`model-row ${active ? 'active' : ''}`} onClick={() => useModel(m.id)}>
								<span class={`mini-radio ${active ? 'on' : ''}`} />
								<span class="model-id">{m.id}</span>
								<span class="model-caps">
									{m.vision && <span class="cap" title="支持识图"><IconEye size={11} /></span>}
									{m.reasoning && <span class="cap" title="支持思考">思考</span>}
									{m.contextWindow && <span class="cap">{formatTokens(m.contextWindow)}</span>}
									{hasOverride(ws, p, m) && <span class="cap tuned" title="已自定义参数">已调</span>}
								</span>
								<button type="button" class={`icon-btn sm ${expanded === m.id ? 'active' : ''}`} title="模型参数" onClick={(e) => {
									e.stopPropagation();
									setExpanded(expanded === m.id ? undefined : m.id);
								}}
								>
									<IconSliders size={13} />
								</button>
								<button type="button" class="icon-btn sm" title="移除" onClick={(e) => {
									e.stopPropagation();
									removeModel(m.id);
								}}
								>
									<IconX size={12} />
								</button>
							</div>
							<div class="collapse"><div class="collapse-inner">{expanded === m.id && <ModelParams ws={ws} p={p} m={m} />}</div></div>
						</div>
					);
				})}
				{!p.models.length && <div class="empty-hint sm">尚无模型，请检测连接自动获取，或在下方手动添加。</div>}
			</div>
			<div class="input-group">
				<input class="input mono" placeholder="手动添加模型 ID" value={newModel} onInput={e => setNewModel((e.target as HTMLInputElement).value)} onKeyDown={e => e.key === 'Enter' && addModel()} />
				<button type="button" class="btn" onClick={addModel}><IconPlus size={14} />添加</button>
			</div>
			{!p.builtin && (
				<button type="button" class="btn ghost danger full" onClick={() => void removeProvider()}>
					<IconTrash size={14} />
					删除此接口
				</button>
			)}
		</div>
	);
}

function ModelTab(props: { ws: Workspace }) {
	const { ws } = props;
	const [sel, setSel] = useState(ws.settings.activeProviderId);
	const p = ws.settings.providers.find(x => x.id === sel) ?? ws.settings.providers[0];
	const add = () => {
		const np: ProviderConfig = { id: uid('p_'), kind: 'openai', name: '自定义接口', baseUrl: '', apiKey: '', models: [] };
		ws.updateSettings({ providers: [...ws.settings.providers, np] });
		setSel(np.id);
	};
	return (
		<div class="tab-body">
			<div class="provider-tabs">
				{ws.settings.providers.map(x => (
					<button key={x.id} type="button" class={`ptab ${x.id === p.id ? 'on' : ''}`} onClick={() => setSel(x.id)}>
						<span class={`pdot ${x.lastCheck ? (x.lastCheck.ok ? 'ok' : 'err') : ''}`} />
						{x.name}
						{x.id === ws.settings.activeProviderId && <span class="ptag">使用中</span>}
					</button>
				))}
				<button type="button" class="ptab add" onClick={add}><IconPlus size={13} />自定义</button>
			</div>
			<ProviderEditor key={p.id} ws={ws} p={p} />
		</div>
	);
}

// ———————————————————— 权限 ————————————————————

function PermissionTab(props: { ws: Workspace }) {
	const { ws } = props;
	const [q, setQ] = useState('');
	const tools = useMemo(() => allTools(), []);
	const groups = useMemo(() => {
		const m = new Map<string, typeof tools>();
		for (const t of tools.filter(t => !q || t.name.includes(q) || t.title.includes(q)))
			m.set(t.group, [...(m.get(t.group) ?? []), t]);
		return [...m.entries()];
	}, [tools, q]);
	const setRule = (name: string, rule: ToolRule | 'default') => {
		const rules = { ...ws.settings.toolRules };
		if (rule === 'default')
			delete rules[name];
		else rules[name] = rule;
		ws.updateSettings({ toolRules: rules });
	};
	const s = ws.active;
	return (
		<div class="tab-body">
			<Field label="新对话默认权限模式">
				<Select
					value={ws.settings.defaultPermissionMode}
					onChange={(v: PermissionMode) => ws.updateSettings({ defaultPermissionMode: v })}
					options={(['readonly', 'ask', 'auto-edit', 'full'] as PermissionMode[]).map(m => ({ value: m, label: MODE_LABEL[m], desc: MODE_DESC[m] }))}
				/>
			</Field>
			{s && s.conv.sessionAllow.length > 0 && (
				<div class="session-allow">
					<span>本对话已始终允许：</span>
					{s.conv.sessionAllow.map(n => <span key={n} class="tag">{n}</span>)}
					<button type="button" class="link-btn" onClick={() => {
						s.conv.sessionAllow = [];
						s.setMode(s.conv.permissionMode);
					}}
					>
						清除
					</button>
				</div>
			)}
			<table class="perm-matrix">
				<thead><tr><th /><th>只读</th><th>编辑</th><th>高风险</th></tr></thead>
				<tbody>
					{(['readonly', 'ask', 'auto-edit', 'full'] as PermissionMode[]).map((m) => {
						const row: Record<string, string> = {
							'readonly': '✓ ✕ ✕',
							'ask': '✓ ? ?',
							'auto-edit': '✓ ✓ ?',
							'full': '✓ ✓ ✓',
						};
						return (
							<tr key={m}>
								<td>{MODE_LABEL[m]}</td>
								{row[m].split(' ').map((c, i) => <td key={i} class={c === '✓' ? 'ok' : c === '✕' ? 'no' : 'ask'}>{c === '?' ? '确认' : c === '✓' ? '允许' : '拒绝'}</td>)}
							</tr>
						);
					})}
				</tbody>
			</table>
			<div class="model-list-head">
				<span>工具级规则（优先于模式）</span>
				<input class="input sm" placeholder="搜索工具" value={q} onInput={e => setQ((e.target as HTMLInputElement).value)} />
			</div>
			{groups.map(([g, list]) => (
				<div key={g} class="tool-group">
					<div class="tool-group-label">{GROUP_LABEL[g as keyof typeof GROUP_LABEL] ?? g}</div>
					{list.map((t) => {
						const risk = typeof t.risk === 'function' ? '动态' : RISK_LABEL[toolRisk(t, {})];
						const rule = ws.settings.toolRules[t.name] ?? 'default';
						return (
							<div key={t.name} class="tool-rule">
								<span class="tr-name">
									<span>{t.title}</span>
									<span class="mono muted">{t.name}</span>
								</span>
								<span class={`risk risk-${typeof t.risk === 'function' ? 'dyn' : toolRisk(t, {})}`}>{risk}</span>
								<span class="seg sm">
									{(['default', 'allow', 'ask', 'deny'] as const).map(v => (
										<button key={v} type="button" class={rule === v ? 'on' : ''} onClick={() => setRule(t.name, v)}>
											{v === 'default' ? '默认' : v === 'allow' ? '允许' : v === 'ask' ? '询问' : '禁用'}
										</button>
									))}
								</span>
							</div>
						);
					})}
				</div>
			))}
		</div>
	);
}

// ———————————————————— 通用 ————————————————————

function GeneralTab(props: { ws: Workspace }) {
	const { ws } = props;
	const st = ws.settings;
	const exportSettings = () => {
		const safe: Settings = { ...st, providers: st.providers.map(p => ({ ...p, apiKey: '' })) };
		const blob = new Blob([JSON.stringify(safe, null, 2)], { type: 'application/json' });
		const a = document.createElement('a');
		a.href = URL.createObjectURL(blob);
		a.download = 'eda-agent-settings.json';
		a.click();
		setTimeout(() => URL.revokeObjectURL(a.href), 2000);
	};
	return (
		<div class="tab-body">
			<Field label="Agent 范围" hint="工程 Agent：对话按工程归档，可跨图页/PCB 工作；独立 Agent：一套全局对话，不随工程切换">
				<div class="seg">
					<button type="button" class={st.scope === 'project' ? 'on' : ''} onClick={() => ws.updateSettings({ scope: 'project' })}><IconFolder size={13} />工程 Agent</button>
					<button type="button" class={st.scope === 'global' ? 'on' : ''} onClick={() => ws.updateSettings({ scope: 'global' })}><IconGlobe size={13} />独立 Agent</button>
				</div>
			</Field>
			<Toggle label="打开工程时自动唤出工程 Agent" desc="检测到新打开的工程时，自动打开侧边栏并切到该工程的对话" checked={st.autoOpenOnProject} onChange={v => ws.updateSettings({ autoOpenOnProject: v })} />
			<Field label="界面缩放" hint="也可在面板内按住 Ctrl 滚动鼠标滚轮调整；Ctrl+0 复位">
				<div class="zoom-row">
					<button type="button" class="btn sm" onClick={() => ws.setScale(st.uiScale - 0.1)}>−</button>
					<span class="zoom-val">{Math.round(st.uiScale * 100)}%</span>
					<button type="button" class="btn sm" onClick={() => ws.setScale(st.uiScale + 0.1)}>+</button>
					<button type="button" class="btn sm ghost" onClick={() => ws.setScale(1)}>复位</button>
				</div>
			</Field>
			<Field label="主题">
				<div class="seg">
					{([['system', '跟随 EDA', IconMonitor], ['light', '浅色', IconSun], ['dark', '深色', IconMoon]] as Array<[ThemeMode, string, any]>).map(([v, l, Ic]) => (
						<button key={v} type="button" class={st.theme === v ? 'on' : ''} onClick={() => ws.updateSettings({ theme: v })}>
							<Ic size={13} />
							{l}
						</button>
					))}
				</div>
			</Field>
			<Field label="停靠方式" hint="最右侧：EDA 支持停靠接口时作为标签页与「属性 / 过滤」并列；不支持的版本（如 4.1.60）改为吸附在窗口最右侧、占满高度。浮动窗口：可自由拖动。">
				<div class="seg">
					<button type="button" class={st.dockMode === 'panel' ? 'on' : ''} onClick={() => switchDock(ws, 'panel')}>停靠 / 吸附右侧</button>
					<button type="button" class={st.dockMode === 'float' ? 'on' : ''} onClick={() => switchDock(ws, 'float')}>浮动窗口</button>
				</div>
			</Field>
			<Field label="发送快捷键">
				<div class="seg">
					<button type="button" class={st.sendKey === 'enter' ? 'on' : ''} onClick={() => ws.updateSettings({ sendKey: 'enter' })}>Enter 发送</button>
					<button type="button" class={st.sendKey === 'ctrlEnter' ? 'on' : ''} onClick={() => ws.updateSettings({ sendKey: 'ctrlEnter' })}>Ctrl+Enter 发送</button>
				</div>
			</Field>
			<Field label="单轮最多工具调用次数">
				<NumInput value={st.maxToolRounds} min={1} max={200} onChange={v => ws.updateSettings({ maxToolRounds: v ?? 40 })} />
			</Field>
			<Toggle label="流式输出" desc="边生成边显示；个别接口不支持时会自动回退" checked={st.streaming} onChange={v => ws.updateSettings({ streaming: v })} />
			<Toggle label="自动获取编辑器上下文" desc="发送时自动附带当前工程、文档与选中图元信息" checked={st.autoContext} onChange={v => ws.updateSettings({ autoContext: v })} />
			<Field label="网络通道" hint="EDA 通道需在扩展管理器勾选「允许外部交互」；浏览器通道需接口支持 CORS">
				<Select
					value={st.transport}
					onChange={v => ws.updateSettings({ transport: v })}
					options={[
						{ value: 'auto', label: '自动', desc: '优先 EDA 外部请求，失败回退 fetch' },
						{ value: 'eda', label: 'EDA 外部请求', desc: 'eda.sys_ClientUrl.request' },
						{ value: 'fetch', label: '浏览器 fetch', desc: '适合本地模型 / 支持 CORS 的接口' },
					]}
				/>
			</Field>
			<Toggle label="显示思考过程" desc="推理模型的思考内容以折叠块显示" checked={st.showReasoning} onChange={v => ws.updateSettings({ showReasoning: v })} />
			<Field label="自定义指令" hint="附加到系统提示词末尾，例如：器件优先 0603 封装；网络命名使用大写">
				<textarea class="input" rows={4} value={st.customInstructions} onInput={e => ws.updateSettings({ customInstructions: (e.target as HTMLTextAreaElement).value })} />
			</Field>
			<div class="divider" />
			<div class="about-row">
				<span>
					存储：
					{storageBackend() === 'idb' ? 'IndexedDB' : storageBackend() === 'eda' ? 'EDA 扩展存储' : storageBackend() === 'local' ? 'localStorage' : '内存（不持久化）'}
				</span>
				<span>
					版本 v
					{__APP_VERSION__}
				</span>
			</div>
			<div class="btn-row">
				<button type="button" class="btn ghost" onClick={exportSettings}>导出设置（不含 Key）</button>
				<button type="button" class="btn ghost danger" onClick={async () => {
					const r = await confirmDialog({ title: '恢复默认设置？', body: '将清除所有接口配置与 API Key，对话记录不受影响。', ok: '恢复默认', danger: true });
					if (r.ok) {
						const { defaultSettings } = await import('../agent/store');
						ws.updateSettings(defaultSettings());
						notify('已恢复默认设置');
					}
				}}
				>
					<IconRefresh size={13} />
					恢复默认
				</button>
			</div>
		</div>
	);
}

/** 切换停靠方式并立即生效（运行中不重开，下次打开时生效） */
function switchDock(ws: Workspace, mode: 'panel' | 'float'): void {
	ws.updateSettings({ dockMode: mode });
	if (ws.anyRunning())
		return;
	ws.flush();
	try {
		getEda()?.sys_MessageBus?.publish?.('jlc-agent:dock', { mode });
	}
	catch {}
}

export function SettingsPanel(props: { open: boolean; onClose: () => void; ws: Workspace; tab?: Tab }) {
	const [tab, setTab] = useState<Tab>(props.tab && props.tab !== ('advanced' as string) ? props.tab : 'model');
	const tabs: Array<[Tab, string, any]> = [['model', '模型接口', IconPlug], ['permission', '权限', IconShield], ['general', '通用', IconSettings]];
	return (
		<Drawer open={props.open} onClose={props.onClose} title="设置" icon={<IconSettings size={15} />}>
			<nav class="tabs">
				{tabs.map(([k, l, Ic]) => (
					<button key={k} type="button" class={`tab ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>
						<Ic size={13} />
						{l}
					</button>
				))}
				<span class="tab-ink" style={{ transform: `translateX(${tabs.findIndex(t => t[0] === tab) * 100}%)`, width: `${100 / tabs.length}%` }} />
			</nav>
			<div class="tab-stage" key={tab}>
				{tab === 'model' && <ModelTab ws={props.ws} />}
				{tab === 'permission' && <PermissionTab ws={props.ws} />}
				{tab === 'general' && <GeneralTab ws={props.ws} />}
			</div>
		</Drawer>
	);
}
