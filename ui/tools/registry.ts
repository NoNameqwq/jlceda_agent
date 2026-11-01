/**
 * 工具注册表
 *
 * 每个工具 = JSON Schema 参数 + 风险等级 + 适用场景 + 执行函数。
 * 风险等级决定权限系统的默认行为：read 直接执行，write 需要「编辑」权限，danger 需要「完全」权限或用户确认。
 */
import type { ChangeItem, EditorContext, PlanStep, RiskLevel, ToolDisplay } from '../agent/types';
import { safeStringify, truncate } from '../lib/util';

export interface AskRequest {
	question: string;
	options?: string[];
	allowFreeText?: boolean;
	multiple?: boolean;
}

export interface ToolContext {
	signal: AbortSignal;
	editor: EditorContext;
	vision: boolean;
	askUser: (q: AskRequest) => Promise<string>;
	setPlan: (steps: PlanStep[], note?: string) => void;
	/** 记录一组改动（用于改动面板与撤销） */
	recordChange: (items: ChangeItem[], opts?: { undoable?: boolean; note?: string; summary?: string }) => void;
	/** 向模型注入一张图片（仅识图模型生效） */
	attachImage: (dataUrl: string, caption: string) => void;
}

export interface ToolResult {
	content: unknown;
	display?: ToolDisplay;
}

export type ToolScene = 'any' | 'sch' | 'pcb' | 'symbol' | 'footprint';

export interface ToolDef {
	name: string;
	title: string;
	group: ToolGroup;
	description: string;
	parameters: Record<string, any>;
	risk: RiskLevel | ((args: any) => RiskLevel);
	scenes?: ToolScene[];
	/** 生成工具调用的一句话摘要（显示在界面上） */
	summarize?: (args: any) => string;
	run: (args: any, ctx: ToolContext) => Promise<ToolResult | unknown>;
}

export type ToolGroup = 'meta' | 'project' | 'view' | 'sch' | 'pcb' | 'lib' | 'sim' | 'export' | 'advanced';

export const GROUP_LABEL: Record<ToolGroup, string> = {
	meta: '交互与规划',
	project: '工程与文档',
	view: '视图与选择',
	sch: '原理图',
	pcb: 'PCB',
	lib: '器件库',
	sim: '仿真（SimulIDE）',
	export: '导出与生产',
	advanced: '高级',
};

const registry = new Map<string, ToolDef>();

export function defineTools(list: ToolDef[]): void {
	for (const t of list)
		registry.set(t.name, t);
}

export function getTool(name: string): ToolDef | undefined {
	return registry.get(name);
}

export function allTools(): ToolDef[] {
	return [...registry.values()];
}

export function toolRisk(t: ToolDef, args: any): RiskLevel {
	return typeof t.risk === 'function' ? t.risk(args ?? {}) : t.risk;
}

export function toolAvailable(t: ToolDef, scene: string): boolean {
	if (!t.scenes || t.scenes.includes('any'))
		return true;
	return t.scenes.includes(scene as ToolScene);
}

export function toolsForScene(scene: string, denied: (name: string) => boolean): ToolDef[] {
	return allTools().filter(t => toolAvailable(t, scene) && !denied(t.name));
}

export function toWire(t: ToolDef): { type: 'function'; function: { name: string; description: string; parameters: any } } {
	return { type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } };
}

// ———————————————————————— 结果序列化 ————————————————————————

const MAX_RESULT = 14_000;

function lcFirst(s: string): string {
	return s ? s[0].toLowerCase() + s.slice(1) : s;
}

/** 将 EDA 图元对象（含 getState_* 方法）转换为普通对象 */
export function serialize(v: any, depth = 0): any {
	if (v === null || v === undefined)
		return v;
	if (typeof v !== 'object')
		return typeof v === 'function' ? undefined : v;
	if (depth > 5)
		return '[…]';
	if (Array.isArray(v))
		return v.map(x => serialize(x, depth + 1));
	if (typeof Blob !== 'undefined' && v instanceof Blob)
		return { blob: true, type: v.type, size: v.size, name: (v as File).name };
	const out: Record<string, any> = {};
	const seen = new Set<string>();
	let proto = v;
	let found = false;
	while (proto && proto !== Object.prototype) {
		for (const k of Object.getOwnPropertyNames(proto)) {
			if (!k.startsWith('getState_') || seen.has(k))
				continue;
			seen.add(k);
			try {
				const fn = v[k];
				if (typeof fn !== 'function')
					continue;
				const r = fn.call(v);
				if (r !== undefined && typeof r !== 'function' && !(r instanceof Promise)) {
					out[lcFirst(k.slice(9))] = serialize(r, depth + 1);
					found = true;
				}
			}
			catch {}
		}
		proto = Object.getPrototypeOf(proto);
	}
	if (found)
		return out;
	for (const [k, val] of Object.entries(v)) {
		if (typeof val === 'function' || k.startsWith('_'))
			continue;
		out[k] = serialize(val, depth + 1);
	}
	return out;
}

/** 工具结果 → 发送给模型的字符串 */
export function resultToString(content: unknown, max = MAX_RESULT): string {
	if (typeof content === 'string')
		return truncate(content, max);
	return truncate(safeStringify(serialize(content)), max);
}

// ———————————————————————— 参数 Schema 便捷构造 ————————————————————————

export const S = {
	obj(properties: Record<string, any>, required: string[] = []): Record<string, any> {
		return { type: 'object', properties, required, additionalProperties: false };
	},
	str(description: string, extra: Record<string, any> = {}): any {
		return { type: 'string', description, ...extra };
	},
	num(description: string, extra: Record<string, any> = {}): any {
		return { type: 'number', description, ...extra };
	},
	int(description: string, extra: Record<string, any> = {}): any {
		return { type: 'integer', description, ...extra };
	},
	bool(description: string): any {
		return { type: 'boolean', description };
	},
	enum(values: Array<string | number>, description: string): any {
		return { type: typeof values[0] === 'number' ? 'number' : 'string', enum: values, description };
	},
	arr(items: any, description: string, extra: Record<string, any> = {}): any {
		return { type: 'array', items, description, ...extra };
	},
	point(): any {
		return { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, description: '[x, y]' };
	},
	any(description: string): any {
		return { description };
	},
};
