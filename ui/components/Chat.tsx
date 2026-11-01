/**
 * 对话消息流：用户消息、助手回复（思考过程 / Markdown / 工具调用卡片）、审批与提问卡片
 */
import type { PendingApproval, PendingQuestion, Session } from '../agent/engine';
import type { ChatMessage, ToolRun } from '../agent/types';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { RISK_LABEL } from '../agent/permissions';
import { copyText, formatBytes, formatTime, safeStringify, truncate } from '../lib/util';
import { confirmDialog, notify, Spinner } from './common';
import {
	IconAlert,
	IconBranch,
	IconBrain,
	IconCheck,
	IconChevronRight,
	IconCopy,
	IconEdit,
	IconFile,
	IconQuestion,
	IconRefresh,
	IconRewind,
	IconShield,
	IconTool,
	IconUndo,
	IconX,
} from './icons';
import { Markdown } from './Markdown';

type Theme = 'light' | 'dark';

// ———————————————————— 思考过程 ————————————————————

function Reasoning(props: { text: string; streaming: boolean; theme: Theme }) {
	const [open, setOpen] = useState(props.streaming);
	useEffect(() => {
		if (!props.streaming)
			setOpen(false);
	}, [props.streaming]);
	return (
		<div class={`reasoning ${open ? 'open' : ''}`}>
			<button type="button" class="reasoning-head" onClick={() => setOpen(!open)}>
				<IconBrain size={14} />
				<span>{props.streaming ? '深度思考中' : '思考过程'}</span>
				{props.streaming && <span class="dots"><i /><i /><i /></span>}
				<IconChevronRight size={12} class="chev" />
			</button>
			<div class={`collapse ${open ? 'open' : ''}`}><div class="collapse-inner">
				<div class="reasoning-body">{props.text}</div>
			</div></div>
		</div>
	);
}

// ———————————————————— 工具调用卡片 ————————————————————

const STATUS_TEXT: Record<ToolRun['status'], string> = {
	pending: '排队中',
	awaiting: '等待确认',
	running: '执行中',
	done: '完成',
	error: '失败',
	denied: '已拒绝',
	cancelled: '已取消',
};

function StatusIcon(props: { run: ToolRun }) {
	switch (props.run.status) {
		case 'running': return <Spinner size={12} />;
		case 'done': return <IconCheck size={13} class="ok" />;
		case 'error': return <IconAlert size={13} class="bad" />;
		case 'denied': return <IconX size={13} class="bad" />;
		case 'awaiting': return <IconShield size={13} class="warn" />;
		default: return <span class="dot-idle" />;
	}
}

function ToolCard(props: { run: ToolRun; theme: Theme; onUndo?: (changeId: string) => void; undone?: boolean }) {
	const r = props.run;
	const [open, setOpen] = useState(false);
	const dur = r.startedAt && r.endedAt ? `${((r.endedAt - r.startedAt) / 1000).toFixed(1)}s` : '';
	const isMeta = r.name === 'update_plan' || r.name === 'ask_user';
	const display = r.display;

	if (display?.kind === 'plan') {
		return (
			<div class="plan-card">
				<div class="plan-head"><IconTool size={13} /><span>计划</span><span class="muted">{display.steps.filter(s => s.status === 'done').length}/{display.steps.length}</span></div>
				<ol class="plan-steps">
					{display.steps.map((s, i) => (
						<li key={i} class={s.status}>
							<span class="plan-mark">{s.status === 'done' ? <IconCheck size={11} /> : s.status === 'in_progress' ? <Spinner size={10} /> : null}</span>
							<span>{s.title}</span>
						</li>
					))}
				</ol>
				{display.note && <div class="plan-note">{display.note}</div>}
			</div>
		);
	}
	if (display?.kind === 'answer') {
		return (
			<div class="qa-card">
				<div class="qa-q"><IconQuestion size={13} />{display.question}</div>
				<div class="qa-a">{display.answer}</div>
			</div>
		);
	}

	return (
		<div class={`tool-card ${r.status} risk-${r.risk} ${open ? 'open' : ''} ${isMeta ? 'meta' : ''}`}>
			<button type="button" class="tool-head" onClick={() => setOpen(!open)}>
				<span class="tool-status"><StatusIcon run={r} /></span>
				<span class="tool-title">{r.title}</span>
				{r.summary && <span class="tool-summary">{r.summary}</span>}
				<span class="tool-meta">
					{r.risk !== 'read' && <span class={`risk-tag ${r.risk}`}>{RISK_LABEL[r.risk]}</span>}
					{r.status !== 'done' && <span class="tool-state">{STATUS_TEXT[r.status]}</span>}
					{dur && <span class="muted">{dur}</span>}
				</span>
				<IconChevronRight size={12} class="chev" />
			</button>
			{display?.kind === 'image' && (
				<div class="tool-image">
					<img src={display.src} alt={display.caption ?? ''} loading="lazy" onClick={() => openImage(display.src)} />
				</div>
			)}
			<div class={`collapse ${open ? 'open' : ''}`}><div class="collapse-inner">
				<div class="tool-body">
					<div class="tool-sec">
						<div class="tool-label">参数<span class="tool-name">{r.name}</span></div>
						<pre class="tool-pre">{typeof r.args === 'string' ? r.args : safeStringify(r.args, 2)}</pre>
					</div>
					{(r.result || r.error || r.denyReason) && (
						<div class="tool-sec">
							<div class="tool-label">{r.error ? '错误' : r.denyReason ? '拒绝原因' : '结果'}</div>
							<pre class={`tool-pre ${r.error || r.denyReason ? 'err' : ''}`}>{r.error ?? r.denyReason ?? prettyResult(r.result!)}</pre>
						</div>
					)}
					{r.changeId && props.onUndo && (
						<div class="tool-actions">
							<button type="button" class="btn sm ghost" disabled={props.undone} onClick={() => props.onUndo!(r.changeId!)}>
								<IconUndo size={13} />{props.undone ? '已撤销' : '撤销此改动'}
							</button>
						</div>
					)}
				</div>
			</div></div>
		</div>
	);
}

function prettyResult(s: string): string {
	try {
		return truncate(JSON.stringify(JSON.parse(s), null, 2), 6000);
	}
	catch {
		return s;
	}
}

function openImage(src: string): void {
	const mask = document.createElement('div');
	mask.className = 'lightbox';
	const img = document.createElement('img');
	img.src = src;
	mask.appendChild(img);
	mask.addEventListener('click', () => {
		mask.classList.add('leave');
		setTimeout(() => mask.remove(), 160);
	});
	document.body.appendChild(mask);
}

// ———————————————————— 审批 / 提问 ————————————————————

export function ApprovalCard(props: { approval: PendingApproval }) {
	const a = props.approval;
	const [feedback, setFeedback] = useState('');
	const [showArgs, setShowArgs] = useState(false);
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		ref.current?.querySelector<HTMLButtonElement>('.btn.primary')?.focus();
	}, [a.callId]);
	const onKey = (e: KeyboardEvent) => {
		if (e.target instanceof HTMLTextAreaElement)
			return;
		if (e.key === 'Enter') {
			e.preventDefault();
			a.resolve('allow');
		}
		else if (e.key === 'Escape') {
			e.preventDefault();
			a.resolve('deny', feedback.trim() || undefined);
		}
	};
	return (
		<div class={`approval-card risk-${a.risk}`} ref={ref} onKeyDown={onKey}>
			<div class="ap-head">
				<IconShield size={15} />
				<span class="ap-title">需要你的确认</span>
				<span class={`risk-tag ${a.risk}`}>{RISK_LABEL[a.risk]}</span>
			</div>
			<div class="ap-body">
				<div class="ap-tool"><b>{a.title}</b>{a.summary && <span class="muted"> · {a.summary}</span>}</div>
				<div class="ap-reason">{a.reason}</div>
				<button type="button" class="link" onClick={() => setShowArgs(!showArgs)}>{showArgs ? '隐藏参数' : '查看参数'}</button>
				{showArgs && <pre class="tool-pre">{safeStringify(a.args, 2)}</pre>}
				<textarea class="ap-feedback" rows={1} placeholder="拒绝时可告诉 Agent 原因或改法（可选）" value={feedback} onInput={e => setFeedback((e.target as HTMLTextAreaElement).value)} />
			</div>
			<div class="ap-actions">
				<button type="button" class="btn ghost" onClick={() => a.resolve('deny', feedback.trim() || undefined)}>拒绝<kbd>Esc</kbd></button>
				<button type="button" class="btn" onClick={() => a.resolve('allow-session')} title="本对话内再次调用此工具不再询问">本对话始终允许</button>
				<button type="button" class="btn primary" onClick={() => a.resolve('allow')}>允许<kbd>↵</kbd></button>
			</div>
		</div>
	);
}

export function QuestionCard(props: { question: PendingQuestion }) {
	const q = props.question;
	const [text, setText] = useState('');
	const [picked, setPicked] = useState<string[]>([]);
	const allowText = q.allowFreeText !== false;
	const submit = (answer?: string) => {
		const parts = answer !== undefined ? [answer] : [...picked, text.trim()].filter(Boolean);
		if (!parts.length)
			return;
		q.resolve(parts.join('；'));
	};
	return (
		<div class="question-card">
			<div class="qc-head"><IconQuestion size={15} /><span>Agent 想确认一下</span></div>
			<div class="qc-q">{q.question}</div>
			{!!q.options?.length && (
				<div class="qc-options">
					{q.options.map((o, i) => (
						<button
							type="button"
							key={o}
							class={`qc-opt ${picked.includes(o) ? 'on' : ''}`}
							onClick={() => {
								if (!q.multiple)
									return submit(o);
								setPicked(picked.includes(o) ? picked.filter(x => x !== o) : [...picked, o]);
							}}
						>
							<span class="qc-idx">{i + 1}</span>{o}
						</button>
					))}
				</div>
			)}
			{allowText && (
				<div class="qc-input">
					<input
						type="text"
						placeholder={q.options?.length ? '或输入其它回答…' : '输入你的回答…'}
						value={text}
						onInput={e => setText((e.target as HTMLInputElement).value)}
						onKeyDown={(e) => {
							if (e.key === 'Enter' && !e.isComposing) {
								e.preventDefault();
								submit();
							}
						}}
						autoFocus
					/>
					<button type="button" class="btn primary sm" onClick={() => submit()}>回答</button>
				</div>
			)}
			{q.multiple && !allowText && <button type="button" class="btn primary sm" onClick={() => submit()}>确定</button>}
		</div>
	);
}

// ———————————————————— 单条消息 ————————————————————

function UserBubble(props: { m: ChatMessage; session: Session; onEdit: (m: ChatMessage) => void; onFork: (id: string) => void }) {
	const { m } = props;
	return (
		<div class="msg user">
			<div class="bubble">
				{!!m.attachments?.length && (
					<div class="att-row">
						{m.attachments.map(a => a.kind === 'image'
							? <img key={a.id} class="att-thumb" src={a.dataUrl} alt={a.name} onClick={() => a.dataUrl && openImage(a.dataUrl)} />
							: <span key={a.id} class="att-file"><IconFile size={13} />{a.name}<span class="muted">{formatBytes(a.size)}</span></span>)}
					</div>
				)}
				{m.content && <div class="user-text">{m.content}</div>}
			</div>
			<div class="msg-actions">
				<span class="muted">{formatTime(m.createdAt)}</span>
				<button type="button" class="ma" title="复制" onClick={() => void copyText(m.content).then(() => notify('已复制'))}><IconCopy size={13} /></button>
				<button type="button" class="ma" title="回溯到此处并重新编辑" onClick={() => props.onEdit(m)}><IconRewind size={13} /></button>
				<button type="button" class="ma" title="从这里分叉出新对话" onClick={() => props.onFork(m.id)}><IconBranch size={13} /></button>
			</div>
		</div>
	);
}

interface TurnGroup {
	user?: ChatMessage;
	items: ChatMessage[];
}

function groupTurns(messages: ChatMessage[], start: number): TurnGroup[] {
	const groups: TurnGroup[] = [];
	for (const m of messages.slice(start)) {
		if (m.role === 'user' && m.kind !== 'injection') {
			groups.push({ user: m, items: [] });
			continue;
		}
		if (m.role === 'tool' || m.kind === 'injection')
			continue;
		if (!groups.length)
			groups.push({ items: [] });
		groups[groups.length - 1].items.push(m);
	}
	return groups;
}

/** 一轮回复中的「过程」：思考、中间说明、工具调用。整体可收起，最终回答始终显示在外面 */
function ProcessGroup(props: { parts: ChatMessage[]; running: boolean; session: Session; theme: Theme; showReasoning: boolean; onUndo: (id: string) => void }) {
	const runs = props.parts.flatMap(m => m.toolRuns ?? []);
	const [open, setOpen] = useState(props.running);
	const wasRunning = useRef(props.running);
	useEffect(() => {
		// 运行中自动展开；本轮结束后自动收起
		if (props.running && !wasRunning.current)
			setOpen(true);
		else if (!props.running && wasRunning.current)
			setOpen(false);
		wasRunning.current = props.running;
	}, [props.running]);
	const failed = runs.filter(r => r.status === 'error' || r.status === 'denied').length;
	const start = props.parts[0]?.createdAt ?? 0;
	let end = start;
	for (const m of props.parts)
		end = Math.max(end, m.createdAt + (m.durationMs ?? 0));
	for (const r of runs)
		end = Math.max(end, r.endedAt ?? 0);
	const secs = end > start ? (end - start) / 1000 : 0;
	const current = runs.find(r => r.status === 'running' || r.status === 'awaiting');
	const changes = props.session.conv.changes;
	return (
		<div class={`process ${open ? 'open' : ''} ${props.running ? 'live' : ''}`}>
			<button type="button" class="process-head" onClick={() => setOpen(!open)} aria-expanded={open}>
				{props.running ? <Spinner size={12} /> : <IconTool size={13} />}
				<span class="process-title">
					{props.running ? (current ? `正在${current.title}` : '正在处理') : '处理过程'}
				</span>
				<span class="process-meta">
					{runs.length > 0 && `${runs.length} 步`}
					{failed > 0 && <span class="bad">{` · ${failed} 失败`}</span>}
					{secs >= 0.1 && ` · ${secs < 60 ? `${secs.toFixed(1)}s` : `${Math.floor(secs / 60)}m${Math.round(secs % 60)}s`}`}
				</span>
				<span class="process-toggle">{open ? '收起' : '展开'}</span>
				<IconChevronRight size={12} class="chev" />
			</button>
			<div class={`collapse ${open ? 'open' : ''}`}><div class="collapse-inner">
				<div class="process-body">
					{props.parts.map(m => (
						<div key={m.id} class="a-part">
							{props.showReasoning && m.reasoning && <Reasoning text={m.reasoning} streaming={!!m.streaming && !m.content} theme={props.theme} />}
							{m.content && <Markdown text={m.content} streaming={m.streaming} theme={props.theme} class="process-text" />}
							{!!m.toolRuns?.length && (
								<div class="tool-list">
									{m.toolRuns.map(r => (
										<ToolCard key={r.callId} run={r} theme={props.theme} onUndo={props.onUndo} undone={changes.find(c => c.id === r.changeId)?.status === 'undone'} />
									))}
								</div>
							)}
							{m.error && <div class="msg-error"><IconAlert size={14} /><span>{m.error}</span></div>}
						</div>
					))}
				</div>
			</div></div>
		</div>
	);
}

function AssistantTurn(props: { items: ChatMessage[]; session: Session; theme: Theme; showReasoning: boolean; isLast: boolean }) {
	const s = props.session;
	const items = props.items;
	const running = props.isLast && s.running;
	const last = items[items.length - 1];
	// 最后一条不含工具调用的消息视为最终回答，放在过程之外
	const final = last && !last.toolRuns?.length ? last : undefined;
	const parts = final ? items.slice(0, -1) : items;
	const hasProcess = parts.some(m => m.toolRuns?.length || m.content || m.reasoning || m.error);
	const text = items.map(m => m.content).filter(Boolean).join('\n\n');
	const undo = async (id: string) => {
		const errs = await s.undoRecord(id);
		notify(errs.length ? errs.join('；') : '已撤销', errs.length ? 'error' : 'success');
	};
	const usage = items.reduce((acc, m) => acc + (m.usage?.completion ?? 0), 0);
	return (
		<div class="msg assistant">
			{hasProcess && <ProcessGroup parts={parts} running={running && !final?.content} session={s} theme={props.theme} showReasoning={props.showReasoning} onUndo={undo} />}
			{final && (
				<div class="a-part">
					{props.showReasoning && final.reasoning && <Reasoning text={final.reasoning} streaming={!!final.streaming && !final.content} theme={props.theme} />}
					{final.content && <Markdown text={final.content} streaming={final.streaming} theme={props.theme} />}
					{final.streaming && !final.content && !final.reasoning && <div class="typing"><span class="dots"><i /><i /><i /></span></div>}
					{final.error && <div class="msg-error"><IconAlert size={14} /><span>{final.error}</span></div>}
				</div>
			)}
			{last && !last.streaming && !s.running && (
				<div class="msg-actions">
					{text && <button type="button" class="ma" title="复制回复" onClick={() => void copyText(text).then(() => notify('已复制'))}><IconCopy size={13} /></button>}
					{props.isLast && <button type="button" class="ma" title="重新生成" onClick={() => void s.regenerate()}><IconRefresh size={13} /></button>}
					{last.model && <span class="muted">{last.model}</span>}
					{usage > 0 && <span class="muted">· {usage} tokens</span>}
				</div>
			)}
		</div>
	);
}

/** 运行状态行：显示已等待秒数，便于判断是否卡住 */
function StatusLine(props: { session: Session }) {
	const s = props.session;
	const [, tick] = useState(0);
	useEffect(() => {
		const t = setInterval(() => tick(x => x + 1), 1000);
		return () => clearInterval(t);
	}, []);
	const secs = Math.max(0, Math.floor((Date.now() - s.statusAt) / 1000));
	return (
		<div class={`status-line ${secs >= 60 ? 'slow' : ''}`}>
			<Spinner size={12} />
			<span>{s.status || '处理中…'}</span>
			{secs >= 3 && <span class="muted">{`${secs}s`}</span>}
			{secs >= 60 && <button type="button" class="link" onClick={() => s.stop()}>停止</button>}
		</div>
	);
}

// ———————————————————— 消息列表 ————————————————————

export function ChatView(props: {
	session: Session;
	theme: Theme;
	showReasoning: boolean;
	onEdit: (text: string, attachments: ChatMessage['attachments']) => void;
	onFork: (messageId: string) => void;
	empty: preact.ComponentChildren;
}) {
	const s = props.session;
	const scroller = useRef<HTMLDivElement>(null);
	const stick = useRef(true);
	const [showJump, setShowJump] = useState(false);
	const start = s.conv.compactedCount ?? 0;
	const groups = groupTurns(s.conv.messages, start);

	useLayoutEffect(() => {
		const el = scroller.current;
		if (el && stick.current)
			el.scrollTop = el.scrollHeight;
	});

	useEffect(() => {
		stick.current = true;
		const el = scroller.current;
		if (el)
			el.scrollTop = el.scrollHeight;
	}, [s.conv.id]);

	const onScroll = () => {
		const el = scroller.current;
		if (!el)
			return;
		const near = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
		stick.current = near;
		setShowJump(!near);
	};

	const edit = async (m: ChatMessage) => {
		const affected = s.changesAfter(m.id);
		let undo = false;
		if (affected.length || s.conv.messages[s.conv.messages.length - 1]?.id !== m.id) {
			const r = await confirmDialog({
				title: '回溯到这条消息？',
				body: <span>这条消息及之后的对话将被移除，内容会放回输入框供你修改后重新发送。{affected.length ? `之后的轮次产生了 ${affected.length} 处设计改动。` : ''}</span>,
				ok: '回溯',
				extra: affected.length ? { label: '同时撤销这些设计改动', default: true } : undefined,
			});
			if (!r.ok)
				return;
			undo = r.extra;
		}
		const { message, errors } = await s.rewindTo(m.id, undo);
		if (errors.length)
			notify(errors.join('；'), 'error');
		if (message)
			props.onEdit(message.content, message.attachments);
	};

	return (
		<div class="chat-scroll" ref={scroller} onScroll={onScroll}>
			<div class="chat-inner">
				{start > 0 && (
					<div class="compact-note"><IconEdit size={12} />早前 {start} 条消息已压缩为摘要</div>
				)}
				{!groups.length && props.empty}
				{groups.map((g, i) => (
					<div class="turn" key={g.user?.id ?? `g${i}`}>
						{g.user && <UserBubble m={g.user} session={s} onEdit={edit} onFork={props.onFork} />}
						{!!g.items.length && <AssistantTurn items={g.items} session={s} theme={props.theme} showReasoning={props.showReasoning} isLast={i === groups.length - 1} />}
					</div>
				))}
				{s.running && !s.approval && !s.question && !lastStreaming(s) && (
					<StatusLine session={s} />
				)}
				{s.lastError && !s.running && (
					<div class="msg-error block">
						<IconAlert size={14} />
						<span>{s.lastError}</span>
						<button type="button" class="btn sm ghost" onClick={() => void s.continueTurn()}>重试</button>
					</div>
				)}
			</div>
			{showJump && (
				<button
					type="button"
					class="jump-bottom"
					onClick={() => {
						stick.current = true;
						scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
					}}
				>
					↓
				</button>
			)}
		</div>
	);
}

function lastStreaming(s: Session): boolean {
	const m = s.conv.messages[s.conv.messages.length - 1];
	return !!m?.streaming && !!(m.content || m.reasoning);
}
