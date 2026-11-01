/** 通用小组件：下拉菜单、开关、提示、确认 */
import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { useOutside, usePresence } from './hooks';
import { IconCheck, IconChevronDown } from './icons';

export function Popover(props: {
	open: boolean;
	onClose: () => void;
	anchor: ComponentChildren;
	children: ComponentChildren;
	placement?: 'top-start' | 'top-end' | 'bottom-start' | 'bottom-end';
	class?: string;
}) {
	const ref = useOutside<HTMLDivElement>(props.open, props.onClose);
	const p = usePresence(props.open, 140);
	return (
		<div class="pop-anchor" ref={ref}>
			{props.anchor}
			{p.mounted && (
				<div class={`popover ${props.placement ?? 'bottom-start'} ${p.state} ${props.class ?? ''}`} role="menu">
					{props.children}
				</div>
			)}
		</div>
	);
}

export interface SelectOption<T extends string> {
	value: T;
	label: string;
	desc?: string;
	icon?: JSX.Element;
}

export function Select<T extends string>(props: {
	value: T;
	options: Array<SelectOption<T>>;
	onChange: (v: T) => void;
	placement?: 'top-start' | 'top-end' | 'bottom-start' | 'bottom-end';
	title?: string;
	compact?: boolean;
	renderValue?: (o: SelectOption<T> | undefined) => ComponentChildren;
}) {
	const [open, setOpen] = useState(false);
	const cur = props.options.find(o => o.value === props.value);
	return (
		<Popover
			open={open}
			onClose={() => setOpen(false)}
			placement={props.placement}
			anchor={(
				<button type="button" class={`chip ${props.compact ? 'compact' : ''} ${open ? 'on' : ''}`} title={props.title} onClick={() => setOpen(!open)}>
					{props.renderValue ? props.renderValue(cur) : <>{cur?.icon}<span class="chip-label">{cur?.label ?? props.value}</span></>}
					<IconChevronDown size={12} class="chev" />
				</button>
			)}
		>
			{props.options.map(o => (
				<button
					type="button"
					key={o.value}
					class={`menu-item ${o.value === props.value ? 'selected' : ''}`}
					onClick={() => {
						props.onChange(o.value);
						setOpen(false);
					}}
				>
					{o.icon && <span class="mi-icon">{o.icon}</span>}
					<span class="mi-text">
						<span class="mi-label">{o.label}</span>
						{o.desc && <span class="mi-desc">{o.desc}</span>}
					</span>
					{o.value === props.value && <IconCheck size={14} class="mi-check" />}
				</button>
			))}
		</Popover>
	);
}

export function Toggle(props: { checked: boolean; onChange: (v: boolean) => void; label?: string; desc?: string }) {
	return (
		<label class="toggle-row">
			<span class="toggle-text">
				{props.label && <span class="tr-label">{props.label}</span>}
				{props.desc && <span class="tr-desc">{props.desc}</span>}
			</span>
			<button type="button" role="switch" aria-checked={props.checked} class={`switch ${props.checked ? 'on' : ''}`} onClick={() => props.onChange(!props.checked)}>
				<span class="knob" />
			</button>
		</label>
	);
}

export function IconButton(props: JSX.HTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }) {
	const { label, active, class: cls, ...rest } = props;
	return (
		<button type="button" class={`icon-btn ${active ? 'active' : ''} ${cls ?? ''}`} title={label} aria-label={label} {...rest} />
	);
}

export function Spinner(props: { size?: number }) {
	const s = props.size ?? 14;
	return <span class="spinner" style={{ width: `${s}px`, height: `${s}px` }} />;
}

/** 底部轻提示 */
let toastSeq = 0;
type ToastItem = { id: number; text: string; kind: 'info' | 'error' | 'success' };
const toastListeners = new Set<(t: ToastItem[]) => void>();
let toasts: ToastItem[] = [];

export function notify(text: string, kind: ToastItem['kind'] = 'info'): void {
	const t = { id: ++toastSeq, text, kind };
	toasts = [...toasts.slice(-2), t];
	toastListeners.forEach(l => l(toasts));
	setTimeout(() => {
		toasts = toasts.filter(x => x.id !== t.id);
		toastListeners.forEach(l => l(toasts));
	}, kind === 'error' ? 5200 : 2600);
}

export function Toasts() {
	const [list, setList] = useState<ToastItem[]>(toasts);
	useEffect(() => {
		toastListeners.add(setList);
		return () => {
			toastListeners.delete(setList);
		};
	}, []);
	return (
		<div class="toasts" aria-live="polite">
			{list.map(t => <div key={t.id} class={`toast ${t.kind}`}>{t.text}</div>)}
		</div>
	);
}

/** 二次确认弹层 */
type ConfirmReq = { title: string; body?: ComponentChildren; ok?: string; danger?: boolean; extra?: { label: string; default: boolean }; resolve: (r: { ok: boolean; extra: boolean }) => void };
let confirmSetter: ((r: ConfirmReq | undefined) => void) | undefined;

export function confirmDialog(o: Omit<ConfirmReq, 'resolve'>): Promise<{ ok: boolean; extra: boolean }> {
	return new Promise((resolve) => {
		if (!confirmSetter) {
			resolve({ ok: window.confirm(o.title), extra: o.extra?.default ?? false });
			return;
		}
		confirmSetter({ ...o, resolve });
	});
}

export function ConfirmHost() {
	const [req, setReq] = useState<ConfirmReq | undefined>();
	const [extra, setExtra] = useState(false);
	confirmSetter = (r) => {
		setExtra(r?.extra?.default ?? false);
		setReq(r);
	};
	const p = usePresence(!!req, 160);
	if (!p.mounted || !req)
		return null;
	const done = (ok: boolean) => {
		req.resolve({ ok, extra });
		setReq(undefined);
	};
	return (
		<div class={`modal-mask ${p.state}`} onMouseDown={e => e.target === e.currentTarget && done(false)}>
			<div class="modal" role="dialog" aria-modal="true">
				<div class="modal-title">{req.title}</div>
				{req.body && <div class="modal-body">{req.body}</div>}
				{req.extra && (
					<label class="check-row">
						<input type="checkbox" checked={extra} onChange={e => setExtra((e.target as HTMLInputElement).checked)} />
						<span>{req.extra.label}</span>
					</label>
				)}
				<div class="modal-actions">
					<button type="button" class="btn ghost" onClick={() => done(false)}>取消</button>
					<button type="button" class={`btn ${req.danger ? 'danger' : 'primary'}`} onClick={() => done(true)}>{req.ok ?? '确定'}</button>
				</div>
			</div>
		</div>
	);
}
