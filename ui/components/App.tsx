/**
 * 侧边栏外壳：顶栏（对话标签页 / 工具按钮）→ 对话区 → 审批 & 提问卡片 → 输入区
 */
import type { Attachment, ChatMessage } from '../agent/types';
import { useEffect, useRef, useState } from 'preact/hooks';
import { changeStats } from '../agent/undo';
import { workspace } from '../agent/workspace';
import { getEda } from '../lib/eda';
import { ApprovalCard, ChatView, QuestionCard } from './Chat';
import { ConfirmHost, IconButton, notify, Toasts } from './common';
import { Composer } from './Composer';
import { useResolvedTheme, useSession, useWorkspace } from './hooks';
import { IconCpu, IconDiff, IconDockRight, IconFloatWin, IconHistory, IconLayers, IconMonitor, IconMoon, IconPanelClose, IconPlus, IconSettings, IconSparkle, IconSun, IconX, IconZap } from './icons';
import { ChangesPanel, HistoryPanel } from './Panels';
import { SettingsPanel } from './Settings';

const PANEL_ID = 'jlc-agent-sidebar';

/** 当前停靠方式（主线程广播 jlc-agent:dock-state） */
function useDockMode(fallback: 'panel' | 'float'): 'panel' | 'float' {
	const [mode, setMode] = useState<'panel' | 'float'>(fallback);
	useEffect(() => {
		const bus = getEda()?.sys_MessageBus;
		let task: any;
		try {
			task = bus?.subscribe?.('jlc-agent:dock-state', (m: any) => {
				if (m?.mode === 'panel' || m?.mode === 'float')
					setMode(m.mode);
			});
			bus?.publish?.('jlc-agent:dock', { mode: 'query' });
		}
		catch {}
		return () => {
			try {
				task?.cancel?.();
			}
			catch {}
		};
	}, []);
	return mode;
}

/** 切换停靠：主线程关闭当前窗口并按新方式重开，对话已持久化，重开后自动恢复 */
function requestDock(mode: 'panel' | 'float'): void {
	workspace.flush();
	try {
		getEda()?.sys_MessageBus?.publish?.('jlc-agent:dock', { mode });
	}
	catch {}
}

function collapseSidebar(): void {
	const eda = getEda();
	try {
		eda?.sys_MessageBus?.publish?.('jlc-agent:visibility', { visible: false });
	}
	catch {}
	try {
		void Promise.resolve(eda?.sys_IFrame?.hideIFrame?.(PANEL_ID)).then((ok) => {
			if (ok === false)
				void eda?.sys_IFrame?.closeIFrame?.(PANEL_ID);
		}).catch(() => void eda?.sys_IFrame?.closeIFrame?.(PANEL_ID));
	}
	catch {}
}

const SUGGESTIONS: Array<{ icon: preact.ComponentChildren; title: string; prompt: string }> = [
	{ icon: <IconLayers size={14} />, title: '检查当前原理图', prompt: '帮我检查当前原理图：运行 DRC，列出问题并指出位置。' },
	{ icon: <IconCpu size={14} />, title: '搭建 AMS1117 稳压电路', prompt: '在当前原理图中搭建一个 AMS1117-3.3 的 5V 转 3.3V 稳压电路，包含输入输出电容。' },
	{ icon: <IconZap size={14} />, title: '讲讲 RC 低通滤波器', prompt: '讲一下 RC 低通滤波器的原理和截止频率怎么计算，画个电路图。' },
	{ icon: <IconSparkle size={14} />, title: '解释选中的器件', prompt: '解释一下我当前选中的器件是做什么的，以及它在电路里的连接。' },
];

function EmptyState(props: { onPick: (p: string) => void; scene: string; ready: boolean }) {
	return (
		<div class="empty">
			<div class="empty-logo"><IconSparkle size={22} /></div>
			<div class="empty-title">EDA Agent</div>
			<div class="empty-sub">{props.ready ? `已连接嘉立创EDA · ${props.scene}` : '未检测到 EDA 环境，仅可问答'}</div>
			<div class="suggests">
				{SUGGESTIONS.map(s => (
					<button type="button" class="suggest" key={s.title} onClick={() => props.onPick(s.prompt)}>
						<span class="sg-icon">{s.icon}</span>
						<span class="sg-title">{s.title}</span>
					</button>
				))}
			</div>
		</div>
	);
}

function Tabs() {
	const ws = workspace;
	const strip = useRef<HTMLDivElement>(null);
	useEffect(() => {
		strip.current?.querySelector('.ctab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
	}, [ws.activeId]);
	return (
		<div class="ctabs" ref={strip} onWheel={(e) => {
			if (strip.current && Math.abs(e.deltaY) > Math.abs(e.deltaX))
				strip.current.scrollLeft += e.deltaY;
		}}>
			{ws.openIds.map((id) => {
				const s = ws.sessions.get(id);
				if (!s)
					return null;
				return (
					<div
						key={id}
						class={`ctab ${id === ws.activeId ? 'active' : ''} ${s.running ? 'running' : ''}`}
						onClick={() => ws.activate(id)}
						onAuxClick={e => e.button === 1 && ws.close(id)}
						title={s.conv.title}
					>
						{s.running ? <span class="ctab-dot live" /> : (s.approval || s.question) ? <span class="ctab-dot wait" /> : null}
						<span class="ctab-title">{s.conv.title}</span>
						<button type="button" class="ctab-x" aria-label="关闭对话" onClick={(e) => { e.stopPropagation(); ws.close(id); }}><IconX size={11} /></button>
					</div>
				);
			})}
		</div>
	);
}

export function App() {
	const ws = workspace;
	useWorkspace(ws);
	const s = ws.active;
	useSession(s);
	const theme = useResolvedTheme(ws.ready ? ws.settings.theme : 'system', ws.editor.theme);
	const [panel, setPanel] = useState<'' | 'history' | 'changes' | 'settings'>('');
	const [settingsTab, setSettingsTab] = useState<'model' | 'permission' | 'general'>('model');
	const [draft, setDraft] = useState<{ text: string; attachments: Attachment[]; seq: number }>({ text: '', attachments: [], seq: 0 });

	useEffect(() => {
		document.documentElement.dataset.theme = theme;
	}, [theme]);

	// 界面缩放：Ctrl + 滚轮 / Ctrl + = - 0
	const scale = ws.ready ? ws.settings.uiScale : 1;
	useEffect(() => {
		document.documentElement.style.setProperty('--ui-scale', String(scale));
		(document.documentElement.style as any).zoom = String(scale);
	}, [scale]);
	useEffect(() => {
		let hintTimer: ReturnType<typeof setTimeout> | undefined;
		const hint = () => {
			const el = document.getElementById('zoom-hint');
			if (!el)
				return;
			el.textContent = `${Math.round(ws.settings.uiScale * 100)}%`;
			el.classList.add('show');
			if (hintTimer)
				clearTimeout(hintTimer);
			hintTimer = setTimeout(() => el.classList.remove('show'), 900);
		};
		const onWheel = (e: WheelEvent) => {
			if (!(e.ctrlKey || e.metaKey) || !ws.ready)
				return;
			e.preventDefault();
			ws.setScale(ws.settings.uiScale + (e.deltaY < 0 ? 0.05 : -0.05));
			hint();
		};
		const onKey = (e: KeyboardEvent) => {
			if (!(e.ctrlKey || e.metaKey) || !ws.ready)
				return;
			if (e.key === '=' || e.key === '+') {
				e.preventDefault();
				ws.setScale(ws.settings.uiScale + 0.1);
				hint();
			}
			else if (e.key === '-') {
				e.preventDefault();
				ws.setScale(ws.settings.uiScale - 0.1);
				hint();
			}
			else if (e.key === '0') {
				e.preventDefault();
				ws.setScale(1);
				hint();
			}
		};
		window.addEventListener('wheel', onWheel, { passive: false });
		window.addEventListener('keydown', onKey);
		return () => {
			window.removeEventListener('wheel', onWheel);
			window.removeEventListener('keydown', onKey);
		};
	}, []);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n' && !e.shiftKey) {
				e.preventDefault();
				ws.newChat();
			}
			else if (e.key === 'Escape' && s?.running && !panel) {
				s.stop();
			}
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [s, panel]);

	if (!ws.ready || !s) {
		return (
			<div class="boot">
				<div class="boot-mark"><IconSparkle size={20} /></div>
				<div class="boot-bar"><span /></div>
			</div>
		);
	}

	const stats = changeStats(s.conv.changes);
	const pending = stats.create + stats.modify + stats.delete + stats.other;
	const cycleTheme = () => {
		const order = ['system', 'light', 'dark'] as const;
		ws.updateSettings({ theme: order[(order.indexOf(ws.settings.theme) + 1) % 3] });
	};
	const themeIcon = ws.settings.theme === 'system' ? <IconMonitor size={15} /> : ws.settings.theme === 'light' ? <IconSun size={15} /> : <IconMoon size={15} />;
	const dock = useDockMode(ws.settings.dockMode);
	const openSettings = (tab: typeof settingsTab = 'model') => {
		setSettingsTab(tab);
		setPanel('settings');
	};

	return (
		<div class="app">
			<header class="topbar">
				<Tabs />
				<div class="top-actions">
					<IconButton label="新对话（Ctrl+N）" onClick={() => ws.newChat()}><IconPlus size={15} /></IconButton>
					<IconButton label="历史对话" active={panel === 'history'} onClick={() => setPanel(panel === 'history' ? '' : 'history')}><IconHistory size={15} /></IconButton>
					<IconButton label="本对话的改动" active={panel === 'changes'} onClick={() => setPanel(panel === 'changes' ? '' : 'changes')} class="has-badge">
						<IconDiff size={15} />
						{pending > 0 && <span class="badge-dot">{pending > 99 ? '99+' : pending}</span>}
					</IconButton>
					<IconButton label={`主题：${ws.settings.theme === 'system' ? '跟随' : ws.settings.theme === 'light' ? '浅色' : '深色'}`} onClick={cycleTheme}>{themeIcon}</IconButton>
					<IconButton label="设置" active={panel === 'settings'} onClick={() => (panel === 'settings' ? setPanel('') : openSettings())}><IconSettings size={15} /></IconButton>
					<IconButton
						label={dock === 'panel' ? '改为自由浮动窗口' : '停靠 / 吸附到最右侧'}
						onClick={() => {
							if (ws.anyRunning()) {
								notify('Agent 正在运行，结束后再切换停靠方式', 'info');
								return;
							}
							ws.updateSettings({ dockMode: dock === 'panel' ? 'float' : 'panel' });
							requestDock(dock === 'panel' ? 'float' : 'panel');
						}}
					>
						{dock === 'panel' ? <IconFloatWin size={15} /> : <IconDockRight size={15} />}
					</IconButton>
					<IconButton label="收起侧边栏（Alt+A）" onClick={collapseSidebar}><IconPanelClose size={15} /></IconButton>
				</div>
			</header>

			<main class="main" key={s.conv.id}>
				<ChatView
					session={s}
					theme={theme}
					showReasoning={ws.settings.showReasoning}
					onEdit={(text, attachments) => setDraft(d => ({ text, attachments: attachments ?? [], seq: d.seq + 1 }))}
					onFork={id => ws.fork(id)}
					empty={<EmptyState ready={ws.editor.available} scene={ws.editor.sceneLabel} onPick={p => void s.send(p)} />}
				/>
			</main>

			<footer class="dock">
				{s.approval && <ApprovalCard approval={s.approval} key={s.approval.callId} />}
				{s.question && <QuestionCard question={s.question} key={s.question.callId} />}
				<Composer ws={ws} session={s} draft={draft} onOpenSettings={() => openSettings('model')} />
			</footer>

			<HistoryPanel open={panel === 'history'} onClose={() => setPanel('')} ws={ws} />
			<ChangesPanel open={panel === 'changes'} onClose={() => setPanel('')} session={s} />
			<SettingsPanel open={panel === 'settings'} onClose={() => setPanel('')} ws={ws} tab={settingsTab} />
			<ConfirmHost />
			<div id="zoom-hint" class="zoom-hint" />
			<Toasts />
		</div>
	);
}

/** 便于从其它组件回填输入框 */
export type DraftFn = (text: string, attachments?: ChatMessage['attachments']) => void;
