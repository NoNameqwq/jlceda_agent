/**
 * 侧滑面板：改动（Diff + 撤销）与历史对话
 */
import type { ChangeItem, ChangeRecord, ConversationMeta } from '../agent/types';
import type { Session } from '../agent/engine';
import type { Workspace } from '../agent/workspace';
import { useMemo, useState } from 'preact/hooks';
import { changeStats } from '../agent/undo';
import { callEda } from '../lib/eda';
import { formatTime, safeStringify } from '../lib/util';
import { confirmDialog, notify } from './common';
import { usePresence } from './hooks';
import { IconCheck, IconChevronRight, IconDiff, IconEdit, IconHistory, IconSearch, IconTrash, IconUndo, IconX } from './icons';

export function Drawer(props: { open: boolean; title: string; icon: preact.ComponentChildren; onClose: () => void; actions?: preact.ComponentChildren; children: preact.ComponentChildren }) {
	const p = usePresence(props.open, 220);
	if (!p.mounted)
		return null;
	return (
		<div class={`drawer-mask ${p.state}`} onMouseDown={e => e.target === e.currentTarget && props.onClose()}>
			<aside class="drawer" role="dialog" aria-label={props.title}>
				<header class="drawer-head">
					<span class="drawer-title">{props.icon}{props.title}</span>
					<span class="drawer-actions">
						{props.actions}
						<button type="button" class="icon-btn" title="关闭" aria-label="关闭" onClick={props.onClose}><IconX size={15} /></button>
					</span>
				</header>
				<div class="drawer-body">{props.children}</div>
			</aside>
		</div>
	);
}

// ———————————————————— 改动 ————————————————————

const OP_LABEL: Record<ChangeItem['op'], string> = { create: '新增', modify: '修改', delete: '删除', other: '操作' };

function fmt(v: unknown): string {
	if (v === undefined)
		return '—';
	if (typeof v === 'string')
		return v || '""';
	if (typeof v === 'number' || typeof v === 'boolean' || v === null)
		return String(v);
	const s = safeStringify(v);
	return s.length > 80 ? `${s.slice(0, 77)}…` : s;
}

function DiffRows(props: { item: ChangeItem }) {
	const it = props.item;
	if (it.op === 'modify') {
		const keys = Object.keys({ ...(it.before ?? {}), ...(it.after ?? {}) });
		return (
			<div class="diff">
				{keys.map(k => (
					<div class="diff-row" key={k}>
						<span class="diff-key">{k}</span>
						<span class="diff-old">{fmt(it.before?.[k])}</span>
						<span class="diff-arrow">→</span>
						<span class="diff-new">{fmt(it.after?.[k])}</span>
					</div>
				))}
			</div>
		);
	}
	const src = it.op === 'delete' ? it.before : it.after;
	if (!src || typeof src !== 'object')
		return null;
	const pick = ['designator', 'name', 'net', 'x', 'y', 'rotation', 'layer', 'line', 'content', 'text', 'startX', 'startY', 'endX', 'endY', 'lineWidth', 'diameter', 'holeDiameter'];
	const rows = pick.filter(k => src[k] !== undefined && src[k] !== null && src[k] !== '');
	if (!rows.length)
		return null;
	return (
		<div class={`diff ${it.op === 'delete' ? 'del' : 'add'}`}>
			{rows.map(k => (
				<div class="diff-row" key={k}>
					<span class="diff-sign">{it.op === 'delete' ? '−' : '+'}</span>
					<span class="diff-key">{k}</span>
					<span class={it.op === 'delete' ? 'diff-old' : 'diff-new'}>{fmt(src[k])}</span>
				</div>
			))}
		</div>
	);
}

function ChangeCard(props: { rec: ChangeRecord; session: Session }) {
	const { rec, session } = props;
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const undone = rec.status === 'undone';
	const locate = async (it: ChangeItem) => {
		if (!it.primitiveId || it.undone || it.op === 'delete')
			return;
		const cls = it.kind.startsWith('pcb_') ? 'pcb_SelectControl' : 'sch_SelectControl';
		try {
			await callEda(`${cls}.doSelectPrimitives`, [it.primitiveId]);
			await callEda('dmt_EditorControl.zoomToSelectedPrimitives').catch(() => {});
		}
		catch {
			notify('无法定位：请先打开该改动所在的文档', 'error');
		}
	};
	const undo = async () => {
		setBusy(true);
		const errs = await session.undoRecord(rec.id);
		setBusy(false);
		if (errs.length)
			notify(errs.join('；'), 'error');
		else notify('已撤销');
	};
	return (
		<div class={`change-card ${undone ? 'undone' : ''} ${rec.status}`}>
			<div class="cc-head" onClick={() => setOpen(!open)}>
				<IconChevronRight size={13} class={`chev-r ${open ? 'open' : ''}`} />
				<span class="cc-title">{rec.title}</span>
				<span class="cc-count">{rec.items.length}</span>
				<span class="cc-time">{formatTime(rec.createdAt)}</span>
				{undone
					? <span class="badge muted"><IconCheck size={11} />已撤销</span>
					: rec.undoable
						? (
								<button type="button" class="mini-btn" disabled={busy} onClick={(e) => {
									e.stopPropagation();
									void undo();
								}}
								>
									<IconUndo size={12} />
									撤销
								</button>
							)
						: <span class="badge warn" title={rec.note}>需手动撤销</span>}
			</div>
			{rec.summary && <div class="cc-summary">{rec.summary}</div>}
			<div class={`collapse ${open ? 'open' : ''}`}>
				<div class="collapse-inner">
					{rec.note && <div class="cc-note">{rec.note}</div>}
					{rec.items.map((it, i) => (
						<div class={`cc-item ${it.undone ? 'undone' : ''}`} key={i}>
							<div class="cc-item-head">
								<span class={`op op-${it.op}`}>{OP_LABEL[it.op]}</span>
								<span class="cc-kind">{it.label ?? it.kind.replace(/^(sch|pcb)_Primitive/, '')}</span>
								{it.primitiveId && !it.undone && it.op !== 'delete' && (
									<button type="button" class="link-btn" onClick={() => void locate(it)}>定位</button>
								)}
							</div>
							<DiffRows item={it} />
						</div>
					))}
				</div>
			</div>
		</div>
	);
}

export function ChangesPanel(props: { open: boolean; onClose: () => void; session: Session }) {
	const s = props.session;
	const list = [...s.conv.changes].reverse();
	const stats = changeStats(s.conv.changes);
	const pending = s.conv.changes.filter(c => c.status !== 'undone').length;
	const undoAll = async () => {
		const r = await confirmDialog({ title: '撤销本对话的全部改动？', body: '将按时间倒序逐条撤销。无法自动撤销的操作需要在 EDA 中使用 Ctrl+Z。', ok: '全部撤销', danger: true });
		if (!r.ok)
			return;
		const errs = await s.undoAll();
		notify(errs.length ? `部分未撤销：${errs.slice(0, 3).join('；')}` : '已全部撤销', errs.length ? 'error' : 'success');
	};
	return (
		<Drawer
			open={props.open}
			onClose={props.onClose}
			title="设计改动"
			icon={<IconDiff size={15} />}
			actions={pending > 0 && <button type="button" class="mini-btn danger" onClick={() => void undoAll()}><IconUndo size={12} />全部撤销</button>}
		>
			<div class="stat-row">
				<span class="stat add">+{stats.create}</span>
				<span class="stat mod">~{stats.modify}</span>
				<span class="stat del">−{stats.delete}</span>
				{stats.other > 0 && <span class="stat other">⋯{stats.other}</span>}
			</div>
			{list.length === 0
				? <div class="empty-hint">本对话尚未修改设计。Agent 的每次改动都会记录在这里，可逐条查看差异、定位并撤销。</div>
				: list.map(r => <ChangeCard key={r.id} rec={r} session={s} />)}
		</Drawer>
	);
}

// ———————————————————— 历史 ————————————————————

function groupByDate(list: ConversationMeta[]): Array<[string, ConversationMeta[]]> {
	const today = new Date();
	today.setHours(0, 0, 0, 0);
	const t0 = today.getTime();
	const groups: Record<string, ConversationMeta[]> = {};
	const order: string[] = [];
	for (const m of list) {
		const d = m.updatedAt >= t0 ? '今天' : m.updatedAt >= t0 - 86400_000 ? '昨天' : m.updatedAt >= t0 - 7 * 86400_000 ? '近 7 天' : '更早';
		if (!groups[d]) {
			groups[d] = [];
			order.push(d);
		}
		groups[d].push(m);
	}
	return order.map(k => [k, groups[k]]);
}

export function HistoryPanel(props: { open: boolean; onClose: () => void; ws: Workspace }) {
	const { ws } = props;
	const [q, setQ] = useState('');
	const [editing, setEditing] = useState<string>();
	const [draft, setDraft] = useState('');
	const list = useMemo(() => {
		const k = q.trim().toLowerCase();
		return ws.index.filter(m => m.count > 0 || ws.openIds.includes(m.id)).filter(m => !k || m.title.toLowerCase().includes(k));
	}, [ws.index, q, ws.index.length]);

	const remove = async (m: ConversationMeta) => {
		const r = await confirmDialog({ title: `删除对话「${m.title}」？`, body: '对话记录将被永久删除，已应用到设计中的改动不受影响。', ok: '删除', danger: true });
		if (r.ok)
			await ws.remove(m.id);
	};

	return (
		<Drawer open={props.open} onClose={props.onClose} title="对话历史" icon={<IconHistory size={15} />}>
			<div class="search-box">
				<IconSearch size={14} />
				<input value={q} placeholder="搜索对话" onInput={e => setQ((e.target as HTMLInputElement).value)} />
			</div>
			<div class="hist-scope">{ws.editor.projectName ? `工程：${ws.editor.projectName}` : '未打开工程（全局对话）'}</div>
			{list.length === 0 && <div class="empty-hint">{q ? '没有匹配的对话' : '暂无历史对话'}</div>}
			{groupByDate(list).map(([g, items]) => (
				<div class="hist-group" key={g}>
					<div class="hist-label">{g}</div>
					{items.map(m => (
						<div
							key={m.id}
							class={`hist-item ${m.id === ws.activeId ? 'active' : ''}`}
							onClick={() => {
								if (editing)
									return;
								void ws.open(m.id);
								props.onClose();
							}}
						>
							{editing === m.id
								? (
										<input
											class="hist-rename"
											value={draft}
											autoFocus
											onClick={e => e.stopPropagation()}
											onInput={e => setDraft((e.target as HTMLInputElement).value)}
											onKeyDown={(e) => {
												if (e.key === 'Enter') {
													ws.rename(m.id, draft);
													setEditing(undefined);
												}
												else if (e.key === 'Escape') {
													setEditing(undefined);
												}
											}}
											onBlur={() => {
												ws.rename(m.id, draft);
												setEditing(undefined);
											}}
										/>
									)
								: (
										<>
											<span class="hist-title">
												{ws.openIds.includes(m.id) && <span class="dot-open" />}
												{m.title}
											</span>
											<span class="hist-meta">
												{m.count}
												{' '}
												轮 ·
												{formatTime(m.updatedAt)}
											</span>
											<span class="hist-acts">
												<button type="button" class="icon-btn sm" title="重命名" onClick={(e) => {
													e.stopPropagation();
													setDraft(m.title);
													setEditing(m.id);
												}}
												>
													<IconEdit size={13} />
												</button>
												<button type="button" class="icon-btn sm danger" title="删除" onClick={(e) => {
													e.stopPropagation();
													void remove(m);
												}}
												>
													<IconTrash size={13} />
												</button>
											</span>
										</>
									)}
						</div>
					))}
				</div>
			))}
		</Drawer>
	);
}
