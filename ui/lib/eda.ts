/**
 * EDA 运行时访问层
 *
 * 内联框架内由 EDA 注入 `eda` 对象（扩展作用域）。为兼容不同版本，依次尝试
 * window.eda / parent.eda / top.eda。所有调用都通过 callEda 统一走异常捕获。
 */

let cached: any;

export function getEda(): any | undefined {
	if (cached)
		return cached;
	const candidates: Array<() => any> = [
		() => (globalThis as any).eda,
		() => window.eda,
		() => (window.parent as any)?.eda,
		() => (window.top as any)?.eda,
	];
	for (const c of candidates) {
		try {
			const v = c();
			if (v && typeof v === 'object' && (v.sys_Environment || v.dmt_Project)) {
				cached = v;
				return v;
			}
		}
		catch {}
	}
	return undefined;
}

export function hasEda(): boolean {
	return !!getEda();
}

export class EdaUnavailableError extends Error {
	constructor() {
		super('未检测到嘉立创EDA运行环境（eda 对象不可用）。请在嘉立创EDA专业版中通过扩展菜单打开本面板。');
		this.name = 'EdaUnavailableError';
	}
}

/** 解析 'sch_PrimitiveWire.create' 形式的路径 */
export function resolveEdaMethod(path: string): { owner: any; fn: (...a: any[]) => any; className: string; method: string } {
	const eda = getEda();
	if (!eda)
		throw new EdaUnavailableError();
	const clean = path.replace(/^eda\./, '').trim();
	const [className, method] = clean.split('.');
	if (!className || !method)
		throw new Error(`无效的 API 路径「${path}」，格式应为 类实例名.方法名，例如 sch_PrimitiveWire.create`);
	const owner = eda[className];
	if (!owner)
		throw new Error(`eda.${className} 不存在。可先调用 eda_help 查看可用的类。`);
	const fn = owner[method];
	if (typeof fn !== 'function')
		throw new Error(`eda.${className}.${method} 不是可调用的方法。`);
	return { owner, fn, className, method };
}

export async function callEda<T = any>(path: string, ...args: any[]): Promise<T> {
	const { owner, fn } = resolveEdaMethod(path);
	return await fn.apply(owner, args);
}

/** 不抛异常的版本，失败返回 undefined */
export async function tryEda<T = any>(path: string, ...args: any[]): Promise<T | undefined> {
	try {
		return await callEda<T>(path, ...args);
	}
	catch {
		return undefined;
	}
}

export function listEdaClasses(): string[] {
	const eda = getEda();
	if (!eda)
		return [];
	return Object.keys(eda).filter(k => /^[a-z]{3}_[A-Z]/.test(k)).sort();
}

export function listEdaMethods(className: string): string[] {
	const eda = getEda();
	const obj = eda?.[className];
	if (!obj)
		return [];
	const names = new Set<string>();
	let p = obj;
	while (p && p !== Object.prototype) {
		for (const k of Object.getOwnPropertyNames(p)) {
			if (k !== 'constructor' && !k.startsWith('_')) {
				try {
					if (typeof obj[k] === 'function')
						names.add(k);
				}
				catch {}
			}
		}
		p = Object.getPrototypeOf(p);
	}
	return [...names].sort();
}

export function toast(message: string, type: 'info' | 'warn' | 'error' | 'success' = 'info'): void {
	const eda = getEda();
	try {
		eda?.sys_Message?.showToastMessage?.(message, type, 3);
	}
	catch {}
}

/** 文档类型 → 场景 */
export type EditorScene = 'home' | 'sch' | 'pcb' | 'symbol' | 'footprint' | 'panel' | 'pcb3d' | 'other' | 'none';

export function sceneOf(documentType: number | undefined): EditorScene {
	switch (documentType) {
		case undefined: return 'none';
		case -1: return 'home';
		case 1: case 8: case 9: return 'sch';
		case 3: case 12: return 'pcb';
		case 15: return 'pcb3d';
		case 2: case 7: case 17: case 18: case 19: case 20: case 21: case 22: case 25: case 32: return 'symbol';
		case 4: return 'footprint';
		case 26: case 27: case 29: return 'panel';
		default: return 'other';
	}
}

export const SCENE_LABEL: Record<EditorScene, string> = {
	home: '开始页',
	sch: '原理图',
	pcb: 'PCB',
	symbol: '符号',
	footprint: '封装',
	panel: '面板',
	pcb3d: '3D 预览',
	other: '其它文档',
	none: '未打开文档',
};
