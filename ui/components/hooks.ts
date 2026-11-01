/** 订阅 Workspace / Session 变化的 hooks */
import type { Session } from '../agent/engine';
import type { Workspace } from '../agent/workspace';
import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'preact/hooks';

/**
 * 订阅后立即补一次刷新：init() 可能在订阅建立前就已 emit，
 * 若不补刷新，界面会停留在启动页。
 */
export function useWorkspace(ws: Workspace): number {
	const [v, bump] = useReducer((x: number, _a: void) => x + 1, 0);
	useLayoutEffect(() => {
		const off = ws.subscribe(() => bump());
		bump();
		return () => {
			off();
		};
	}, [ws]);
	return v;
}

export function useSession(s: Session | undefined): number {
	const [v, bump] = useReducer((x: number, _a: void) => x + 1, 0);
	useLayoutEffect(() => {
		if (!s)
			return undefined;
		const off = s.subscribe(() => bump());
		bump();
		return () => {
			off();
		};
	}, [s]);
	return v;
}

/** 解析主题：system 时跟随 EDA 主题，其次跟随系统 */
export function useResolvedTheme(mode: 'system' | 'light' | 'dark', edaTheme?: 'light' | 'dark'): 'light' | 'dark' {
	const [sys, setSys] = useState<'light' | 'dark'>(() => (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
	useEffect(() => {
		const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
		if (!mq)
			return;
		const fn = () => setSys(mq.matches ? 'dark' : 'light');
		mq.addEventListener?.('change', fn);
		return () => mq.removeEventListener?.('change', fn);
	}, []);
	if (mode !== 'system')
		return mode;
	return edaTheme ?? sys;
}

/** 点击元素外部时回调 */
export function useOutside<T extends HTMLElement>(open: boolean, onClose: () => void) {
	const ref = useRef<T>(null);
	useEffect(() => {
		if (!open)
			return;
		const fn = (e: MouseEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node))
				onClose();
		};
		const key = (e: KeyboardEvent) => {
			if (e.key === 'Escape')
				onClose();
		};
		const t = setTimeout(() => document.addEventListener('mousedown', fn), 0);
		document.addEventListener('keydown', key);
		return () => {
			clearTimeout(t);
			document.removeEventListener('mousedown', fn);
			document.removeEventListener('keydown', key);
		};
	}, [open]);
	return ref;
}

/** 列表进出场：保留卸载动画时间 */
export function usePresence(open: boolean, ms = 180): { mounted: boolean; state: 'enter' | 'leave' } {
	const [mounted, setMounted] = useState(open);
	useEffect(() => {
		if (open) {
			setMounted(true);
			return;
		}
		const t = setTimeout(() => setMounted(false), ms);
		return () => clearTimeout(t);
	}, [open]);
	return { mounted: mounted || open, state: open ? 'enter' : 'leave' };
}
