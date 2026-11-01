/**
 * 输入区：多行输入、图片/文件附件（粘贴 / 拖放 / 选择 / 画布截图）、模型 + 思考强度、权限模式、上下文用量详情
 */
import type { Session } from '../agent/engine';
import type { Workspace } from '../agent/workspace';
import type { Attachment, ContextBreakdown, PermissionMode, ThinkingLevel } from '../agent/types';
import { useEffect, useRef, useState } from 'preact/hooks';
import { MODE_DESC, MODE_LABEL } from '../agent/permissions';
import { findProvider, overrideKey, resolveModel, THINKING_LABEL, thinkingLevels } from '../agent/providers';
import { getEda, hasEda } from '../lib/eda';
import { blobToDataUrl, blobToText, downscaleImage, errorMessage, formatBytes, formatTokens, uid } from '../lib/util';
import { notify, Popover, Select } from './common';
import { IconBrain, IconCamera, IconCheck, IconChevronDown, IconFile, IconLock, IconPaperclip, IconSend, IconShield, IconShieldCheck, IconStop, IconX, IconZap } from './icons';

const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|xml|html?|svg|ya?ml|ini|cfg|conf|log|c|h|cpp|hpp|cc|ino|py|js|ts|tsx|jsx|v|sv|vhd|vhdl|asm|s|cir|sp|spice|net|lib|mod|ld|mk|bat|sh|ps1|toml|tel|asc|kicad_\w+|ses|dsn|ipc|gbr|drl|gtl|gbl|gto|gbo|gts|gbs|gko)$/i;
const MAX_TEXT = 60_000;

export async function fileToAttachment(f: File): Promise<Attachment> {
	const base = { id: uid('a_'), name: f.name || '未命名', mime: f.type, size: f.size };
	if (/^image\//.test(f.type)) {
		const raw = await blobToDataUrl(f);
		return { ...base, kind: 'image', dataUrl: await downscaleImage(raw, 1600) };
	}
	if (/^text\/|json|xml|javascript|csv/.test(f.type) || TEXT_EXT.test(f.name)) {
		const text = await blobToText(f);
		return { ...base, kind: 'file', text: text.slice(0, MAX_TEXT), truncated: text.length > MAX_TEXT };
	}
	return { ...base, kind: 'file' };
}

const MODE_ICON: Record<PermissionMode, preact.JSX.Element> = {
	'readonly': <IconLock size={13} />,
	'ask': <IconShield size={13} />,
	'auto-edit': <IconShieldCheck size={13} />,
	'full': <IconZap size={13} />,
};

/** 设置某个模型的思考强度（写入该模型的单独设置） */
function setThinking(ws: Workspace, providerId: string, model: string, t: ThinkingLevel): void {
	const key = overrideKey(providerId, model);
	const ov = { ...(ws.settings.overrides[key] ?? {}), thinking: t };
	ws.updateSettings({ overrides: { ...ws.settings.overrides, [key]: ov } });
}

function ModelPicker(props: { ws: Workspace; onOpenSettings: () => void }) {
	const ws = props.ws;
	const [open, setOpen] = useState(false);
	const [q, setQ] = useState('');
	const st = ws.settings;
	const resolved = resolveModel(st);
	const providers = st.providers.filter(p => p.models.length);
	const ql = q.trim().toLowerCase();
	const levels = resolved ? thinkingLevels(resolved.provider.kind) : [];
	const showThinking = !!resolved && (resolved.provider.kind === 'deepseek' || resolved.thinking !== 'default' || (resolved.provider.models.find(m => m.id === resolved.model)?.reasoning ?? false));
	return (
		<Popover
			open={open}
			onClose={() => setOpen(false)}
			placement="top-start"
			class="model-pop"
			anchor={(
				<button type="button" class={`chip ${open ? 'on' : ''}`} onClick={() => setOpen(!open)} title="模型与思考强度">
					<span class="chip-label">{resolved?.model ?? '选择模型'}</span>
					{showThinking && resolved && (
						<span class={`chip-sub ${resolved.thinking === 'off' ? 'dim' : ''}`}>
							<IconBrain size={11} />
							{THINKING_LABEL[resolved.thinking]}
						</span>
					)}
					<IconChevronDown size={12} class="chev" />
				</button>
			)}
		>
			{resolved && (
				<div class="pop-section">
					<div class="pop-section-title">
						<IconBrain size={12} />
						思考强度
						<span class="muted">· {resolved.model}</span>
					</div>
					<div class="seg sm full">
						{levels.map(l => (
							<button key={l} type="button" class={resolved.thinking === l ? 'on' : ''} onClick={() => setThinking(ws, resolved.provider.id, resolved.model, l)}>
								{THINKING_LABEL[l]}
							</button>
						))}
					</div>
				</div>
			)}
			<input class="pop-search" placeholder="搜索模型…" value={q} onInput={e => setQ((e.target as HTMLInputElement).value)} />
			<div class="pop-scroll">
				{providers.map((p) => {
					const models = p.models.filter(m => !ql || m.id.toLowerCase().includes(ql));
					if (!models.length)
						return null;
					return (
						<div key={p.id} class="pop-group">
							<div class="pop-group-title">
								{p.name}
								{!p.apiKey && p.kind === 'deepseek' && <span class="warn-inline"> · 未填写 Key</span>}
							</div>
							{models.map((m) => {
								const sel = st.activeProviderId === p.id && st.activeModel === m.id;
								return (
									<button
										type="button"
										key={m.id}
										class={`menu-item ${sel ? 'selected' : ''}`}
										onClick={() => {
											ws.updateSettings({ activeProviderId: p.id, activeModel: m.id });
											setOpen(false);
										}}
									>
										<span class="mi-text">
											<span class="mi-label">{m.id}</span>
											<span class="mi-desc">
												{formatTokens(m.contextWindow ?? 0)}
												{' 上下文'}
												{m.vision ? ' · 识图' : ''}
												{m.reasoning ? ' · 思考' : ''}
											</span>
										</span>
										{sel && <IconCheck size={14} class="mi-check" />}
									</button>
								);
							})}
						</div>
					);
				})}
				{!providers.length && <div class="pop-empty">还没有可用模型</div>}
			</div>
			<button
				type="button"
				class="menu-item foot"
				onClick={() => {
					setOpen(false);
					props.onOpenSettings();
				}}
			>
				管理模型接口与单独参数…
			</button>
		</Popover>
	);
}

const SEG_COLOR: Record<string, string> = {
	system: 'var(--c1)',
	tools: 'var(--c2)',
	summary: 'var(--c3)',
	user: 'var(--c4)',
	assistant: 'var(--c5)',
	reasoning: 'var(--c6)',
	toolResults: 'var(--c7)',
	images: 'var(--c8)',
};

function ContextDetail(props: { b: ContextBreakdown; session: Session; onClose: () => void }) {
	const { b, session: s } = props;
	const pct = (n: number) => (b.window ? (n / b.window) * 100 : 0);
	const usedPct = pct(b.total);
	return (
		<div class="ctx-detail">
			<div class="ctx-head">
				<span class="ctx-title">上下文</span>
				<span class="ctx-num">
					{formatTokens(b.total)}
					{' / '}
					{formatTokens(b.window)}
				</span>
				<span class="muted">
					{usedPct < 1 && b.total > 0 ? '<1' : Math.round(usedPct)}
					%
				</span>
			</div>
			<div class="ctx-bar">
				{b.segments.map(sg => <span key={sg.key} style={{ width: `${Math.max(0.6, pct(sg.tokens))}%`, background: SEG_COLOR[sg.key] ?? 'var(--fg-3)' }} title={`${sg.label} ${formatTokens(sg.tokens)}`} />)}
				<i class="ctx-threshold" style={{ left: `${Math.min(100, pct(b.threshold))}%` }} title="自动压缩阈值" />
			</div>
			<div class="ctx-rows">
				{b.segments.map(sg => (
					<div key={sg.key} class="ctx-row">
						<span class="ctx-dot" style={{ background: SEG_COLOR[sg.key] ?? 'var(--fg-3)' }} />
						<span class="ctx-label">
							{sg.label}
							{sg.note && <span class="muted">{` · ${sg.note}`}</span>}
						</span>
						<span class="ctx-val">{formatTokens(sg.tokens)}</span>
						<span class="ctx-pct">{b.total ? `${Math.round((sg.tokens / b.total) * 100)}%` : '–'}</span>
					</div>
				))}
				{!b.segments.length && <div class="muted">暂无内容</div>}
			</div>
			<div class="ctx-foot">
				<div>
					<span class="muted">模型</span>
					{b.model}
				</div>
				<div>
					<span class="muted">输出预留</span>
					{formatTokens(b.reservedOutput)}
				</div>
				<div>
					<span class="muted">自动压缩阈值</span>
					≈
					{formatTokens(b.threshold)}
				</div>
				{b.lastUsage && (
					<div>
						<span class="muted">上次实际用量</span>
						{`输入 ${formatTokens(b.lastUsage.prompt)} · 输出 ${formatTokens(b.lastUsage.completion)}`}
					</div>
				)}
				{b.compacted > 0 && (
					<div>
						<span class="muted">已压缩</span>
						{`${b.compacted} 条早前消息`}
					</div>
				)}
			</div>
			<p class="ctx-note">以上为本地估算（中文约 0.7 token/字），实际以接口返回为准。超过阈值时会先精简旧工具结果，仍不足则自动压缩为摘要。</p>
			<button
				type="button"
				class="btn sm full"
				disabled={s.running || s.conv.messages.length < 4}
				onClick={() => {
					props.onClose();
					void s.compactNow();
				}}
			>
				立即压缩早前对话
			</button>
		</div>
	);
}

function ContextMeter(props: { session: Session; ws: Workspace }) {
	const s = props.session;
	const [open, setOpen] = useState(false);
	const r = resolveModel(props.ws.settings);
	const win = r?.contextWindow || s.contextWindow || 0;
	const used = s.contextTokens || s.conv.lastPromptTokens || 0;
	if (!win)
		return null;
	const pct = Math.min(1, used / win);
	const R = 6.5;
	const C = 2 * Math.PI * R;
	const b = open ? (s.breakdown && !s.running ? s.previewBreakdown(props.ws.editor) ?? s.breakdown : s.breakdown ?? s.previewBreakdown(props.ws.editor)) : undefined;
	const label = pct > 0 && pct < 0.01 ? '<1%' : `${Math.round(pct * 100)}%`;
	return (
		<Popover
			open={open}
			onClose={() => setOpen(false)}
			placement="top-end"
			class="ctx-pop"
			anchor={(
				<button
					type="button"
					class={`ctx-meter ${pct > 0.8 ? 'bad' : pct > 0.6 ? 'warn' : ''} ${open ? 'on' : ''}`}
					title={`上下文 ${formatTokens(used)} / ${formatTokens(win)}，点击查看详情`}
					onClick={() => setOpen(!open)}
				>
					<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
						<circle cx="8" cy="8" r={R} class="ring-bg" />
						<circle cx="8" cy="8" r={R} class="ring-fg" stroke-dasharray={`${Math.max(pct > 0 ? 1.2 : 0, C * pct)} ${C}`} transform="rotate(-90 8 8)" />
					</svg>
					<span>{label}</span>
				</button>
			)}
		>
			{b ? <ContextDetail b={b} session={s} onClose={() => setOpen(false)} /> : <div class="pop-empty">未配置模型</div>}
		</Popover>
	);
}

export function Composer(props: {
	ws: Workspace;
	session: Session;
	draft: { text: string; attachments: Attachment[]; seq: number };
	onOpenSettings: () => void;
}) {
	const { ws, session: s } = props;
	const [text, setText] = useState('');
	const [atts, setAtts] = useState<Attachment[]>([]);
	const [drag, setDrag] = useState(false);
	const [busy, setBusy] = useState(false);
	const ta = useRef<HTMLTextAreaElement>(null);
	const fileInput = useRef<HTMLInputElement>(null);
	const resolved = resolveModel(ws.settings);
	const vision = !!resolved?.vision;

	useEffect(() => {
		if (props.draft.seq) {
			setText(props.draft.text);
			setAtts(props.draft.attachments);
			requestAnimationFrame(() => {
				ta.current?.focus();
				autosize();
			});
		}
	}, [props.draft.seq]);

	useEffect(() => {
		ta.current?.focus();
	}, [s.conv.id]);

	const autosize = () => {
		const el = ta.current;
		if (!el)
			return;
		el.style.height = 'auto';
		el.style.height = `${Math.min(220, el.scrollHeight)}px`;
	};
	useEffect(autosize, [text]);

	const addFiles = async (files: File[]) => {
		if (!files.length)
			return;
		setBusy(true);
		try {
			const list: Attachment[] = [];
			for (const f of files.slice(0, 10)) {
				if (f.size > 20 * 1024 * 1024) {
					notify(`${f.name} 超过 20MB，已跳过`, 'error');
					continue;
				}
				list.push(await fileToAttachment(f));
			}
			setAtts(a => [...a, ...list].slice(0, 12));
			if (list.some(a => a.kind === 'image') && !vision)
				notify('当前模型不支持识图，图片不会发送给模型。可在设置中切换或强制开启识图。');
		}
		catch (e) {
			notify(`读取附件失败：${errorMessage(e)}`, 'error');
		}
		finally {
			setBusy(false);
		}
	};

	const pickFiles = async () => {
		const sysFs = getEda()?.sys_FileSystem;
		if (sysFs?.openReadFileDialog) {
			try {
				const r = await sysFs.openReadFileDialog(undefined, true);
				const files = Array.isArray(r) ? r : r ? [r] : [];
				if (files.length) {
					await addFiles(files);
					return;
				}
				if (r !== undefined)
					return;
			}
			catch {}
		}
		fileInput.current?.click();
	};

	const capture = async () => {
		if (!hasEda()) {
			notify('未连接 EDA', 'error');
			return;
		}
		setBusy(true);
		try {
			const blob: Blob | undefined = await getEda().dmt_EditorControl.getCurrentRenderedAreaImage();
			if (!blob)
				throw new Error('当前画布无法截图');
			const f = new File([blob], `画布截图_${new Date().toTimeString().slice(0, 8).replace(/:/g, '')}.png`, { type: blob.type || 'image/png' });
			await addFiles([f]);
		}
		catch (e) {
			notify(`截图失败：${errorMessage(e)}`, 'error');
		}
		finally {
			setBusy(false);
		}
	};

	const send = () => {
		if (s.running || busy)
			return;
		if (!text.trim() && !atts.length)
			return;
		const t = text;
		const a = atts;
		setText('');
		setAtts([]);
		void s.send(t, a);
	};

	const onKey = (e: KeyboardEvent) => {
		if (e.isComposing || e.keyCode === 229)
			return;
		if (e.key === 'Enter') {
			const ctrl = e.ctrlKey || e.metaKey;
			if (ws.settings.sendKey === 'enter' ? !e.shiftKey && !ctrl : ctrl) {
				e.preventDefault();
				send();
			}
		}
		else if (e.key === 'Escape' && s.running) {
			s.stop();
		}
	};

	const onPaste = (e: ClipboardEvent) => {
		const files = [...(e.clipboardData?.files ?? [])];
		if (files.length) {
			e.preventDefault();
			void addFiles(files);
		}
	};

	const provider = findProvider(ws.settings);
	const needKey = provider && !provider.apiKey.trim() && provider.kind === 'deepseek';

	return (
		<div
			class={`composer ${drag ? 'drag' : ''} ${s.running ? 'running' : ''}`}
			onDragOver={(e) => {
				if (e.dataTransfer?.types.includes('Files')) {
					e.preventDefault();
					setDrag(true);
				}
			}}
			onDragLeave={e => e.currentTarget === e.target && setDrag(false)}
			onDrop={(e) => {
				e.preventDefault();
				setDrag(false);
				void addFiles([...(e.dataTransfer?.files ?? [])]);
			}}
		>
			{needKey && (
				<button type="button" class="key-banner" onClick={props.onOpenSettings}>
					<IconLock size={13} />
					尚未填写 DeepSeek API Key，点击前往设置
				</button>
			)}
			<div class="composer-box">
				{!!atts.length && (
					<div class="att-strip">
						{atts.map(a => (
							<div key={a.id} class={`att-chip ${a.kind}`}>
								{a.kind === 'image' ? <img src={a.dataUrl} alt="" /> : <span class="att-file-ico"><IconFile size={15} /></span>}
								<span class="att-name" title={a.name}>
									<b>{a.name}</b>
									<span>
										{formatBytes(a.size)}
										{a.kind === 'image' && !vision ? ' · 模型不支持识图' : ''}
									</span>
								</span>
								<button type="button" class="att-x" onClick={() => setAtts(atts.filter(x => x.id !== a.id))} aria-label="移除"><IconX size={10} /></button>
							</div>
						))}
					</div>
				)}
				<textarea
					ref={ta}
					rows={1}
					value={text}
					placeholder={s.conv.messages.length ? '继续对话…' : '描述你想做的事，或询问电路问题…'}
					onInput={e => setText((e.target as HTMLTextAreaElement).value)}
					onKeyDown={onKey}
					onPaste={onPaste}
				/>
				<div class="composer-bar">
					<div class="cb-left">
						<button type="button" class="icon-btn" title="添加图片或文件" onClick={() => void pickFiles()} disabled={busy}><IconPaperclip size={15} /></button>
						<button type="button" class="icon-btn" title="附加当前画布截图" onClick={() => void capture()} disabled={busy}><IconCamera size={15} /></button>
						<ModelPicker ws={ws} onOpenSettings={props.onOpenSettings} />
						<Select<PermissionMode>
							value={s.conv.permissionMode}
							placement="top-start"
							title="权限模式"
							onChange={v => s.setMode(v)}
							options={(Object.keys(MODE_LABEL) as PermissionMode[]).map(k => ({ value: k, label: MODE_LABEL[k], desc: MODE_DESC[k], icon: MODE_ICON[k] }))}
							renderValue={o => (
								<>
									{o?.icon}
									<span class="chip-label">{o?.label}</span>
								</>
							)}
						/>
					</div>
					<div class="cb-right">
						<ContextMeter session={s} ws={ws} />
						{s.running
							? <button type="button" class="send-btn stop" onClick={() => s.stop()} title="停止（Esc）"><IconStop size={14} /></button>
							: <button type="button" class="send-btn" onClick={send} disabled={(!text.trim() && !atts.length) || busy} title={ws.settings.sendKey === 'enter' ? '发送（Enter）' : '发送（Ctrl+Enter）'}><IconSend size={15} /></button>}
					</div>
				</div>
			</div>
			<input
				ref={fileInput}
				type="file"
				multiple
				hidden
				onChange={(e) => {
					const el = e.target as HTMLInputElement;
					void addFiles([...(el.files ?? [])]);
					el.value = '';
				}}
			/>
			{drag && <div class="drop-hint">松开以添加附件</div>}
		</div>
	);
}
