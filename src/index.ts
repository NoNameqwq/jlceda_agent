/**
 * EDA Agent 扩展主线程入口
 *
 * 职责：注册菜单 / 快捷键，管理侧边栏内联框架的打开、收起与停靠方式；
 * 监听工程打开事件，按设置自动唤出「工程 Agent」。
 * Agent 的全部逻辑（对话、工具、模型请求）运行在 /iframe/index.html 内。
 */
import extensionConfig from '../extension.json' with { type: 'json' };

const PANEL_ID = 'jlc-agent-sidebar';
const HTML_PATH = '/iframe/index.html';
const TITLE = 'EDA Agent';
const TOPIC_VISIBILITY = 'jlc-agent:visibility';
const TOPIC_SCOPE = 'jlc-agent:scope';
/** 侧边栏请求切换停靠方式：{ mode: 'panel' | 'float' } */
const TOPIC_DOCK = 'jlc-agent:dock';

let visible = false;
let opening = false;
let lastProject: string | undefined;
let autoOpenedFor: string | undefined;
/** 当前停靠所在标签页；undefined = 浮动窗口 */
let dockedTab: string | undefined;
/** 当前是否为「吸附到右侧」的窗口（EDA 不支持面板停靠接口时的替代方案） */
let snapped = false;
let snapNoticeShown = false;

/** EDA 是否提供停靠到面板的接口（4.1.60 等版本没有 openIFrameToPanel） */
function hasPanelApi(): boolean {
	return typeof (eda.sys_IFrame as unknown as Record<string, unknown>).openIFrameToPanel === 'function';
}
/** 最近一次停靠失败原因（提示给用户，便于排查） */
let lastDockError = '';
/** 停靠失败过的文档类型，避免切换标签时反复尝试 */
const dockFailedTypes = new Set<number>();
/** 设置迁移版本：v2 起默认停靠到最右侧边栏 */
const DOCK_VERSION = 2;

function toast(message: string, type: 'info' | 'warn' | 'error' | 'success' = 'info'): void {
	try {
		eda.sys_Message.showToastMessage(message, type as unknown as ESYS_ToastMessageType, 3);
	}
	catch {
		try {
			eda.sys_ToastMessage.showMessage(message, type as unknown as ESYS_ToastMessageType);
		}
		catch {}
	}
}

function config<T>(key: string, fallback: T): T {
	try {
		const v = eda.sys_Storage.getExtensionUserConfig(key);
		return v === undefined || v === null ? fallback : v as T;
	}
	catch {
		return fallback;
	}
}

function setConfig(key: string, value: unknown): void {
	try {
		void eda.sys_Storage.setExtensionUserConfig(key, value);
	}
	catch {}
}

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
	return new Promise((resolve) => {
		const t = setTimeout(() => resolve(fallback), ms);
		p.then((v) => {
			clearTimeout(t);
			resolve(v);
		}, () => {
			clearTimeout(t);
			resolve(fallback);
		});
	});
}

async function iframeExists(): Promise<boolean> {
	try {
		return await withTimeout(eda.sys_IFrame.isIFrameAlreadyExist(PANEL_ID), 1500, false);
	}
	catch {
		return false;
	}
}

async function currentDocType(): Promise<number | undefined> {
	try {
		const doc = await withTimeout(eda.dmt_SelectControl.getCurrentDocumentInfo(), 1500, undefined);
		const t = Number(doc?.documentType);
		return Number.isNaN(t) ? undefined : t;
	}
	catch {
		return undefined;
	}
}

/** 切换到有右侧栏的文档时：若设置为停靠但当前是浮动窗口，自动改为停靠 */
async function maybeRedock(): Promise<void> {
	if (opening || dockedTab || snapped || !visible || !hasPanelApi() || config<string>('dockMode', 'panel') !== 'panel')
		return;
	const t = await currentDocType();
	if (t === undefined || dockFailedTypes.has(t) || !(await panelTabs()))
		return;
	await switchDock('panel');
}

/** 按当前文档类型选择右侧栏标签页；返回 undefined 表示该页面没有右侧栏 */
async function panelTabs(): Promise<string[] | undefined> {
	let t = Number.NaN;
	try {
		const doc = await withTimeout(eda.dmt_SelectControl.getCurrentDocumentInfo(), 1500, undefined);
		t = Number(doc?.documentType);
	}
	catch {}
	if (Number.isNaN(t) || t === -1 || t === 0)
		return undefined; // 开始页 / 空白页没有右侧栏
	// 原理图 / 仿真图页（Ngspice 8、SimulIDE 9）/ 符号
	if ([1, 2, 7, 8, 9, 17, 18, 19, 20, 21, 22, 25, 32].includes(t))
		return ['sch-attr', 'sch-filter', 'project-attr'];
	if (t === 3 || t === 4)
		return ['pcb-attr', 'pcb-layer', 'pcb-filter', 'project-attr'];
	if (t === 12)
		return ['pcb2d-attr', 'project-attr'];
	if (t === 15)
		return ['pcb3d-attr', 'project-attr'];
	if (t === 26 || t === 29)
		return ['panel-attr', 'project-attr'];
	return ['project-attr'];
}

/**
 * 停靠到最右侧的侧边栏（与「属性 / 过滤」并列的标签页）。
 * openIFrameToPanel 为 ALPHA 接口：逐个尝试候选标签页，每次都确认 iframe 真的挂上了。
 */
async function openInPanel(): Promise<boolean> {
	const iframeApi = eda.sys_IFrame as unknown as Record<string, unknown>;
	if (typeof iframeApi.openIFrameToPanel !== 'function')
		return false;
	const tabs = await panelTabs();
	if (!tabs)
		return false;
	const reasons: string[] = [];
	for (const tab of tabs) {
		try {
			// 先展开右侧栏，部分版本要求面板可见时才能挂载
			try {
				eda.sys_PanelControl.openRightPanel(tab as ESYS_RightPanelTab);
			}
			catch {}
			const r: unknown = await withTimeout<unknown>(eda.sys_IFrame.openIFrameToPanel(PANEL_ID, HTML_PATH, 'right' as ESYS_PanelPosition, tab as ESYS_PanelTab, {
				title: TITLE,
				closeButton: true,
				buttonCallbackFn: () => {
					visible = false;
					dockedTab = undefined;
				},
			}), 6000, 'timeout');
			// 只有明确返回 false / 超时才算失败（部分版本成功时返回 undefined，且面板内的 iframe 不计入 isIFrameAlreadyExist）
			if (r === false || r === 'timeout') {
				reasons.push(`${tab}:${r === 'timeout' ? '超时' : '返回 false'}`);
				continue;
			}
			try {
				eda.sys_PanelControl.openRightPanel(tab as ESYS_RightPanelTab);
			}
			catch {}
			dockedTab = tab;
			return true;
		}
		catch (e) {
			reasons.push(`${tab}:${e instanceof Error ? e.message : String(e)}`.slice(0, 80));
			console.warn(`[EDA Agent] openIFrameToPanel(${tab}) failed`, e);
		}
	}
	lastDockError = reasons.join('；');
	return false;
}

/** 停靠在视口右侧的浮动窗口（全部页面可用） */
async function openFloat(snap = false): Promise<boolean> {
	let vw = 1600;
	let vh = 900;
	try {
		const s = eda.sys_Window.getViewportSize();
		vw = s.width;
		vh = s.height;
	}
	catch {}
	const width = Math.min(560, Math.max(400, Math.round(vw * 0.3)));
	// 吸附：贴住视口右边缘，从工具栏下方一直到底部
	const SNAP_TOP = 80;
	const TITLE_BAR = 32;
	const height = snap ? Math.max(420, vh - SNAP_TOP - TITLE_BAR) : Math.max(480, vh - 140);
	try {
		return await withTimeout(eda.sys_IFrame.openIFrame(HTML_PATH, width, height, PANEL_ID, {
			title: TITLE,
			maximizeButton: !snap,
			minimizeButton: true,
			minimizeStyle: 'collapsed',
			grayscaleMask: false,
			x: snap ? Math.max(0, vw - width) : Math.max(0, vw - width - 24),
			y: snap ? SNAP_TOP : 72,
			buttonCallbackFn: (button) => {
				if (button === 'close')
					visible = false;
			},
		}), 6000, false);
	}
	catch (e) {
		console.error('[EDA Agent] openIFrame failed', e);
		return false;
	}
}

async function openSidebar(prefer?: 'panel' | 'float'): Promise<void> {
	if (opening)
		return;
	opening = true;
	try {
		const mode = prefer ?? config<'panel' | 'float'>('dockMode', 'panel');
		let ok = false;
		dockedTab = undefined;
		snapped = false;
		lastDockError = '';
		if (mode === 'panel' && !hasPanelApi()) {
			// 本 EDA 版本没有停靠接口：吸附到视口右侧
			if (await iframeExists())
				await eda.sys_IFrame.closeIFrame(PANEL_ID).catch(() => false);
			ok = await openFloat(true);
			snapped = ok;
			if (ok && !snapNoticeShown) {
				snapNoticeShown = true;
				let ver = '';
				try {
					ver = eda.sys_Environment.getEditorCurrentVersion();
				}
				catch {}
				toast(`当前 EDA ${ver} 未提供停靠到侧边栏的接口，已吸附到右侧`, 'info');
			}
		}
		else if (mode === 'panel') {
			ok = await openInPanel();
			if (!ok) {
				const t = await currentDocType();
				if (t !== undefined && lastDockError)
					dockFailedTypes.add(t);
				if (lastDockError)
					toast(`停靠到右侧栏失败（${lastDockError}），已改用浮动窗口`, 'warn');
				else if (prefer === 'panel')
					toast('开始页没有右侧栏，已改用浮动窗口；打开原理图或 PCB 后会自动停靠到右侧', 'info');
			}
		}
		if (!ok) {
			if (await iframeExists())
				await eda.sys_IFrame.closeIFrame(PANEL_ID).catch(() => false);
			ok = await openFloat();
		}
		visible = ok;
		publishDock();
		if (!ok)
			toast('EDA Agent 面板打开失败，请检查扩展是否完整安装', 'error');
	}
	finally {
		opening = false;
	}
}

async function showOrOpen(): Promise<void> {
	// 设置为停靠，但现存的是（隐藏的）浮动窗口：关闭后按停靠方式重开，而不是把浮动窗口再显示出来
	if (config<string>('dockMode', 'panel') === 'panel' && hasPanelApi() && !dockedTab && (await panelTabs())) {
		if (await iframeExists())
			await eda.sys_IFrame.closeIFrame(PANEL_ID).catch(() => false);
		await openSidebar('panel');
		return;
	}
	if (await iframeExists()) {
		let ok = false;
		try {
			ok = await withTimeout(eda.sys_IFrame.showIFrame(PANEL_ID), 2000, false);
		}
		catch {}
		if (ok) {
			visible = true;
			return;
		}
		await eda.sys_IFrame.closeIFrame(PANEL_ID).catch(() => false);
	}
	await openSidebar();
}

function publishDock(): void {
	try {
		eda.sys_MessageBus.publish('jlc-agent:dock-state', { mode: dockedTab || snapped ? 'panel' : 'float', tab: dockedTab, snapped });
	}
	catch {}
}

/** 切换停靠方式：关闭当前窗口后按新方式重新打开（对话状态保存在存储中，重开后恢复） */
async function switchDock(mode: 'panel' | 'float'): Promise<void> {
	setConfig('dockMode', mode);
	if (await iframeExists())
		await eda.sys_IFrame.closeIFrame(PANEL_ID).catch(() => false);
	await openSidebar(mode);
}

function pushScope(scope: 'project' | 'global'): void {
	setConfig('pendingScope', scope);
	try {
		eda.sys_MessageBus.publish(TOPIC_SCOPE, { scope });
	}
	catch {}
}

/** 菜单：打开 / 收起侧边栏 */
export async function toggleSidebar(): Promise<void> {
	if (visible && await iframeExists()) {
		let ok = false;
		try {
			ok = await withTimeout(eda.sys_IFrame.hideIFrame(PANEL_ID), 2000, false);
		}
		catch {}
		if (!ok)
			await eda.sys_IFrame.closeIFrame(PANEL_ID).catch(() => false);
		visible = false;
		return;
	}
	await showOrOpen();
}

/** 菜单：工程 Agent（对话归属当前工程） */
export async function openProjectAgent(): Promise<void> {
	pushScope('project');
	await showOrOpen();
}

/** 菜单：独立 Agent（全局对话，不随工程切换） */
export async function openGlobalAgent(): Promise<void> {
	pushScope('global');
	await showOrOpen();
}

/** 菜单：以浮动窗口打开 */
export async function openFloatingWindow(): Promise<void> {
	await switchDock('float');
}

/** 菜单：停靠到最右侧边栏 */
export async function openDockedPanel(): Promise<void> {
	await switchDock('panel');
}

/** 菜单：停靠诊断——逐个尝试右侧栏标签页并报告接口返回值，便于定位无法停靠的原因 */
export async function dockDiagnose(): Promise<void> {
	const DIAG_ID = 'jlc-agent-dock-diag';
	const lines: string[] = [`扩展版本：${extensionConfig.version}`];
	try {
		lines.push(`EDA 版本：${eda.sys_Environment.getEditorCurrentVersion()}`);
	}
	catch {}
	const t = await currentDocType();
	lines.push(`当前文档类型：${t ?? '未知'}`, `停靠设置：${config<string>('dockMode', '(未设置)')}`, `当前停靠标签：${dockedTab ?? '无（浮动窗口）'}`);
	const api = eda.sys_IFrame as unknown as Record<string, unknown>;
	lines.push(`openIFrameToPanel：${typeof api.openIFrameToPanel}${typeof api.openIFrameToPanel === 'function' ? '' : '（本版本不支持停靠接口，已改为吸附到右侧）'}`, `吸附状态：${snapped ? '已吸附' : '否'}`);
	const tabs = await panelTabs();
	if (!tabs) {
		lines.push('当前页面没有右侧栏（开始页 / 空白页）。请打开原理图或 PCB 后再诊断。');
	}
	else if (typeof api.openIFrameToPanel === 'function') {
		for (const tab of tabs) {
			try {
				try {
					eda.sys_PanelControl.openRightPanel(tab as ESYS_RightPanelTab);
				}
				catch {}
				const r: unknown = await withTimeout<unknown>(eda.sys_IFrame.openIFrameToPanel(DIAG_ID, HTML_PATH, 'right' as ESYS_PanelPosition, tab as ESYS_PanelTab, { title: 'EDA Agent 诊断' }), 6000, 'timeout');
				const exists = await withTimeout(eda.sys_IFrame.isIFrameAlreadyExist(DIAG_ID), 1500, false).catch(() => 'error');
				lines.push(`· ${tab}：返回 ${JSON.stringify(r)}，存在检测 ${String(exists)}`);
				await eda.sys_IFrame.closeIFrame(DIAG_ID).catch(() => false);
			}
			catch (e) {
				lines.push(`· ${tab}：抛出 ${e instanceof Error ? e.message : String(e)}`);
			}
		}
	}
	lines.push('', '请把本窗口截图发给开发者。');
	eda.sys_Dialog.showInformationMessage(lines.join('\n'), 'EDA Agent 停靠诊断');
}

/** 菜单：关于 */
export function about(): void {
	eda.sys_Dialog.showInformationMessage(
		`EDA Agent v${extensionConfig.version}\n\n嘉立创EDA专业版内置 AI Agent。\n· 工程 Agent：对话归属当前工程，打开工程时可自动唤出\n· 独立 Agent：全局对话，不随工程切换\n快捷键 Alt+A 打开 / 收起。\n\n提示：调用模型接口需要在「扩展管理器」中为本扩展勾选「允许外部交互」。`,
		'关于 EDA Agent',
	);
}

/** 工程打开检测：项目从「无 / 其它」变为新工程时，按设置自动唤出工程 Agent */
async function checkProject(): Promise<void> {
	let uuid: string | undefined;
	try {
		const p = await withTimeout(eda.dmt_Project.getCurrentProjectInfo(), 2000, undefined);
		uuid = p?.uuid;
	}
	catch {}
	if (uuid === lastProject)
		return;
	lastProject = uuid;
	if (!uuid || autoOpenedFor === uuid)
		return;
	if (!config<boolean>('autoOpenOnProject', true))
		return;
	autoOpenedFor = uuid;
	pushScope('project');
	if (!visible || !await iframeExists())
		await showOrOpen();
}

// eslint-disable-next-line unused-imports/no-unused-vars
export function activate(status?: 'onStartupFinished', arg?: string): void {
	// 迁移：旧版本默认浮动窗口，v2 起默认停靠到最右侧边栏
	if (config<number>('dockVersion', 0) < DOCK_VERSION) {
		setConfig('dockMode', 'panel');
		setConfig('dockVersion', DOCK_VERSION);
	}
	try {
		eda.sys_MessageBus.subscribe(TOPIC_VISIBILITY, (message: unknown) => {
			visible = !!(message as { visible?: boolean })?.visible;
		});
	}
	catch {}
	try {
		void eda.sys_ShortcutKey.registerShortcutKey(['ALT', 'A'], 'EDA Agent：打开/收起侧边栏', () => {
			void toggleSidebar();
		}).catch(() => false);
	}
	catch {}
	// 标签页打开时立即检查；再加轮询兜底（工程切换不一定触发标签事件）
	try {
		eda.dmt_Event.addEditorTabEventListener('jlc-agent-tab', 'all' as any, () => {
			setTimeout(() => void checkProject().then(() => maybeRedock()), 600);
		});
	}
	catch {}
	const tick = () => void checkProject();
	let timerOk = false;
	try {
		timerOk = eda.sys_Timer.setIntervalTimer('jlc-agent-project-watch', 3000, tick);
	}
	catch {}
	if (!timerOk) {
		try {
			setInterval(tick, 3000);
		}
		catch {}
	}
	setTimeout(tick, 1500);
}
