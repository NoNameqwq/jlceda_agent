/**
 * 编辑器上下文自动获取
 *
 * 每次发送消息前（以及界面轮询时）读取：当前工程、活动文档、选中图元、EDA 版本、主题。
 * 所有 EDA 调用都带超时保护，避免宿主无响应时卡住界面。
 */
import type { EditorContext, ProjectOverview } from './types';
import { getEda, hasEda, SCENE_LABEL, sceneOf } from '../lib/eda';

function timed<T>(p: Promise<T> | T, ms: number, fallback: T): Promise<T> {
	return new Promise((resolve) => {
		const t = setTimeout(() => resolve(fallback), ms);
		Promise.resolve(p).then((v) => {
			clearTimeout(t);
			resolve(v ?? fallback);
		}, () => {
			clearTimeout(t);
			resolve(fallback);
		});
	});
}

function call(path: string, ...args: any[]): Promise<any> {
	const eda = getEda();
	const [cls, m] = path.split('.');
	const owner = eda?.[cls];
	if (!owner || typeof owner[m] !== 'function')
		return Promise.resolve(undefined);
	try {
		return Promise.resolve(owner[m](...args));
	}
	catch {
		return Promise.resolve(undefined);
	}
}

function st(p: any, key: string): any {
	try {
		const fn = p?.[`getState_${key}`];
		return typeof fn === 'function' ? fn.call(p) : undefined;
	}
	catch {
		return undefined;
	}
}

export const EMPTY_CONTEXT: EditorContext = {
	available: false,
	scene: 'none',
	sceneLabel: '未连接 EDA',
	selection: [],
	selectionCount: 0,
};

export async function readEditorContext(): Promise<EditorContext> {
	if (!hasEda())
		return { ...EMPTY_CONTEXT };
	const [doc, project, theme] = await Promise.all([
		timed(call('dmt_SelectControl.getCurrentDocumentInfo'), 2500, undefined),
		timed(call('dmt_Project.getCurrentProjectInfo'), 2500, undefined),
		timed(call('sys_Window.getCurrentTheme'), 1500, undefined),
	]);
	let editorVersion: string | undefined;
	let user: string | undefined;
	try {
		editorVersion = getEda()?.sys_Environment?.getEditorCurrentVersion?.();
		const u = getEda()?.sys_Environment?.getUserInfo?.();
		user = u?.nickname || u?.username;
	}
	catch {}

	const scene = sceneOf(doc ? Number(doc.documentType) : undefined);
	const ctx: EditorContext = {
		available: true,
		scene,
		sceneLabel: SCENE_LABEL[scene],
		documentType: doc ? Number(doc.documentType) : undefined,
		documentUuid: doc?.uuid,
		projectUuid: project?.uuid ?? doc?.parentProjectUuid,
		projectName: project?.friendlyName ?? project?.name,
		selection: [],
		selectionCount: 0,
		theme: theme === 'dark' ? 'dark' : theme === 'light' ? 'light' : undefined,
		editorVersion,
		user,
	};

	if (scene === 'sch') {
		const page = await timed(call('dmt_Schematic.getCurrentSchematicPageInfo'), 2000, undefined);
		ctx.documentName = page?.name;
	}
	else if (scene === 'pcb') {
		const pcb = await timed(call('dmt_Pcb.getCurrentPcbInfo'), 2000, undefined);
		ctx.documentName = pcb?.name;
	}

	if (scene === 'sch' || scene === 'pcb') {
		const cls = scene === 'sch' ? 'sch_SelectControl' : 'pcb_SelectControl';
		const list = await timed<any[]>(call(`${cls}.getAllSelectedPrimitives`), 2500, []);
		ctx.selectionCount = Array.isArray(list) ? list.length : 0;
		ctx.selection = (Array.isArray(list) ? list : []).slice(0, 40).map((p) => {
			const designator = st(p, 'Designator');
			const net = st(p, 'Net');
			const name = st(p, 'Name');
			return {
				id: String(st(p, 'PrimitiveId') ?? ''),
				type: String(st(p, 'PrimitiveType') ?? 'Primitive'),
				label: designator || net || name || undefined,
			};
		}).filter(s => s.id);
	}
	return ctx;
}

/** 生成用于区分对话列表的工程键 */
export function projectKeyOf(ctx: EditorContext): string {
	return ctx.projectUuid ? `p_${ctx.projectUuid}` : 'global';
}

let overviewCache: ProjectOverview | undefined;

/** 工程概览（板子 / 原理图及图页 / PCB），30 秒缓存，供工程 Agent 注入系统提示词 */
export async function readProjectOverview(ctx: EditorContext): Promise<ProjectOverview | undefined> {
	if (!ctx.available || !ctx.projectUuid)
		return undefined;
	if (overviewCache && overviewCache.projectUuid === ctx.projectUuid && Date.now() - overviewCache.at < 30_000)
		return overviewCache;
	const [boards, schs, pcbs] = await Promise.all([
		timed<any[]>(call('dmt_Board.getAllBoardsInfo'), 2500, []),
		timed<any[]>(call('dmt_Schematic.getAllSchematicsInfo'), 2500, []),
		timed<any[]>(call('dmt_Pcb.getAllPcbsInfo'), 2500, []),
	]);
	overviewCache = {
		projectUuid: ctx.projectUuid,
		boards: (Array.isArray(boards) ? boards : []).map(b => ({ name: String(b?.name ?? '') })),
		schematics: (Array.isArray(schs) ? schs : []).map(s => ({
			name: String(s?.name ?? ''),
			uuid: String(s?.uuid ?? ''),
			pages: (Array.isArray(s?.page) ? s.page : []).map((p: any) => ({ name: String(p?.name ?? ''), uuid: String(p?.uuid ?? '') })),
		})),
		pcbs: (Array.isArray(pcbs) ? pcbs : []).map(p => ({ name: String(p?.name ?? ''), uuid: String(p?.uuid ?? '') })),
		at: Date.now(),
	};
	return overviewCache;
}
