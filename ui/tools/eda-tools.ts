/**
 * 嘉立创EDA 工具集
 *
 * 将扩展 API（dmt_* / sch_* / pcb_* / lib_* / sys_*）封装为模型可调用的工具。
 * 所有写操作都会记录到改动面板，支持撤销。
 * 坐标单位：原理图 / 符号 = 0.01inch（10mil）；PCB / 封装 = mil。Y 轴向上（笛卡尔坐标）。
 */
import type { ChangeItem, PlanStep } from '../agent/types';
import type { ToolContext, ToolDef } from './registry';
import { callEda, getEda, listEdaClasses, listEdaMethods, resolveEdaMethod } from '../lib/eda';
import { blobToDataUrl, blobToText, downscaleImage, errorMessage, truncate } from '../lib/util';
import { defineTools, S, serialize } from './registry';

// ———————————————————————— 公共辅助 ————————————————————————

function requireScene(ctx: ToolContext, scene: 'sch' | 'pcb'): void {
	if (ctx.editor.scene !== scene) {
		const label = scene === 'sch' ? '原理图图页' : 'PCB';
		throw new Error(`当前活动文档是「${ctx.editor.sceneLabel}」，此工具需要${label}。请先调用 list_documents 找到目标文档，再用 open_document 打开。`);
	}
}

function idOf(p: any): string | undefined {
	try {
		return typeof p?.getState_PrimitiveId === 'function' ? p.getState_PrimitiveId() : p?.primitiveId;
	}
	catch {
		return undefined;
	}
}

function ids(v: unknown): string[] {
	if (Array.isArray(v))
		return v.map(String).filter(Boolean);
	if (typeof v === 'string' && v)
		return [v];
	return [];
}

function created(ctx: ToolContext, kind: string, prim: any, label: string): string {
	const id = idOf(prim);
	if (!id)
		throw new Error(`${label} 创建失败（接口返回空）。请检查参数，例如坐标、网络名或库 UUID 是否正确。`);
	ctx.recordChange([{ op: 'create', kind, primitiveId: id, label, after: serialize(prim) }]);
	return id;
}

/** 修改前快照：只保留将被修改的字段，用于撤销 */
async function snapshot(kind: string, id: string, keys: string[]): Promise<Record<string, any>> {
	const prim = await callEda(`${kind}.get`, id);
	if (!prim)
		throw new Error(`未找到图元 ${id}`);
	const s = serialize(prim) ?? {};
	const out: Record<string, any> = {};
	for (const k of keys) {
		if (k in s)
			out[k] = s[k];
	}
	return out;
}

async function modifyTracked(ctx: ToolContext, kind: string, id: string, props: Record<string, any>, label: string): Promise<any> {
	const clean = Object.fromEntries(Object.entries(props).filter(([, v]) => v !== undefined));
	if (!Object.keys(clean).length)
		throw new Error('没有需要修改的属性');
	const before = await snapshot(kind, id, Object.keys(clean));
	const r = await callEda(`${kind}.modify`, id, clean);
	if (!r)
		throw new Error(`修改 ${id} 失败`);
	ctx.recordChange([{ op: 'modify', kind, primitiveId: id, before, after: clean, label }]);
	return serialize(r);
}

async function deleteTracked(ctx: ToolContext, kind: string, list: string[], label: string): Promise<{ deleted: number }> {
	if (!list.length)
		throw new Error('未提供要删除的图元 ID');
	const prims = await callEda<any[]>(`${kind}.get`, list).catch(() => []);
	const items: ChangeItem[] = list.map((id) => {
		const p = (prims ?? []).find(x => idOf(x) === id);
		return { op: 'delete', kind, primitiveId: id, before: p ? serialize(p) : undefined, label };
	});
	const ok = await callEda<boolean>(`${kind}.delete`, list);
	if (!ok)
		throw new Error('删除失败，图元可能不存在或已被锁定');
	ctx.recordChange(items);
	return { deleted: list.length };
}

/** 按图元类型分派到对应的类实例 */
const SCH_KIND: Record<string, string> = {
	Component: 'sch_PrimitiveComponent',
	Wire: 'sch_PrimitiveWire',
	Text: 'sch_PrimitiveText',
	Bus: 'sch_PrimitiveBus',
	Arc: 'sch_PrimitiveArc',
	Circle: 'sch_PrimitiveCircle',
	Rectangle: 'sch_PrimitiveRectangle',
	Polygon: 'sch_PrimitivePolygon',
	Pin: 'sch_PrimitivePin',
	Object: 'sch_PrimitiveObject',
	Attribute: 'sch_PrimitiveAttribute',
};

const PCB_KIND: Record<string, string> = {
	Component: 'pcb_PrimitiveComponent',
	Line: 'pcb_PrimitiveLine',
	Via: 'pcb_PrimitiveVia',
	Arc: 'pcb_PrimitiveArc',
	Pad: 'pcb_PrimitivePad',
	Polyline: 'pcb_PrimitivePolyline',
	Pour: 'pcb_PrimitivePour',
	Fill: 'pcb_PrimitiveFill',
	Region: 'pcb_PrimitiveRegion',
	String: 'pcb_PrimitiveString',
	Dimension: 'pcb_PrimitiveDimension',
	Image: 'pcb_PrimitiveImage',
	Object: 'pcb_PrimitiveObject',
	Attribute: 'pcb_PrimitiveAttribute',
};

async function groupByType(scene: 'sch' | 'pcb', list: string[]): Promise<Map<string, string[]>> {
	const map = new Map<string, string[]>();
	const cls = scene === 'sch' ? 'sch_Primitive' : 'pcb_Primitive';
	const table = scene === 'sch' ? SCH_KIND : PCB_KIND;
	for (const id of list) {
		const t = await callEda<string>(`${cls}.getPrimitiveTypeByPrimitiveId`, id).catch(() => undefined);
		const kind = t ? table[t] : undefined;
		if (!kind)
			throw new Error(`无法识别图元 ${id} 的类型${t ? `（${t}）` : ''}，该图元可能不存在`);
		map.set(kind, [...(map.get(kind) ?? []), id]);
	}
	return map;
}

const PCB_LAYERS: Record<string, number> = {
	TOP: 1,
	BOTTOM: 2,
	TOP_SILKSCREEN: 3,
	BOTTOM_SILKSCREEN: 4,
	TOP_SOLDER_MASK: 5,
	BOTTOM_SOLDER_MASK: 6,
	TOP_PASTE_MASK: 7,
	BOTTOM_PASTE_MASK: 8,
	TOP_ASSEMBLY: 9,
	BOTTOM_ASSEMBLY: 10,
	BOARD_OUTLINE: 11,
	MULTI: 12,
	DOCUMENT: 13,
	MECHANICAL: 14,
};

function layerId(v: unknown, fallback = 1): number {
	if (typeof v === 'number')
		return v;
	if (typeof v === 'string' && v) {
		const k = v.toUpperCase().replace(/[\s-]/g, '_');
		if (k in PCB_LAYERS)
			return PCB_LAYERS[k];
		const m = k.match(/^INNER_?(\d+)$/);
		if (m)
			return 14 + Number(m[1]);
		const n = Number(v);
		if (!Number.isNaN(n))
			return n;
		throw new Error(`未知图层「${v}」。可用：${Object.keys(PCB_LAYERS).join('、')}、INNER_1…INNER_32 或数字 ID`);
	}
	return fallback;
}

const LAYER_PARAM = S.any('图层：TOP / BOTTOM / TOP_SILKSCREEN / BOTTOM_SILKSCREEN / BOARD_OUTLINE / MULTI / INNER_1… 或图层数字 ID');

function brief(list: any[], limit: number, map: (x: any) => any): { total: number; items: any[]; truncated?: boolean } {
	const items = list.slice(0, limit).map(map);
	return list.length > limit ? { total: list.length, items, truncated: true } : { total: list.length, items };
}

function schComponentBrief(c: any): any {
	const s = serialize(c) ?? {};
	return {
		id: s.primitiveId,
		designator: s.designator,
		name: s.name,
		type: s.componentType,
		x: s.x,
		y: s.y,
		rotation: s.rotation,
		mirror: s.mirror || undefined,
		lcsc: s.supplierId || undefined,
		mpn: s.manufacturerId || undefined,
		net: s.net || undefined,
		device: s.component ? { libraryUuid: s.component.libraryUuid, uuid: s.component.uuid } : undefined,
	};
}

function pcbComponentBrief(c: any): any {
	const s = serialize(c) ?? {};
	return {
		id: s.primitiveId,
		designator: s.designator,
		name: s.name,
		layer: s.layer === 2 ? 'BOTTOM' : 'TOP',
		x: s.x,
		y: s.y,
		rotation: s.rotation,
		locked: s.primitiveLock || undefined,
		footprint: s.footprint?.name ?? s.footprint?.uuid,
		lcsc: s.supplierId || undefined,
	};
}

async function fileToResult(file: File | Blob | undefined, label: string, opts: { save?: boolean; preview?: boolean; fileName?: string }): Promise<any> {
	if (!file)
		throw new Error(`${label}生成失败（接口返回空），请确认当前文档内容完整`);
	const name = opts.fileName || (file as File).name || label;
	const out: any = { file: name, size: file.size, type: file.type };
	if (opts.save) {
		await callEda('sys_FileSystem.saveFile', file, name);
		out.saved = true;
	}
	if (opts.preview && /text|csv|json|xml|plain/i.test(file.type || name) || (opts.preview && /\.(csv|txt|net|json|xml|tel|asc)$/i.test(name))) {
		out.content = truncate(await blobToText(file), 12_000);
	}
	return out;
}

async function showImage(ctx: ToolContext, blob: Blob | undefined, caption: string): Promise<any> {
	if (!blob)
		throw new Error('获取图像失败');
	const raw = await blobToDataUrl(blob);
	const dataUrl = await downscaleImage(raw, 1600);
	if (ctx.vision)
		ctx.attachImage(dataUrl, caption);
	return {
		content: ctx.vision
			? `${caption}已获取，图像已附加在下一条消息中供你查看。`
			: `${caption}已获取并展示给用户。当前模型不支持识图，你无法看到图像内容，请改用结构化查询工具获取信息。`,
		display: { kind: 'image', src: dataUrl, caption },
	};
}

const READ_PREFIX = /^(get|is|has|search|list|check|help|count|find|query|text|toAsync|toSync)/;

// ———————————————————————— 交互与规划 ————————————————————————

const metaTools: ToolDef[] = [
	{
		name: 'ask_user',
		title: '询问用户',
		group: 'meta',
		risk: 'read',
		description: '当需求不明确、存在多个合理方案或需要用户做决定时，向用户提问并等待回答。可提供备选项。不要用它来确认已经明确的操作（权限系统会自动处理）。',
		parameters: S.obj({
			question: S.str('要询问的问题，简洁明确'),
			options: S.arr(S.str('选项'), '备选答案（2-6 个），用户可直接点选', { maxItems: 6 }),
			allow_free_text: S.bool('是否允许用户自由输入，默认 true'),
			multiple: S.bool('是否允许多选，默认 false'),
		}, ['question']),
		summarize: a => a.question,
		async run(a, ctx) {
			const answer = await ctx.askUser({ question: String(a.question), options: a.options, allowFreeText: a.allow_free_text !== false, multiple: !!a.multiple });
			return { content: { answer }, display: { kind: 'answer', question: String(a.question), answer } };
		},
	},
	{
		name: 'update_plan',
		title: '更新计划',
		group: 'meta',
		risk: 'read',
		description: '对于需要 3 步以上的任务，先制定计划并随进度更新。每次调用传入完整的步骤列表；同一时间只能有一个 in_progress。',
		parameters: S.obj({
			steps: S.arr(S.obj({
				title: S.str('步骤描述'),
				status: S.enum(['pending', 'in_progress', 'done'], '状态'),
			}, ['title', 'status']), '完整步骤列表'),
			note: S.str('补充说明（可选）'),
		}, ['steps']),
		summarize: a => `${(a.steps ?? []).filter((s: PlanStep) => s.status === 'done').length}/${(a.steps ?? []).length} 已完成`,
		async run(a, ctx) {
			const steps: PlanStep[] = (a.steps ?? []).map((s: any) => ({ title: String(s.title), status: s.status }));
			ctx.setPlan(steps, a.note);
			return { content: '计划已更新', display: { kind: 'plan', steps, note: a.note } };
		},
	},
	{
		name: 'eda_help',
		title: '查询 API 文档',
		group: 'meta',
		risk: 'read',
		description: '仅用于查询系统提示词手册未覆盖的冷门嘉立创EDA API。优先同时传 class_name 与 method_name 精确查询签名；不要为已有专用工具或手册已列出的接口调用本工具。无参数类列表仅在完全不知道类名时使用。',
		parameters: S.obj({
			class_name: S.str('类名或类实例名'),
			method_name: S.str('方法名'),
		}),
		summarize: a => [a.class_name, a.method_name].filter(Boolean).join('.') || '总览',
		async run(a) {
			const eda = getEda();
			const cls = a.class_name ? String(a.class_name).replace(/^eda\./, '') : '';
			const className = cls ? cls.replace(/^([a-z]{3})_/, (_m, p) => `${p.toUpperCase()}_`) : '';
			try {
				if (eda?.sys_Help?.help) {
					const r = className
						? await eda.sys_Help.help('eda', className, a.method_name || undefined)
						: await eda.sys_Help.help('eda');
					if (r && (typeof r !== 'object' || Object.keys(r).length))
						return r;
				}
			}
			catch {}
			if (!cls)
				return { classes: listEdaClasses() };
			const inst = cls.replace(/^([A-Z]{3})_/, (_m, p) => `${p.toLowerCase()}_`);
			return { class: inst, methods: listEdaMethods(inst), note: '运行时未提供详细文档，仅列出方法名' };
		},
	},
	{
		name: 'eda_call',
		title: '调用 EDA API',
		group: 'advanced',
		risk: a => READ_PREFIX.test(String(a?.path ?? '').split('.').pop() ?? '') ? 'read' : 'danger',
		description: '直接调用任意嘉立创EDA 扩展 API（eda.类实例名.方法名）。用于专用工具未覆盖的功能。参数按位置以数组传入，枚举请直接传其字符串/数字值。优先使用系统提示词中已注入的常用接口签名；仅手册未覆盖时才用 eda_help 精确查询。名称以 get/is/search 开头的方法视为只读，其它视为高风险写操作。',
		parameters: S.obj({
			path: S.str('如 sch_PrimitiveWire.getAll、pcb_Net.getNetLength'),
			args: S.arr({}, '按顺序传入的参数数组'),
		}, ['path']),
		summarize: a => `${a.path}(${a.args ? truncate(JSON.stringify(a.args), 60, false).slice(1, -1) : ''})`,
		async run(a, ctx) {
			const { className, method } = resolveEdaMethod(String(a.path));
			const r = await callEda(String(a.path), ...(Array.isArray(a.args) ? a.args : []));
			if (!READ_PREFIX.test(method)) {
				const id = idOf(r);
				const item: ChangeItem = /^create/.test(method) && id
					? { op: 'create', kind: className, primitiveId: id, label: `${className}.${method}` }
					: { op: 'other', kind: className, label: `${className}.${method}` };
				ctx.recordChange([item], { undoable: item.op === 'create', note: item.op === 'other' ? '通用 API 调用无法自动撤销，请使用 EDA 的撤销（Ctrl+Z）' : undefined });
			}
			if (typeof Blob !== 'undefined' && r instanceof Blob && /^image\//.test(r.type))
				return showImage(ctx, r, `${method} 返回的图像`);
			return r === undefined ? '执行完成（无返回值）' : r;
		},
	},
	{
		name: 'run_script',
		title: '运行脚本',
		group: 'advanced',
		risk: 'danger',
		description: '在 EDA 扩展环境中执行一段异步 JavaScript（可直接使用 eda 对象，支持 await），用于批量或复杂操作，例如循环放置、批量改属性。用 return 返回结果。改动无法自动撤销，仅在专用工具无法完成时使用。',
		parameters: S.obj({
			code: S.str('函数体代码，例如：const c = await eda.sch_PrimitiveComponent.getAll(); return c.length;'),
			purpose: S.str('一句话说明脚本目的（展示给用户）'),
		}, ['code', 'purpose']),
		summarize: a => a.purpose,
		async run(a, ctx) {
			const eda = getEda();
			if (!eda)
				throw new Error('EDA 运行环境不可用');
			// eslint-disable-next-line no-new-func
			const AsyncFn = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => (...a: any[]) => Promise<any>;
			const fn = new AsyncFn('eda', 'signal', String(a.code));
			const r = await fn(eda, ctx.signal);
			ctx.recordChange([{ op: 'other', kind: 'script', label: String(a.purpose) }], { undoable: false, note: '脚本改动请使用 EDA 的撤销（Ctrl+Z）' });
			return r === undefined ? '脚本执行完成（无返回值）' : r;
		},
	},
];

// ———————————————————————— 工程与文档 ————————————————————————

const projectTools: ToolDef[] = [
	{
		name: 'get_editor_context',
		title: '读取编辑器状态',
		group: 'project',
		risk: 'read',
		description: '获取当前工程、活动文档、文档类型、选中图元、EDA 版本与主题。上下文可能已过期时调用。',
		parameters: S.obj({}),
		async run(_a, ctx) {
			return ctx.editor;
		},
	},
	{
		name: 'list_documents',
		title: '列出工程文档',
		group: 'project',
		risk: 'read',
		description: '列出当前工程中的板子、原理图（含全部图页）与 PCB，返回各自 UUID，可用于 open_document。',
		parameters: S.obj({}),
		async run() {
			const [project, boards, schs, pcbs] = await Promise.all([
				callEda('dmt_Project.getCurrentProjectInfo').catch(() => undefined),
				callEda<any[]>('dmt_Board.getAllBoardsInfo').catch(() => []),
				callEda<any[]>('dmt_Schematic.getAllSchematicsInfo').catch(() => []),
				callEda<any[]>('dmt_Pcb.getAllPcbsInfo').catch(() => []),
			]);
			if (!project)
				throw new Error('当前没有打开的工程');
			return {
				project: { uuid: project.uuid, name: project.friendlyName ?? project.name, description: project.description },
				boards: (boards ?? []).map(b => ({ name: b.name, schematic: b.schematic?.uuid, pcb: b.pcb?.uuid })),
				schematics: (schs ?? []).map(s => ({ uuid: s.uuid, name: s.name, board: s.parentBoardName, pages: (s.page ?? []).map((p: any) => ({ uuid: p.uuid, name: p.name })) })),
				pcbs: (pcbs ?? []).map(p => ({ uuid: p.uuid, name: p.name, board: p.parentBoardName })),
			};
		},
	},
	{
		name: 'open_document',
		title: '打开文档',
		group: 'project',
		risk: 'read',
		description: '在编辑器中打开指定文档（原理图图页 UUID 或 PCB UUID）并切换为活动标签页。打开后可用的工具会随文档类型变化。',
		parameters: S.obj({ uuid: S.str('原理图图页或 PCB 的 UUID') }, ['uuid']),
		summarize: a => a.uuid,
		async run(a) {
			const tabId = await callEda<string>('dmt_EditorControl.openDocument', String(a.uuid));
			if (!tabId)
				throw new Error('打开失败，请确认 UUID 是原理图图页或 PCB（不是原理图本身）');
			await callEda('dmt_EditorControl.activateDocument', tabId).catch(() => {});
			return { opened: true, tabId };
		},
	},
	{
		name: 'save_document',
		title: '保存文档',
		group: 'project',
		risk: 'write',
		description: '保存当前活动的原理图或 PCB 文档。',
		parameters: S.obj({}),
		async run(_a, ctx) {
			const cls = ctx.editor.scene === 'pcb' ? 'pcb_Document' : ctx.editor.scene === 'sch' ? 'sch_Document' : '';
			if (!cls)
				throw new Error('当前文档不是原理图或 PCB');
			const ok = await callEda<boolean>(`${cls}.save`);
			return { saved: !!ok };
		},
	},
	{
		name: 'create_document',
		title: '新建文档',
		group: 'project',
		risk: 'write',
		description: '在当前工程中新建原理图图页、原理图、PCB 或板子（板子 = 一对原理图 + PCB）。',
		parameters: S.obj({
			type: S.enum(['schematic_page', 'schematic', 'pcb', 'board'], '文档类型'),
			schematic_uuid: S.str('新建图页时所属原理图 UUID'),
			board_name: S.str('新建原理图/PCB 时所属板子名称（可选）'),
			name: S.str('新文档名称（可选）'),
		}, ['type']),
		summarize: a => `${a.type}${a.name ? ` · ${a.name}` : ''}`,
		async run(a, ctx) {
			let uuid: string | undefined;
			switch (a.type) {
				case 'schematic_page': {
					let sch = a.schematic_uuid;
					if (!sch) {
						const cur = await callEda('dmt_Schematic.getCurrentSchematicInfo').catch(() => undefined);
						sch = cur?.uuid ?? (await callEda<any[]>('dmt_Schematic.getAllSchematicsInfo'))?.[0]?.uuid;
					}
					if (!sch)
						throw new Error('未找到原理图，请先新建原理图');
					uuid = await callEda('dmt_Schematic.createSchematicPage', sch);
					if (uuid && a.name)
						await callEda('dmt_Schematic.modifySchematicPageName', uuid, String(a.name)).catch(() => {});
					break;
				}
				case 'schematic':
					uuid = await callEda('dmt_Schematic.createSchematic', a.board_name || undefined);
					if (uuid && a.name)
						await callEda('dmt_Schematic.modifySchematicName', uuid, String(a.name)).catch(() => {});
					break;
				case 'pcb':
					uuid = await callEda('dmt_Pcb.createPcb', a.board_name || undefined);
					if (uuid && a.name)
						await callEda('dmt_Pcb.modifyPcbName', uuid, String(a.name)).catch(() => {});
					break;
				case 'board':
					uuid = await callEda('dmt_Board.createBoard');
					break;
			}
			if (!uuid)
				throw new Error('新建失败');
			ctx.recordChange([{ op: 'other', kind: 'dmt', label: `新建 ${a.type}` }], { undoable: false, note: '新建文档可在工程树中手动删除' });
			return { created: a.type, uuid };
		},
	},
];

// ———————————————————————— 视图与选择 ————————————————————————

const viewTools: ToolDef[] = [
	{
		name: 'view_screenshot',
		title: '查看画布',
		group: 'view',
		risk: 'read',
		description: '截取当前画布可见区域的图像。识图模型可借此理解布局与连接；可先用 zoom_view 调整视野。',
		parameters: S.obj({ fit_all: S.bool('截图前先缩放到显示全部图元') }),
		async run(a, ctx) {
			if (a.fit_all)
				await callEda('dmt_EditorControl.zoomToAllPrimitives').catch(() => {});
			const blob = await callEda<Blob>('dmt_EditorControl.getCurrentRenderedAreaImage');
			return showImage(ctx, blob, '画布截图');
		},
	},
	{
		name: 'zoom_view',
		title: '调整视野',
		group: 'view',
		risk: 'read',
		description: '调整画布视野：all = 显示全部；selection = 缩放到选中；region = 缩放到矩形区域；point = 定位到坐标。',
		parameters: S.obj({
			mode: S.enum(['all', 'selection', 'region', 'point', 'board'], '模式（board 仅 PCB：缩放到板框）'),
			left: S.num('区域左'),
			right: S.num('区域右'),
			top: S.num('区域上'),
			bottom: S.num('区域下'),
			x: S.num('坐标 X'),
			y: S.num('坐标 Y'),
		}, ['mode']),
		summarize: a => a.mode,
		async run(a, ctx) {
			const pcb = ctx.editor.scene === 'pcb';
			switch (a.mode) {
				case 'all': return callEda('dmt_EditorControl.zoomToAllPrimitives');
				case 'selection': return callEda('dmt_EditorControl.zoomToSelectedPrimitives');
				case 'board': return callEda('pcb_Document.zoomToBoardOutline');
				case 'region':
					return callEda(pcb ? 'pcb_Document.navigateToRegion' : 'sch_Document.navigateToRegion', a.left, a.right, a.top, a.bottom);
				case 'point':
					return callEda(pcb ? 'pcb_Document.navigateToCoordinates' : 'sch_Document.navigateToCoordinates', a.x, a.y);
			}
			throw new Error('未知模式');
		},
	},
	{
		name: 'get_selection',
		title: '读取选中图元',
		group: 'view',
		risk: 'read',
		scenes: ['sch', 'pcb'],
		description: '获取用户当前在画布上选中的图元及其完整属性。用户说「这个」「选中的」时调用。',
		parameters: S.obj({}),
		async run(_a, ctx) {
			const cls = ctx.editor.scene === 'pcb' ? 'pcb_SelectControl' : 'sch_SelectControl';
			const list = await callEda<any[]>(`${cls}.getAllSelectedPrimitives`);
			return brief(list ?? [], 60, x => serialize(x));
		},
	},
	{
		name: 'select_primitives',
		title: '选中图元',
		group: 'view',
		risk: 'read',
		scenes: ['sch', 'pcb'],
		description: '在画布上选中指定图元（便于向用户展示），或清空选择。也可按位号/网络进行交叉探测高亮。',
		parameters: S.obj({
			ids: S.arr(S.str('图元 ID'), '要选中的图元 ID'),
			designators: S.arr(S.str('位号'), '按位号选中器件，例如 ["R1","U2"]'),
			nets: S.arr(S.str('网络'), '按网络高亮选中'),
			clear: S.bool('先清空现有选择'),
			zoom: S.bool('选中后缩放到选中区域'),
		}),
		summarize: a => [...(a.ids ?? []), ...(a.designators ?? []), ...(a.nets ?? [])].slice(0, 6).join(', ') || '清空选择',
		async run(a, ctx) {
			const cls = ctx.editor.scene === 'pcb' ? 'pcb_SelectControl' : 'sch_SelectControl';
			if (a.clear || (!a.ids?.length && !a.designators?.length && !a.nets?.length))
				await callEda(`${cls}.clearSelected`);
			if (a.ids?.length)
				await callEda(`${cls}.doSelectPrimitives`, ids(a.ids));
			if (a.designators?.length || a.nets?.length)
				await callEda(`${cls}.doCrossProbeSelect`, a.designators ?? [], [], a.nets ?? [], true, true);
			if (a.zoom)
				await callEda('dmt_EditorControl.zoomToSelectedPrimitives').catch(() => {});
			return '已更新选择';
		},
	},
	{
		name: 'mark_points',
		title: '标记位置',
		group: 'view',
		risk: 'read',
		description: '在画布上绘制临时指示标记（点、圆、线、矩形），用于向用户指出问题位置；不修改设计。clear=true 清除所有标记。',
		parameters: S.obj({
			markers: S.arr(S.obj({
				type: S.enum(['point', 'circle', 'line', 'rectangle'], '标记类型'),
				x: S.num('点/圆心 X'),
				y: S.num('点/圆心 Y'),
				r: S.num('半径'),
				startX: S.num('线起点 X'),
				startY: S.num('线起点 Y'),
				endX: S.num('线终点 X'),
				endY: S.num('线终点 Y'),
				top: S.num('矩形上'),
				bottom: S.num('矩形下'),
				left: S.num('矩形左'),
				right: S.num('矩形右'),
			}, ['type']), '标记列表'),
			color: S.str('颜色 #RRGGBB，默认红色'),
			zoom: S.bool('是否缩放到标记'),
			clear: S.bool('清除全部标记'),
		}),
		summarize: a => a.clear ? '清除标记' : `${a.markers?.length ?? 0} 个标记`,
		async run(a) {
			if (a.clear || !a.markers?.length)
				return callEda('dmt_EditorControl.removeIndicatorMarkers');
			const hex = /^#?([0-9a-f]{6})$/i.exec(a.color ?? '')?.[1] ?? 'ff3b30';
			const color = { r: Number.parseInt(hex.slice(0, 2), 16), g: Number.parseInt(hex.slice(2, 4), 16), b: Number.parseInt(hex.slice(4, 6), 16), alpha: 1 };
			return callEda('dmt_EditorControl.generateIndicatorMarkers', a.markers, color, 2, a.zoom !== false);
		},
	},
];

// ———————————————————————— 原理图 ————————————————————————

const schTools: ToolDef[] = [
	{
		name: 'sch_list_components',
		title: '列出器件',
		group: 'sch',
		risk: 'read',
		scenes: ['sch'],
		description: '列出原理图中的器件（位号、名称、坐标、LCSC 编号、库引用）。可只看当前图页或全部图页，可按位号/名称过滤。',
		parameters: S.obj({
			all_pages: S.bool('包含全部图页，默认仅当前图页'),
			filter: S.str('按位号或名称过滤（子串，不区分大小写）'),
			include_flags: S.bool('包含电源/地/网络端口等标识，默认 false'),
			limit: S.int('最多返回条数，默认 200'),
		}),
		summarize: a => [a.all_pages ? '全部图页' : '当前图页', a.filter].filter(Boolean).join(' · '),
		async run(a) {
			const list = await callEda<any[]>('sch_PrimitiveComponent.getAll', a.include_flags ? undefined : 'part', !!a.all_pages);
			let items = (list ?? []).map(schComponentBrief);
			if (a.filter) {
				const f = String(a.filter).toLowerCase();
				items = items.filter(c => `${c.designator ?? ''} ${c.name ?? ''}`.toLowerCase().includes(f));
			}
			return brief(items, Number(a.limit) || 200, x => x);
		},
	},
	{
		name: 'sch_get_component',
		title: '器件详情',
		group: 'sch',
		risk: 'read',
		scenes: ['sch'],
		description: '获取器件的完整属性和全部引脚（引脚编号、名称、坐标、电气类型），连线前必须先查询引脚坐标。可传 ID 或位号。',
		parameters: S.obj({
			id: S.str('器件图元 ID'),
			designator: S.str('位号，例如 U1'),
		}),
		summarize: a => a.designator || a.id,
		async run(a) {
			let id = a.id;
			if (!id && a.designator) {
				const all = await callEda<any[]>('sch_PrimitiveComponent.getAll', undefined, true);
				const hit = (all ?? []).find(c => String(c.getState_Designator?.() ?? '').toUpperCase() === String(a.designator).toUpperCase());
				id = idOf(hit);
			}
			if (!id)
				throw new Error('未找到该器件，请先用 sch_list_components 确认位号');
			const [c, pins] = await Promise.all([
				callEda('sch_PrimitiveComponent.get', id),
				callEda<any[]>('sch_PrimitiveComponent.getAllPinsByPrimitiveId', id),
			]);
			if (!c)
				throw new Error(`器件 ${id} 不存在`);
			return {
				component: serialize(c),
				pins: (pins ?? []).map((p) => {
					const s = serialize(p) ?? {};
					return { id: s.primitiveId, number: s.pinNumber, name: s.pinName, x: s.x, y: s.y, rotation: s.rotation, type: s.pinType, noConnected: s.noConnected || undefined };
				}),
			};
		},
	},
	{
		name: 'sch_list_nets',
		title: '列出网络',
		group: 'sch',
		risk: 'read',
		scenes: ['sch'],
		description: '列出原理图网络。detail=true 时返回网表（每个器件引脚所连网络），用于分析连接关系与检查电路。',
		parameters: S.obj({
			detail: S.bool('返回完整网表'),
			net: S.str('只查看某个网络的导线'),
		}),
		summarize: a => a.net || (a.detail ? '完整网表' : '网络名'),
		async run(a) {
			if (a.net) {
				const n = await callEda('sch_Net.getNet', String(a.net));
				if (!n)
					throw new Error(`网络 ${a.net} 不存在`);
				return n;
			}
			if (a.detail) {
				const netlist = await callEda<string>('sch_Netlist.getNetlist', 'JLCEDA').catch(() => callEda<string>('sch_Netlist.getNetlist'));
				return truncate(typeof netlist === 'string' ? netlist : JSON.stringify(netlist), 13_000);
			}
			const names = await callEda<string[]>('sch_Net.getAllNetsName');
			return { count: names?.length ?? 0, nets: names };
		},
	},
	{
		name: 'sch_query_region',
		title: '区域查询',
		group: 'sch',
		risk: 'read',
		scenes: ['sch'],
		description: '查询矩形区域内的全部图元，用于寻找空白位置或查看局部内容。',
		parameters: S.obj({ left: S.num('左'), right: S.num('右'), top: S.num('上（Y 较大）'), bottom: S.num('下（Y 较小）') }, ['left', 'right', 'top', 'bottom']),
		async run(a) {
			const list = await callEda<any[]>('sch_Document.getPrimitivesInRegion', a.left, a.right, a.top, a.bottom);
			return brief(list ?? [], 80, x => serialize(x));
		},
	},
	{
		name: 'sch_place_component',
		title: '放置器件',
		group: 'sch',
		risk: 'write',
		scenes: ['sch'],
		description: '在原理图中放置器件。device 需来自 lib_search_device / lib_get_by_lcsc 返回的 { libraryUuid, uuid }。坐标单位 10mil，建议放在 100 的整数倍附近并互不重叠。可同时设置位号。',
		parameters: S.obj({
			library_uuid: S.str('器件所在库 UUID'),
			device_uuid: S.str('器件 UUID'),
			x: S.num('X（10mil）'),
			y: S.num('Y（10mil）'),
			rotation: S.enum([0, 90, 180, 270], '旋转角度'),
			mirror: S.bool('是否镜像'),
			sub_part: S.str('多部件器件的子部件名（可选）'),
			designator: S.str('位号（可选，不填自动分配）'),
		}, ['library_uuid', 'device_uuid', 'x', 'y']),
		summarize: a => `${a.designator ?? ''} @ (${a.x}, ${a.y})`,
		async run(a, ctx) {
			requireScene(ctx, 'sch');
			const c = await callEda('sch_PrimitiveComponent.create', { libraryUuid: a.library_uuid, uuid: a.device_uuid }, a.x, a.y, a.sub_part || undefined, a.rotation ?? 0, !!a.mirror);
			const id = created(ctx, 'sch_PrimitiveComponent', c, `放置器件${a.designator ? ` ${a.designator}` : ''}`);
			if (a.designator)
				await callEda('sch_PrimitiveComponent.modify', id, { designator: String(a.designator) }).catch(() => {});
			const pins = await callEda<any[]>('sch_PrimitiveComponent.getAllPinsByPrimitiveId', id).catch(() => []);
			return {
				id,
				component: schComponentBrief(await callEda('sch_PrimitiveComponent.get', id) ?? c),
				pins: (pins ?? []).map((p) => {
					const s = serialize(p) ?? {};
					return { number: s.pinNumber, name: s.pinName, x: s.x, y: s.y };
				}),
			};
		},
	},
	{
		name: 'sch_place_net_flag',
		title: '放置网络标识',
		group: 'sch',
		risk: 'write',
		scenes: ['sch'],
		description: '放置电源/地符号、网络端口或网络标签。同名网络标识自动电气相连，可代替长导线。放置后用 sch_create_wire 把标识与引脚连起来，或直接把标识放在引脚端点上。',
		parameters: S.obj({
			kind: S.enum(['power', 'ground', 'analog_ground', 'protect_ground', 'port_in', 'port_out', 'port_bi', 'label'], '类型'),
			net: S.str('网络名，例如 VCC、3V3、GND、SDA'),
			x: S.num('X'),
			y: S.num('Y'),
			rotation: S.enum([0, 90, 180, 270], '旋转'),
		}, ['kind', 'net', 'x', 'y']),
		summarize: a => `${a.kind} ${a.net} @ (${a.x}, ${a.y})`,
		async run(a, ctx) {
			requireScene(ctx, 'sch');
			const flagMap: Record<string, string> = { power: 'Power', ground: 'Ground', analog_ground: 'AnalogGround', protect_ground: 'ProtectGround' };
			const portMap: Record<string, string> = { port_in: 'IN', port_out: 'OUT', port_bi: 'BI' };
			let p: any;
			let kind = 'sch_PrimitiveComponent';
			if (flagMap[a.kind])
				p = await callEda('sch_PrimitiveComponent.createNetFlag', flagMap[a.kind], String(a.net), a.x, a.y, a.rotation ?? 0, false);
			else if (portMap[a.kind])
				p = await callEda('sch_PrimitiveComponent.createNetPort', portMap[a.kind], String(a.net), a.x, a.y, a.rotation ?? 0, false);
			else {
				p = await callEda('sch_PrimitiveAttribute.createNetLabel', a.x, a.y, String(a.net));
				kind = 'sch_PrimitiveAttribute';
			}
			return { id: created(ctx, kind, p, `${a.kind} ${a.net}`) };
		},
	},
	{
		name: 'sch_create_wire',
		title: '绘制导线',
		group: 'sch',
		risk: 'write',
		scenes: ['sch'],
		description: '绘制导线连接引脚。points 为折线顶点 [[x1,y1],[x2,y2],...]，端点必须精确落在引脚端点坐标上才会电气连接；建议只用水平/垂直线段。可一次创建多条（wires）。',
		parameters: S.obj({
			wires: S.arr(S.obj({
				points: S.arr(S.point(), '顶点列表，至少 2 个', { minItems: 2 }),
				net: S.str('网络名（可选）'),
			}, ['points']), '导线列表'),
		}, ['wires']),
		summarize: a => `${a.wires?.length ?? 0} 条导线`,
		async run(a, ctx) {
			requireScene(ctx, 'sch');
			const out: string[] = [];
			const items: ChangeItem[] = [];
			const errors: string[] = [];
			for (const [i, w] of (a.wires ?? []).entries()) {
				const flat = (w.points ?? []).flat().map(Number);
				if (flat.length < 4 || flat.some(Number.isNaN)) {
					errors.push(`第 ${i + 1} 条：顶点无效`);
					continue;
				}
				try {
					const p = await callEda('sch_PrimitiveWire.create', flat, w.net || undefined);
					const id = idOf(p);
					if (!id)
						throw new Error('接口返回空');
					out.push(id);
					items.push({ op: 'create', kind: 'sch_PrimitiveWire', primitiveId: id, label: `导线${w.net ? ` ${w.net}` : ''}`, after: serialize(p) });
				}
				catch (e) {
					errors.push(`第 ${i + 1} 条：${errorMessage(e)}`);
				}
			}
			if (items.length)
				ctx.recordChange(items);
			if (!out.length)
				throw new Error(errors.join('；') || '未创建任何导线');
			return { created: out, errors: errors.length ? errors : undefined };
		},
	},
	{
		name: 'sch_create_text',
		title: '添加文本',
		group: 'sch',
		risk: 'write',
		scenes: ['sch'],
		description: '在原理图上添加说明文本。',
		parameters: S.obj({
			x: S.num('X'),
			y: S.num('Y'),
			text: S.str('文本内容'),
			font_size: S.num('字号（可选）'),
			color: S.str('颜色 #RRGGBB（可选）'),
			rotation: S.enum([0, 90, 180, 270], '旋转'),
		}, ['x', 'y', 'text']),
		summarize: a => truncate(String(a.text), 40, false),
		async run(a, ctx) {
			requireScene(ctx, 'sch');
			const p = await callEda('sch_PrimitiveText.create', a.x, a.y, String(a.text), a.rotation ?? 0, a.color ?? null, null, a.font_size ?? null);
			return { id: created(ctx, 'sch_PrimitiveText', p, '文本') };
		},
	},
	{
		name: 'sch_draw_shape',
		title: '绘制图形',
		group: 'sch',
		risk: 'write',
		scenes: ['sch'],
		description: '在原理图上绘制非电气图形：rectangle（左上角 x,y + 宽高）、circle（圆心+半径）、polyline（顶点）。用于分区框、功能块标注。',
		parameters: S.obj({
			shape: S.enum(['rectangle', 'circle', 'polyline'], '形状'),
			x: S.num('矩形左上 X / 圆心 X'),
			y: S.num('矩形左上 Y / 圆心 Y'),
			width: S.num('矩形宽'),
			height: S.num('矩形高'),
			radius: S.num('圆半径'),
			points: S.arr(S.point(), '折线顶点'),
			color: S.str('线条颜色 #RRGGBB'),
		}, ['shape']),
		summarize: a => a.shape,
		async run(a, ctx) {
			requireScene(ctx, 'sch');
			let p: any;
			let kind: string;
			if (a.shape === 'rectangle') {
				kind = 'sch_PrimitiveRectangle';
				p = await callEda(`${kind}.create`, a.x, a.y, a.width, a.height, 0, 0, a.color ?? null);
			}
			else if (a.shape === 'circle') {
				kind = 'sch_PrimitiveCircle';
				p = await callEda(`${kind}.create`, a.x, a.y, a.radius, a.color ?? null);
			}
			else {
				kind = 'sch_PrimitivePolygon';
				p = await callEda(`${kind}.create`, (a.points ?? []).flat().map(Number), a.color ?? null);
			}
			return { id: created(ctx, kind, p, a.shape) };
		},
	},
	{
		name: 'sch_modify_component',
		title: '修改器件',
		group: 'sch',
		risk: 'write',
		scenes: ['sch'],
		description: '修改原理图器件的位置、旋转、镜像、位号、名称、LCSC 编号、制造商料号或自定义属性。只传需要改的字段。',
		parameters: S.obj({
			id: S.str('器件图元 ID'),
			x: S.num('新 X'),
			y: S.num('新 Y'),
			rotation: S.enum([0, 90, 180, 270], '旋转'),
			mirror: S.bool('镜像'),
			designator: S.str('位号'),
			name: S.str('名称/值，如 10k'),
			supplier_id: S.str('供应商编号（LCSC，例如 C25804）'),
			manufacturer_id: S.str('制造商料号'),
			add_into_bom: S.bool('是否加入 BOM'),
			other_property: { type: 'object', description: '其它自定义属性键值', additionalProperties: true },
		}, ['id']),
		summarize: a => `${a.id}${a.designator ? ` → ${a.designator}` : ''}`,
		async run(a, ctx) {
			requireScene(ctx, 'sch');
			return modifyTracked(ctx, 'sch_PrimitiveComponent', String(a.id), {
				x: a.x,
				y: a.y,
				rotation: a.rotation,
				mirror: a.mirror,
				designator: a.designator,
				name: a.name,
				supplierId: a.supplier_id,
				manufacturerId: a.manufacturer_id,
				addIntoBom: a.add_into_bom,
				otherProperty: a.other_property,
			}, '修改器件');
		},
	},
	{
		name: 'sch_delete',
		title: '删除图元',
		group: 'sch',
		risk: 'danger',
		scenes: ['sch'],
		description: '删除原理图图元（器件、导线、文本等，按 ID，自动识别类型）。',
		parameters: S.obj({ ids: S.arr(S.str('图元 ID'), '要删除的图元 ID 列表') }, ['ids']),
		summarize: a => `${a.ids?.length ?? 0} 个图元`,
		async run(a, ctx) {
			requireScene(ctx, 'sch');
			const groups = await groupByType('sch', ids(a.ids));
			let n = 0;
			for (const [kind, list] of groups)
				n += (await deleteTracked(ctx, kind, list, '删除')).deleted;
			return { deleted: n };
		},
	},
	{
		name: 'sch_drc',
		title: '原理图 DRC',
		group: 'sch',
		risk: 'read',
		scenes: ['sch'],
		description: '运行原理图电气规则检查，返回错误列表（规则、级别、涉及图元与网络）。',
		parameters: S.obj({ strict: S.bool('严格模式') }),
		async run(a) {
			const r = await callEda<any[]>('sch_Drc.check', !!a.strict, false, true);
			if (!Array.isArray(r))
				return { passed: !!r };
			return { passed: r.length === 0, ...brief(r, 80, x => x) };
		},
	},
	{
		name: 'sch_auto_arrange',
		title: '自动布局/布线',
		group: 'sch',
		risk: 'danger',
		scenes: ['sch'],
		description: '对原理图执行自动布局（layout）或自动连线（routing），可限定器件 ID。会大范围改动图纸。',
		parameters: S.obj({
			action: S.enum(['layout', 'routing'], '操作'),
			ids: S.arr(S.str('器件 ID'), '限定范围（可选）'),
		}, ['action']),
		summarize: a => a.action,
		async run(a, ctx) {
			requireScene(ctx, 'sch');
			const props = a.ids?.length ? { uuids: ids(a.ids) } : undefined;
			const r = await callEda(a.action === 'layout' ? 'sch_Document.autoLayout' : 'sch_Document.autoRouting', props);
			ctx.recordChange([{ op: 'other', kind: 'sch_Document', label: a.action === 'layout' ? '自动布局' : '自动布线' }], { undoable: false, note: '请使用 EDA 的撤销（Ctrl+Z）恢复' });
			return r ?? '完成';
		},
	},
	{
		name: 'sch_import_changes',
		title: '从 PCB 导入变更',
		group: 'sch',
		risk: 'write',
		scenes: ['sch'],
		description: '将 PCB 的变更反向同步到原理图。',
		parameters: S.obj({}),
		async run(_a, ctx) {
			const ok = await callEda('sch_Document.importChanges');
			ctx.recordChange([{ op: 'other', kind: 'sch_Document', label: '导入 PCB 变更' }], { undoable: false });
			return { ok: !!ok };
		},
	},
];

// ———————————————————————— PCB ————————————————————————

const pcbTools: ToolDef[] = [
	{
		name: 'pcb_list_components',
		title: '列出器件',
		group: 'pcb',
		risk: 'read',
		scenes: ['pcb'],
		description: '列出 PCB 器件（位号、层、坐标 mil、旋转、封装、是否锁定）。',
		parameters: S.obj({
			layer: S.enum(['TOP', 'BOTTOM'], '只看某层（可选）'),
			filter: S.str('按位号或名称过滤'),
			limit: S.int('最多返回条数，默认 300'),
		}),
		summarize: a => [a.layer, a.filter].filter(Boolean).join(' · ') || '全部',
		async run(a) {
			const list = await callEda<any[]>('pcb_PrimitiveComponent.getAll', a.layer ? layerId(a.layer) : undefined);
			let items = (list ?? []).map(pcbComponentBrief);
			if (a.filter) {
				const f = String(a.filter).toLowerCase();
				items = items.filter(c => `${c.designator ?? ''} ${c.name ?? ''}`.toLowerCase().includes(f));
			}
			return brief(items, Number(a.limit) || 300, x => x);
		},
	},
	{
		name: 'pcb_get_component',
		title: '器件详情',
		group: 'pcb',
		risk: 'read',
		scenes: ['pcb'],
		description: '获取 PCB 器件完整属性与全部焊盘（编号、坐标、网络）。可传 ID 或位号。',
		parameters: S.obj({ id: S.str('器件 ID'), designator: S.str('位号') }),
		summarize: a => a.designator || a.id,
		async run(a) {
			let id = a.id;
			if (!id && a.designator) {
				const all = await callEda<any[]>('pcb_PrimitiveComponent.getAll');
				id = idOf((all ?? []).find(c => String(c.getState_Designator?.() ?? '').toUpperCase() === String(a.designator).toUpperCase()));
			}
			if (!id)
				throw new Error('未找到该器件');
			const [c, pads] = await Promise.all([
				callEda('pcb_PrimitiveComponent.get', id),
				callEda<any[]>('pcb_PrimitiveComponent.getAllPinsByPrimitiveId', id),
			]);
			return {
				component: serialize(c),
				pads: (pads ?? []).map((p) => {
					const s = serialize(p) ?? {};
					return { id: s.primitiveId, number: s.padNumber, x: s.x, y: s.y, net: s.net, layer: s.layer };
				}),
			};
		},
	},
	{
		name: 'pcb_list_nets',
		title: '网络信息',
		group: 'pcb',
		risk: 'read',
		scenes: ['pcb'],
		description: '列出 PCB 网络及布线长度；传 net 时返回该网络的长度与全部图元（导线、过孔、焊盘）。',
		parameters: S.obj({ net: S.str('网络名（可选）') }),
		summarize: a => a.net || '全部网络',
		async run(a) {
			if (a.net) {
				const [info, prims] = await Promise.all([
					callEda('pcb_Net.getNet', String(a.net)),
					callEda<any[]>('pcb_Net.getAllPrimitivesByNet', String(a.net)),
				]);
				if (!info)
					throw new Error(`网络 ${a.net} 不存在`);
				return { info, primitives: brief(prims ?? [], 120, x => serialize(x)) };
			}
			const nets = await callEda<any[]>('pcb_Net.getAllNets');
			return brief(nets ?? [], 400, n => ({ net: n.net, length: n.length }));
		},
	},
	{
		name: 'pcb_get_layers',
		title: '图层信息',
		group: 'pcb',
		risk: 'read',
		scenes: ['pcb'],
		description: '获取铜层数与全部图层（ID、名称、类型、可见状态）。',
		parameters: S.obj({}),
		async run() {
			const [count, layers] = await Promise.all([
				callEda('pcb_Layer.getTheNumberOfCopperLayers').catch(() => undefined),
				callEda<any[]>('pcb_Layer.getAllLayers'),
			]);
			return {
				copperLayers: count,
				layers: (layers ?? []).filter(l => l.layerStatus !== 0).map(l => ({ id: l.id, name: l.name, type: l.type, visible: l.layerStatus === 1, locked: l.locked || undefined })),
			};
		},
	},
	{
		name: 'pcb_set_layer',
		title: '图层设置',
		group: 'pcb',
		risk: a => a.copper_layers ? 'danger' : 'read',
		scenes: ['pcb'],
		description: '切换当前图层、显示/隐藏图层（可只显示指定层），或修改铜层数（高风险）。',
		parameters: S.obj({
			active: LAYER_PARAM,
			show: S.arr(S.any('图层'), '要显示的图层'),
			hide: S.arr(S.any('图层'), '要隐藏的图层'),
			only: S.bool('与 show 搭配：隐藏其它层'),
			copper_layers: S.enum([2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32], '设置铜层数'),
		}),
		async run(a, ctx) {
			const done: string[] = [];
			if (a.active !== undefined) {
				await callEda('pcb_Layer.selectLayer', layerId(a.active));
				done.push('已切换当前层');
			}
			if (a.show?.length) {
				await callEda('pcb_Layer.setLayerVisible', a.show.map((l: any) => layerId(l)), !!a.only);
				done.push('已显示图层');
			}
			if (a.hide?.length) {
				await callEda('pcb_Layer.setLayerInvisible', a.hide.map((l: any) => layerId(l)), false);
				done.push('已隐藏图层');
			}
			if (a.copper_layers) {
				await callEda('pcb_Layer.setTheNumberOfCopperLayers', a.copper_layers);
				ctx.recordChange([{ op: 'other', kind: 'pcb_Layer', label: `铜层数 → ${a.copper_layers}` }], { undoable: false });
				done.push(`铜层数已设为 ${a.copper_layers}`);
			}
			return done.join('；') || '无操作';
		},
	},
	{
		name: 'pcb_query_region',
		title: '区域查询',
		group: 'pcb',
		risk: 'read',
		scenes: ['pcb'],
		description: '查询 PCB 矩形区域内的全部图元（mil）。',
		parameters: S.obj({ left: S.num('左'), right: S.num('右'), top: S.num('上'), bottom: S.num('下') }, ['left', 'right', 'top', 'bottom']),
		async run(a) {
			const list = await callEda<any[]>('pcb_Document.getPrimitivesInRegion', a.left, a.right, a.top, a.bottom);
			return brief(list ?? [], 80, x => serialize(x));
		},
	},
	{
		name: 'pcb_move_component',
		title: '移动器件',
		group: 'pcb',
		risk: 'write',
		scenes: ['pcb'],
		description: '移动/旋转/换层/锁定 PCB 器件，支持批量。坐标单位 mil。',
		parameters: S.obj({
			items: S.arr(S.obj({
				id: S.str('器件 ID'),
				x: S.num('X（mil）'),
				y: S.num('Y（mil）'),
				rotation: S.num('旋转角度'),
				layer: S.enum(['TOP', 'BOTTOM'], '放置层'),
				locked: S.bool('锁定'),
			}, ['id']), '要修改的器件'),
		}, ['items']),
		summarize: a => `${a.items?.length ?? 0} 个器件`,
		async run(a, ctx) {
			requireScene(ctx, 'pcb');
			const out: any[] = [];
			for (const it of a.items ?? []) {
				out.push(await modifyTracked(ctx, 'pcb_PrimitiveComponent', String(it.id), {
					x: it.x,
					y: it.y,
					rotation: it.rotation,
					layer: it.layer ? layerId(it.layer) : undefined,
					primitiveLock: it.locked,
				}, '移动器件').then(pcbComponentBrief).catch(e => ({ id: it.id, error: errorMessage(e) })));
			}
			return out;
		},
	},
	{
		name: 'pcb_place_component',
		title: '放置器件',
		group: 'pcb',
		risk: 'write',
		scenes: ['pcb'],
		description: '直接在 PCB 上放置器件或封装（通常应在原理图放置后用 pcb_import_changes 同步）。',
		parameters: S.obj({
			library_uuid: S.str('库 UUID'),
			uuid: S.str('器件或封装 UUID'),
			is_footprint: S.bool('uuid 是封装而非器件'),
			layer: S.enum(['TOP', 'BOTTOM'], '层'),
			x: S.num('X（mil）'),
			y: S.num('Y（mil）'),
			rotation: S.num('旋转'),
		}, ['library_uuid', 'uuid', 'x', 'y']),
		async run(a, ctx) {
			requireScene(ctx, 'pcb');
			const ref: any = { libraryUuid: a.library_uuid, uuid: a.uuid };
			if (a.is_footprint)
				ref.libraryType = '4';
			const p = await callEda('pcb_PrimitiveComponent.create', ref, layerId(a.layer ?? 'TOP'), a.x, a.y, a.rotation ?? 0, false);
			return { id: created(ctx, 'pcb_PrimitiveComponent', p, '放置器件') };
		},
	},
	{
		name: 'pcb_create_track',
		title: '绘制走线',
		group: 'pcb',
		risk: 'write',
		scenes: ['pcb'],
		description: '按顶点绘制铜皮走线（多段直线），可指定网络、层和线宽（mil）。用于手动布线或在丝印/板框层画线。',
		parameters: S.obj({
			points: S.arr(S.point(), '顶点 [[x,y],...]（mil）', { minItems: 2 }),
			net: S.str('网络名（非铜层可留空）'),
			layer: LAYER_PARAM,
			width: S.num('线宽 mil，默认 10'),
		}, ['points']),
		summarize: a => `${a.net || '无网络'} · ${(a.points?.length ?? 1) - 1} 段`,
		async run(a, ctx) {
			requireScene(ctx, 'pcb');
			const pts: number[][] = a.points ?? [];
			const items: ChangeItem[] = [];
			for (let i = 0; i < pts.length - 1; i++) {
				const p = await callEda('pcb_PrimitiveLine.create', a.net ?? '', layerId(a.layer, 1), pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], a.width ?? 10, false);
				const id = idOf(p);
				if (id)
					items.push({ op: 'create', kind: 'pcb_PrimitiveLine', primitiveId: id, label: `走线 ${a.net ?? ''}`, after: serialize(p) });
			}
			if (!items.length)
				throw new Error('走线创建失败，请检查图层与网络名');
			ctx.recordChange(items);
			return { created: items.map(i => i.primitiveId) };
		},
	},
	{
		name: 'pcb_create_via',
		title: '放置过孔',
		group: 'pcb',
		risk: 'write',
		scenes: ['pcb'],
		description: '放置过孔（mil）。可批量传入多个坐标。',
		parameters: S.obj({
			net: S.str('网络名'),
			points: S.arr(S.point(), '过孔坐标列表'),
			hole: S.num('孔径，默认 12'),
			diameter: S.num('外径，默认 24'),
		}, ['points']),
		summarize: a => `${a.points?.length ?? 0} 个 · ${a.net ?? ''}`,
		async run(a, ctx) {
			requireScene(ctx, 'pcb');
			const items: ChangeItem[] = [];
			for (const [x, y] of a.points ?? []) {
				const p = await callEda('pcb_PrimitiveVia.create', a.net ?? '', x, y, a.hole ?? 12, a.diameter ?? 24);
				const id = idOf(p);
				if (id)
					items.push({ op: 'create', kind: 'pcb_PrimitiveVia', primitiveId: id, label: `过孔 ${a.net ?? ''}`, after: serialize(p) });
			}
			if (!items.length)
				throw new Error('过孔创建失败');
			ctx.recordChange(items);
			return { created: items.map(i => i.primitiveId) };
		},
	},
	{
		name: 'pcb_create_text',
		title: '添加丝印文本',
		group: 'pcb',
		risk: 'write',
		scenes: ['pcb'],
		description: '在 PCB 上添加文本（默认顶层丝印）。',
		parameters: S.obj({
			text: S.str('文本'),
			x: S.num('X'),
			y: S.num('Y'),
			layer: LAYER_PARAM,
			size: S.num('字高 mil，默认 45'),
			rotation: S.num('旋转'),
		}, ['text', 'x', 'y']),
		summarize: a => a.text,
		async run(a, ctx) {
			requireScene(ctx, 'pcb');
			const p = await callEda('pcb_PrimitiveString.create', layerId(a.layer, 3), a.x, a.y, String(a.text), 'default', a.size ?? 45, Math.max(4, Math.round((a.size ?? 45) / 7)), 5, a.rotation ?? 0, false, 0, false, false);
			return { id: created(ctx, 'pcb_PrimitiveString', p, '丝印文本') };
		},
	},
	{
		name: 'pcb_create_outline',
		title: '绘制板框',
		group: 'pcb',
		risk: 'write',
		scenes: ['pcb'],
		description: '绘制矩形板框（左下角 x,y 与宽高，mil，可设圆角）。已有板框时请先确认用户是否替换。',
		parameters: S.obj({
			x: S.num('左下角 X'),
			y: S.num('左下角 Y'),
			width: S.num('宽 mil'),
			height: S.num('高 mil'),
			corner_radius: S.num('圆角半径 mil'),
		}, ['x', 'y', 'width', 'height']),
		summarize: a => `${a.width}×${a.height} mil`,
		async run(a, ctx) {
			requireScene(ctx, 'pcb');
			// 多边形数据使用 SVG 坐标系（Y 向下），矩形左上角 Y 需取反
			const poly = await callEda('pcb_MathPolygon.createPolygon', ['R', a.x, -(a.y + a.height), a.width, a.height, 0, a.corner_radius ?? 0]);
			if (!poly)
				throw new Error('多边形数据无效');
			const p = await callEda('pcb_PrimitivePolyline.create', '', 11, poly, 10, false);
			return { id: created(ctx, 'pcb_PrimitivePolyline', p, '板框') };
		},
	},
	{
		name: 'pcb_create_pour',
		title: '覆铜',
		group: 'pcb',
		risk: 'write',
		scenes: ['pcb'],
		description: '创建矩形覆铜区域（通常 GND），或重建全部覆铜（rebuild=true）。',
		parameters: S.obj({
			rebuild: S.bool('仅重建现有覆铜'),
			net: S.str('网络，默认 GND'),
			layer: LAYER_PARAM,
			x: S.num('左下角 X'),
			y: S.num('左下角 Y'),
			width: S.num('宽'),
			height: S.num('高'),
			fill: S.enum(['solid', '45grid', '90grid'], '填充方式'),
		}),
		summarize: a => a.rebuild ? '重建覆铜' : `${a.net ?? 'GND'} 覆铜`,
		async run(a, ctx) {
			requireScene(ctx, 'pcb');
			if (a.rebuild) {
				const r = await callEda<any[]>('pcb_PrimitivePour.rebuildCopperRegions');
				return { rebuilt: r?.length ?? 0 };
			}
			if ([a.x, a.y, a.width, a.height].some(v => typeof v !== 'number'))
				throw new Error('需要 x、y、width、height');
			const poly = await callEda('pcb_MathPolygon.createPolygon', ['R', a.x, -(a.y + a.height), a.width, a.height, 0, 0]);
			const p = await callEda('pcb_PrimitivePour.create', a.net ?? 'GND', layerId(a.layer, 1), poly, a.fill ?? 'solid', false, `${a.net ?? 'GND'}_POUR`, 1, 10, false);
			return { id: created(ctx, 'pcb_PrimitivePour', p, `覆铜 ${a.net ?? 'GND'}`) };
		},
	},
	{
		name: 'pcb_delete',
		title: '删除图元',
		group: 'pcb',
		risk: 'danger',
		scenes: ['pcb'],
		description: '删除 PCB 图元（按 ID，自动识别类型）。清除布线请用 pcb_clear_routing。',
		parameters: S.obj({ ids: S.arr(S.str('图元 ID'), 'ID 列表') }, ['ids']),
		summarize: a => `${a.ids?.length ?? 0} 个图元`,
		async run(a, ctx) {
			requireScene(ctx, 'pcb');
			const groups = await groupByType('pcb', ids(a.ids));
			let n = 0;
			for (const [kind, list] of groups)
				n += (await deleteTracked(ctx, kind, list, '删除')).deleted;
			return { deleted: n };
		},
	},
	{
		name: 'pcb_drc',
		title: 'PCB DRC',
		group: 'pcb',
		risk: 'read',
		scenes: ['pcb'],
		description: '运行 PCB 设计规则检查，返回违规列表。',
		parameters: S.obj({ strict: S.bool('严格模式') }),
		async run(a) {
			const r = await callEda<any[]>('pcb_Drc.check', !!a.strict, false, true);
			if (!Array.isArray(r))
				return { passed: !!r };
			return { passed: r.length === 0, ...brief(r, 80, x => serialize(x)) };
		},
	},
	{
		name: 'pcb_import_changes',
		title: '从原理图导入',
		group: 'pcb',
		risk: 'write',
		scenes: ['pcb'],
		description: '将原理图的器件与网络变更同步到当前 PCB（相当于「更新 PCB」）。',
		parameters: S.obj({}),
		async run(_a, ctx) {
			const ok = await callEda('pcb_Document.importChanges');
			ctx.recordChange([{ op: 'other', kind: 'pcb_Document', label: '从原理图导入变更' }], { undoable: false, note: '请使用 EDA 的撤销恢复' });
			return { ok: !!ok };
		},
	},
	{
		name: 'pcb_auto',
		title: '自动布局/布线',
		group: 'pcb',
		risk: 'danger',
		scenes: ['pcb'],
		description: '执行 PCB 自动布线（route）或自动布局（layout）。布线可限定网络、忽略网络、指定铜层。',
		parameters: S.obj({
			action: S.enum(['route', 'layout'], '操作'),
			nets: S.arr(S.str('网络'), '仅布这些网络（可选）'),
			ignore_nets: S.arr(S.str('网络'), '忽略的网络，例如 GND（打算覆铜时）'),
			layers: S.arr(S.any('图层'), '可用铜层（可选）'),
		}, ['action']),
		summarize: a => a.action,
		async run(a, ctx) {
			requireScene(ctx, 'pcb');
			let r: any;
			if (a.action === 'route') {
				const props: any = {};
				if (a.nets?.length)
					props.RoutingNets = a.nets;
				if (a.ignore_nets?.length)
					props.ignoreNets = a.ignore_nets;
				if (a.layers?.length)
					props.layers = a.layers.map((l: any) => layerId(l));
				r = await callEda('pcb_Document.autoRouting', props);
			}
			else {
				r = await callEda('pcb_Document.autoLayout');
			}
			ctx.recordChange([{ op: 'other', kind: 'pcb_Document', label: a.action === 'route' ? '自动布线' : '自动布局' }], { undoable: false, note: '可用 pcb_clear_routing 或 EDA 撤销恢复' });
			return r ?? '完成';
		},
	},
	{
		name: 'pcb_clear_routing',
		title: '清除布线',
		group: 'pcb',
		risk: 'danger',
		scenes: ['pcb'],
		description: '清除 PCB 布线：all 全部；net / connection 针对当前选中。',
		parameters: S.obj({ type: S.enum(['all', 'net', 'connection'], '范围') }, ['type']),
		async run(a, ctx) {
			const ok = await callEda('pcb_Document.clearRouting', a.type);
			ctx.recordChange([{ op: 'other', kind: 'pcb_Document', label: `清除布线（${a.type}）` }], { undoable: false });
			return { ok: !!ok };
		},
	},
];

// ———————————————————————— 器件库 ————————————————————————

function deviceBrief(d: any): any {
	return {
		uuid: d.uuid,
		libraryUuid: d.libraryUuid,
		name: d.name,
		description: d.description,
		footprint: d.footprintName ?? d.footprint?.name,
		symbol: d.symbolName ?? d.symbol?.name,
		lcsc: d.otherProperty?.['Supplier Part'] ?? d.otherProperty?.supplierId ?? d.otherProperty?.LCSC,
		mpn: d.otherProperty?.['Manufacturer Part'] ?? d.otherProperty?.manufacturerId,
		manufacturer: d.otherProperty?.Manufacturer ?? d.otherProperty?.manufacturer,
		jlcLibrary: d.otherProperty?.['JLCPCB Part Class'] ?? undefined,
	};
}

const libTools: ToolDef[] = [
	{
		name: 'lib_search_device',
		title: '搜索器件',
		group: 'lib',
		risk: 'read',
		description: '在嘉立创/立创商城器件库中按关键字搜索器件（型号、参数、描述，如 "STM32F103C8T6"、"10k 0603"、"AMS1117-3.3"）。返回可直接用于放置的 libraryUuid 与 uuid。',
		parameters: S.obj({
			keyword: S.str('关键字'),
			page: S.int('页码，从 1 开始'),
			page_size: S.int('每页数量，默认 10，最大 30'),
			library: S.enum(['system', 'personal', 'project', 'favorite'], '搜索的库，默认系统库'),
		}, ['keyword']),
		summarize: a => a.keyword,
		async run(a) {
			let lib: string | undefined;
			if (a.library && a.library !== 'system') {
				const m: Record<string, string> = { personal: 'getPersonalLibraryUuid', project: 'getProjectLibraryUuid', favorite: 'getFavoriteLibraryUuid' };
				lib = await callEda(`lib_LibrariesList.${m[a.library]}`).catch(() => undefined);
			}
			const r = await callEda<any[]>('lib_Device.search', String(a.keyword), lib, undefined, undefined, Math.min(30, Number(a.page_size) || 10), Number(a.page) || 1);
			return { count: r?.length ?? 0, items: (r ?? []).map(deviceBrief) };
		},
	},
	{
		name: 'lib_get_by_lcsc',
		title: '按 LCSC 编号查器件',
		group: 'lib',
		risk: 'read',
		description: '用立创商城编号（如 C25804、C8734）精确获取器件，最可靠的选型方式。',
		parameters: S.obj({ lcsc_ids: S.arr(S.str('LCSC 编号'), '编号列表') }, ['lcsc_ids']),
		summarize: a => (a.lcsc_ids ?? []).join(', '),
		async run(a) {
			const r = await callEda<any[]>('lib_Device.getByLcscIds', ids(a.lcsc_ids));
			return { count: r?.length ?? 0, items: (r ?? []).map(deviceBrief) };
		},
	},
	{
		name: 'lib_get_device',
		title: '器件详情',
		group: 'lib',
		risk: 'read',
		description: '获取库器件完整信息（关联符号、封装、3D 模型、全部属性）。',
		parameters: S.obj({ uuid: S.str('器件 UUID'), library_uuid: S.str('库 UUID') }, ['uuid']),
		async run(a) {
			const d = await callEda('lib_Device.get', String(a.uuid), a.library_uuid || undefined);
			if (!d)
				throw new Error('器件不存在');
			return d;
		},
	},
	{
		name: 'lib_search_footprint',
		title: '搜索封装/符号',
		group: 'lib',
		risk: 'read',
		description: '搜索封装（footprint）或符号（symbol）库。',
		parameters: S.obj({
			type: S.enum(['footprint', 'symbol'], '类型'),
			keyword: S.str('关键字，如 SOT-23、LQFP-48'),
			page_size: S.int('数量，默认 10'),
		}, ['type', 'keyword']),
		summarize: a => `${a.type}: ${a.keyword}`,
		async run(a) {
			const r = a.type === 'symbol'
				? await callEda<any[]>('lib_Symbol.search', String(a.keyword), undefined, undefined, undefined, Number(a.page_size) || 10, 1)
				: await callEda<any[]>('lib_Footprint.search', String(a.keyword), undefined, undefined, Number(a.page_size) || 10, 1);
			return (r ?? []).map(x => ({ uuid: x.uuid, libraryUuid: x.libraryUuid, name: x.name, description: x.description }));
		},
	},
	{
		name: 'lib_preview',
		title: '预览符号/封装',
		group: 'lib',
		risk: 'read',
		description: '渲染符号或封装的预览图，展示给用户（识图模型也可查看）。',
		parameters: S.obj({
			type: S.enum(['symbol', 'footprint'], '类型'),
			uuid: S.str('符号或封装 UUID'),
			library_uuid: S.str('库 UUID'),
		}, ['type', 'uuid', 'library_uuid']),
		async run(a, ctx) {
			const blob = a.type === 'symbol'
				? await callEda<Blob>('lib_Symbol.getRenderImage', { symbolUuid: a.uuid, libraryUuid: a.library_uuid })
				: await callEda<Blob>('lib_Footprint.getRenderImage', { footprintUuid: a.uuid, libraryUuid: a.library_uuid });
			return showImage(ctx, blob, a.type === 'symbol' ? '符号预览' : '封装预览');
		},
	},
];

// ———————————————————————— 导出与生产 ————————————————————————

const exportTools: ToolDef[] = [
	{
		name: 'export_bom',
		title: '导出 BOM',
		group: 'export',
		risk: a => a.save ? 'write' : 'read',
		description: '生成 BOM（物料清单）。默认读取 CSV 内容用于分析（统计、查缺料号）；save=true 时另存到本地。',
		parameters: S.obj({
			source: S.enum(['sch', 'pcb'], '来源，默认当前文档'),
			save: S.bool('保存到本地'),
			file_type: S.enum(['csv', 'xlsx'], '保存格式，默认 csv'),
		}),
		summarize: a => a.save ? '保存到本地' : '读取内容',
		async run(a, ctx) {
			const src = a.source ?? (ctx.editor.scene === 'pcb' ? 'pcb' : 'sch');
			const type = a.save ? (a.file_type ?? 'csv') : 'csv';
			const f = await callEda<File>(`${src}_ManufactureData.getBomFile`, undefined, type);
			return fileToResult(f, 'BOM', { save: !!a.save, preview: type === 'csv' });
		},
	},
	{
		name: 'export_file',
		title: '导出文件',
		group: 'export',
		risk: 'write',
		description: '导出设计文件并保存到本地：gerber（制版文件）、pick_place（坐标文件）、netlist（网表）、pdf、png、svg（原理图）、dxf、ibom（交互式 BOM）、odb、step 不支持。',
		parameters: S.obj({
			kind: S.enum(['gerber', 'pick_place', 'netlist', 'sch_pdf', 'sch_png', 'sch_svg', 'pcb_pdf', 'dxf', 'ibom', 'odb', 'altium', 'pads'], '导出类型'),
			file_name: S.str('文件名（可选）'),
		}, ['kind']),
		summarize: a => a.kind,
		async run(a, ctx) {
			const fn = a.file_name || undefined;
			const map: Record<string, [string, any[]]> = {
				gerber: ['pcb_ManufactureData.getGerberFile', [fn]],
				pick_place: ['pcb_ManufactureData.getPickAndPlaceFile', [fn, 'csv']],
				netlist: [ctx.editor.scene === 'pcb' ? 'pcb_ManufactureData.getNetlistFile' : 'sch_ManufactureData.getNetlistFile', [fn]],
				sch_pdf: ['sch_ManufactureData.getPdfFile', [fn]],
				sch_png: ['sch_ManufactureData.getPngFile', [fn]],
				sch_svg: ['sch_ManufactureData.getSvgFile', [fn]],
				pcb_pdf: ['pcb_ManufactureData.getPdfFile', [fn]],
				dxf: ['pcb_ManufactureData.getDxfFile', [fn]],
				ibom: ['pcb_ManufactureData.getInteractiveBomFile', [fn]],
				odb: ['pcb_ManufactureData.getOpenDatabaseDoublePlusFile', [fn]],
				altium: ['pcb_ManufactureData.getAltiumDesignerFile', [fn]],
				pads: ['pcb_ManufactureData.getPadsFile', [fn]],
			};
			const entry = map[a.kind];
			if (!entry)
				throw new Error('不支持的导出类型');
			if (entry[0].startsWith('pcb_') && ctx.editor.scene !== 'pcb')
				throw new Error('该导出需要先打开 PCB 文档');
			const f = await callEda<File>(entry[0], ...entry[1]);
			return fileToResult(f, a.kind, { save: true, fileName: fn });
		},
	},
	{
		name: 'place_order',
		title: '下单',
		group: 'export',
		risk: 'danger',
		scenes: ['pcb', 'sch'],
		description: '打开嘉立创 PCB 打样或 SMT 贴片下单流程（交互式，最终由用户在页面确认支付）。仅在用户明确要求下单时使用。',
		parameters: S.obj({ type: S.enum(['pcb', 'smt', 'components'], '下单类型') }, ['type']),
		async run(a, ctx) {
			const cls = ctx.editor.scene === 'pcb' ? 'pcb_ManufactureData' : 'sch_ManufactureData';
			const m = a.type === 'pcb' ? 'placePcbOrder' : a.type === 'smt' ? 'placeSmtComponentsOrder' : 'placeComponentsOrder';
			if (a.type === 'pcb' && cls !== 'pcb_ManufactureData')
				throw new Error('PCB 下单需要先打开 PCB 文档');
			const ok = await callEda(`${cls}.${m}`, true, false);
			return { opened: !!ok };
		},
	},
];

export function registerEdaTools(): void {
	defineTools([...metaTools, ...projectTools, ...viewTools, ...schTools, ...pcbTools, ...libTools, ...exportTools]);
}
