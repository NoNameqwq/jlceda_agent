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

let visible = false;
let opening = false;
let lastProject: string | undefined;
let autoOpenedFor: string | undefined;

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

/** 右侧面板（ALPHA 接口，部分版本 / 页面不可用，失败时返回 false） */
async function openInPanel(): Promise<boolean> {
	const iframeApi = eda.sys_IFrame as unknown as Record<string, unknown>;
	if (typeof iframeApi.openIFrameToPanel !== 'function')
		return false;
	let tab = 'project-attr';
	try {
		const doc = await withTimeout(eda.dmt_SelectControl.getCurrentDocumentInfo(), 1500, undefined);
		const t = Number(doc?.documentType);
		if (t === 1 || t === 8 || t === 9)
			tab = 'sch-attr';
		else if (t === 3)
			tab = 'pcb-attr';
		else if (Number.isNaN(t) || t === -1 || t === 0)
			return false; // 开始页 / 空白页没有右侧面板
	}
	catch {}
	try {
		const ok = await withTimeout(eda.sys_IFrame.openIFrameToPanel(PANEL_ID, HTML_PATH, 'right' as ESYS_PanelPosition, tab as ESYS_PanelTab, {
			title: TITLE,
			closeButton: true,
			buttonCallbackFn: () => {
				visible = false;
			},
		}), 4000, false);
		if (!ok)
			return false;
		try {
			eda.sys_PanelControl.openRightPanel(tab as ESYS_RightPanelTab);
		}
		catch {}
		// 确认真的挂上了，否则回退
		return await iframeExists();
	}
	catch (e) {
		console.warn('[EDA Agent] openIFrameToPanel failed, fallback to floating window', e);
		return false;
	}
}

/** 停靠在视口右侧的浮动窗口（全部页面可用） */
async function openFloat(): Promise<boolean> {
	let vw = 1600;
	let vh = 900;
	try {
		const s = eda.sys_Window.getViewportSize();
		vw = s.width;
		vh = s.height;
	}
	catch {}
	const width = Math.min(520, Math.max(380, Math.round(vw * 0.28)));
	const height = Math.max(480, vh - 140);
	try {
		return await withTimeout(eda.sys_IFrame.openIFrame(HTML_PATH, width, height, PANEL_ID, {
			title: TITLE,
			maximizeButton: true,
			minimizeButton: true,
			minimizeStyle: 'collapsed',
			grayscaleMask: false,
			x: Math.max(0, vw - width - 24),
			y: 72,
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
		const mode = prefer ?? config<'panel' | 'float'>('dockMode', 'float');
		let ok = false;
		if (mode === 'panel')
			ok = await openInPanel();
		if (!ok) {
			if (await iframeExists())
				await eda.sys_IFrame.closeIFrame(PANEL_ID).catch(() => false);
			ok = await openFloat();
		}
		visible = ok;
		if (!ok)
			toast('EDA Agent 面板打开失败，请检查扩展是否完整安装', 'error');
	}
	finally {
		opening = false;
	}
}

async function showOrOpen(): Promise<void> {
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
	if (await iframeExists())
		await eda.sys_IFrame.closeIFrame(PANEL_ID).catch(() => false);
	await openSidebar('float');
}

/** 菜单：停靠到右侧面板 */
export async function openDockedPanel(): Promise<void> {
	if (await iframeExists())
		await eda.sys_IFrame.closeIFrame(PANEL_ID).catch(() => false);
	setConfig('dockMode', 'panel');
	await openSidebar('panel');
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
			setTimeout(() => void checkProject(), 600);
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
