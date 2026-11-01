/**
 * 主线程：SimulIDE 动态仿真引擎（接管 EDA 的仿真会话）
 *
 * - 监听 sch_Event.addSimulationEnginePullEventListener 的会话事件（开始 / 暂停 / 恢复 / 停止 / 速度 / 元件属性）
 * - 开始仿真前：把 Agent 创建的自定义元件写入引擎虚拟文件系统，并按绑定关系改写网表（外壳芯片 → 自定义元件）
 * - 运行时通过 sch_SimulationEngine.pushData 把数据推回 EDA 界面，同时累积一份供 Agent 读取
 * - 与侧边栏通过消息总线通信：jlc-agent:sim-status（状态广播）、jlc-agent:sim-cmd / sim-reply（控制请求）
 *
 * 模式（扩展配置 simEngineMode）：
 *   takeover —— 由本扩展运行仿真（需停用官方 SimulIDE 扩展，避免两个引擎同时推送数据）
 *   observe  —— 只记录网表供 Agent 分析，不运行、不推送
 *   off      —— 不注册监听
 */
import simSource from '../../wasm/lceda-pro-sim-server.js?raw';
import type { CustomSimComponent, SeriesStat, SimBinding, SimFactory, TruthVector } from './simulide';
import { accumulate, autoVectors, decodeCustomList, evalGates, factoryFromSource, inferInputs, inferOutputs, parsePackagePins, rewriteNetlist, runTruthTable, SIM_STATE, SimEngine, STORAGE_KEY } from './simulide';

export const TOPIC_SIM_STATUS = 'jlc-agent:sim-status';
export const TOPIC_SIM_CMD = 'jlc-agent:sim-cmd';
export const TOPIC_SIM_REPLY = 'jlc-agent:sim-reply';
export const BINDINGS_KEY = 'simBindings';
export const MODE_KEY = 'simEngineMode';
export const NETLIST_KEY = 'simLastNetlist';
const WASM_PATH = '/wasm/lceda-pro-sim-server.wasm';

const STEP_MS = 20;
const DATA_MS = 60;
const STATUS_MS = 1000;

type Mode = 'takeover' | 'observe' | 'off';

interface Session {
	doc?: string;
	fileName: string;
	raw: string;
	netlist: string;
	report?: ReturnType<typeof rewriteNetlist>['report'];
	customs: string[];
	at: number;
}

let factory: SimFactory | undefined;
let wasmModule: WebAssembly.Module | undefined;
let engine: SimEngine | undefined;
let session: Session | undefined;
let stats = new Map<string, SeriesStat>();
let stepTimer: ReturnType<typeof setInterval> | undefined;
let dataTimer: ReturnType<typeof setInterval> | undefined;
let statusTimer: ReturnType<typeof setInterval> | undefined;
let running = false;
let lastError = '';
let speed = 0;
const events: string[] = [];

function cfg<T>(key: string, fallback: T): T {
	try {
		const v = eda.sys_Storage.getExtensionUserConfig(key);
		return v === undefined || v === null ? fallback : v as T;
	}
	catch {
		return fallback;
	}
}

function mode(): Mode {
	const m = cfg<string>(MODE_KEY, 'takeover');
	return m === 'observe' || m === 'off' ? m : 'takeover';
}

function note(msg: string): void {
	events.push(`${new Date().toLocaleTimeString()} ${msg}`);
	if (events.length > 30)
		events.splice(0, events.length - 30);
}

function publish(topic: string, message: unknown): void {
	try {
		eda.sys_MessageBus.publish(topic, message);
	}
	catch {}
}

function push(type: string, props: unknown): void {
	try {
		eda.sch_SimulationEngine.pushData(type as any, props as any);
	}
	catch {}
}

async function loadFactory(): Promise<SimFactory> {
	if (!factory) {
		const fs = (eda as any).sys_FileSystem;
		factory = await factoryFromSource(simSource, (blob) => {
			try {
				return fs?.createObjectURL?.(blob);
			}
			catch {
				return undefined;
			}
		});
	}
	return factory;
}

async function loadWasm(): Promise<WebAssembly.Module> {
	if (!wasmModule) {
		const file: File | undefined = await eda.sys_FileSystem.getExtensionFile(WASM_PATH)
			?? await eda.sys_FileSystem.getExtensionFile(WASM_PATH.slice(1));
		if (!file)
			throw new Error('扩展包内缺少 wasm/lceda-pro-sim-server.wasm');
		wasmModule = await WebAssembly.compile(await file.arrayBuffer());
	}
	return wasmModule;
}

/** 每个会话使用全新实例（释放上一次的 WASM 堆，避免反复加载累积泄漏） */
async function freshEngine(): Promise<SimEngine> {
	disposeEngine();
	const [f, m] = await Promise.all([loadFactory(), loadWasm()]);
	engine = await SimEngine.create(f, { module: m });
	return engine;
}

/**
 * 测试专用实例：与 EDA 仿真会话互不干扰；每 20 次测试重建一次以回收 WASM 堆
 */
let tester: SimEngine | undefined;
let testRuns = 0;
async function testEngine(): Promise<SimEngine> {
	if (!tester || testRuns >= 20) {
		const [f, m] = await Promise.all([loadFactory(), loadWasm()]);
		tester = await SimEngine.create(f, { module: m });
		testRuns = 0;
	}
	return tester;
}

function stopTimers(): void {
	if (stepTimer)
		clearInterval(stepTimer);
	if (dataTimer)
		clearInterval(dataTimer);
	stepTimer = undefined;
	dataTimer = undefined;
	running = false;
}

function disposeEngine(): void {
	stopTimers();
	if (engine) {
		try {
			engine.stop();
		}
		catch {}
	}
	engine = undefined;
}

function startTimers(): void {
	if (running || !engine)
		return;
	running = true;
	stepTimer = setInterval(() => {
		const e = engine;
		if (!e || !running)
			return;
		try {
			if (e.state() === 5)
				e.step();
		}
		catch (err) {
			lastError = `仿真步进出错：${String(err)}`;
			note(lastError);
			stopTimers();
			push('ENGINE_ERROR', { message: lastError });
		}
	}, STEP_MS);
	dataTimer = setInterval(() => {
		const e = engine;
		if (!e || !running)
			return;
		try {
			if (e.state() !== 5)
				return;
			const json = e.data();
			if (json && json.trim() !== '{}') {
				push('STREAM_DATA', json);
				accumulate(stats, json);
			}
		}
		catch (err) {
			lastError = `读取仿真数据出错：${String(err)}`;
			note(lastError);
			stopTimers();
		}
	}, DATA_MS);
}

function readCustoms(): CustomSimComponent[] {
	return decodeCustomList(cfg<unknown>(STORAGE_KEY, '[]'));
}

function readBindings(doc?: string): SimBinding[] {
	let list: Array<SimBinding & { doc?: string }> = [];
	try {
		const raw = cfg<unknown>(BINDINGS_KEY, '[]');
		const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
		if (Array.isArray(v))
			list = v;
	}
	catch {}
	return list.filter(b => b && b.model && (!b.doc || !doc || b.doc === doc));
}

async function currentDoc(): Promise<string | undefined> {
	try {
		const d = await eda.dmt_SelectControl.getCurrentDocumentInfo();
		return d?.uuid;
	}
	catch {
		return undefined;
	}
}

/** 准备网表：安装自定义元件 + 改写绑定的外壳芯片 */
function prepare(raw: string, doc: string | undefined, e: SimEngine | undefined): Pick<Session, 'netlist' | 'report' | 'customs'> {
	const customs = readCustoms();
	if (e)
		e.installCustom(customs);
	if (!customs.length)
		return { netlist: raw, customs: [] };
	const shellPins = (shell: string) => {
		if (!e)
			return undefined;
		const it = e.listBuiltin().find(x => x.name.toUpperCase() === shell.toUpperCase());
		const folder = it?.folder ?? 'ICs';
		const n = it?.name ?? shell;
		const xml = e.readFile(`/config/data/${folder}/${n}/${n}.package`) ?? e.readFile(`/config/data/${folder}/${n}/${n}_LS.package`);
		return xml ? parsePackagePins(xml) : undefined;
	};
	const { netlist, report } = rewriteNetlist(raw, readBindings(doc), customs, shellPins);
	return { netlist, report, customs: customs.map(c => c.name) };
}

function remember(s: Session): void {
	session = s;
	try {
		// 体积上限保护：只保存前 400 KB
		void eda.sys_Storage.setExtensionUserConfig(NETLIST_KEY, JSON.stringify({ doc: s.doc, fileName: s.fileName, at: s.at, raw: s.raw.slice(0, 400_000) }));
	}
	catch {}
}

async function startSession(fileName: string, raw: string): Promise<void> {
	const doc = await currentDoc();
	stats = new Map();
	lastError = '';
	if (mode() !== 'takeover') {
		const p = prepare(raw, doc, undefined);
		remember({ doc, fileName, raw, ...p, at: Date.now() });
		note('已记录仿真网表（仅观察模式，未运行）');
		broadcast();
		return;
	}
	const e = await freshEngine();
	const p = prepare(raw, doc, e);
	remember({ doc, fileName, raw, ...p, at: Date.now() });
	const r = e.load(p.netlist, fileName);
	if (r !== 0) {
		lastError = `电路加载失败（返回 ${r}）：${e.errorLogs(5).join('；')}`;
		note(lastError);
		push('ENGINE_ERROR', { message: lastError });
		broadcast();
		return;
	}
	e.start();
	if (speed)
		e.setSpeed(speed);
	startTimers();
	const rep = p.report?.replaced.length ? `，替换自定义元件 ${p.report.replaced.map(x => `${x.circId}→${x.model}`).join('、')}` : '';
	note(`仿真已开始${rep}`);
	broadcast();
}

function snapshot(limit = 80): Array<{ key: string; last: number | string; min?: number; max?: number; samples: number }> {
	return [...stats.entries()].slice(0, limit).map(([key, s]) => ({ key, last: s.last, min: s.min, max: s.max, samples: s.samples }));
}

function status(): Record<string, unknown> {
	const st = engine ? engine.state() : 0;
	return {
		mode: mode(),
		engineLoaded: !!engine,
		state: engine ? (SIM_STATE[st] ?? String(st)) : 'stopped',
		running,
		timeUs: engine ? Math.round(engine.time() / 1e6) : 0,
		speed,
		doc: session?.doc,
		netlistAt: session?.at,
		netlistItems: session ? (session.raw.match(/<item\b/g)?.length ?? 0) : 0,
		customsInstalled: session?.customs ?? [],
		rewrite: session?.report,
		values: snapshot(),
		lastError,
		engineErrors: engine ? engine.errorLogs(8) : [],
		events: events.slice(-10),
		at: Date.now(),
	};
}

function broadcast(): void {
	publish(TOPIC_SIM_STATUS, status());
}

async function handleCmd(msg: any): Promise<unknown> {
	const a = msg?.args ?? {};
	switch (msg?.cmd) {
		case 'status':
			return status();
		case 'netlist':
			return session ? { doc: session.doc, fileName: session.fileName, at: session.at, raw: session.raw, netlist: session.netlist, report: session.report } : undefined;
		case 'pause':
			if (!engine)
				throw new Error('当前没有运行中的仿真');
			stopTimers();
			engine.pause();
			return status();
		case 'resume':
			if (!engine)
				throw new Error('当前没有可恢复的仿真');
			engine.resume();
			startTimers();
			return status();
		case 'stop':
			disposeEngine();
			note('Agent 停止了仿真');
			return status();
		case 'speed': {
			const v = Math.max(1, Math.min(100, Math.round(Number(a.value) || 1)));
			speed = v;
			engine?.setSpeed(v);
			return status();
		}
		case 'update': {
			if (!engine)
				throw new Error('当前没有运行中的仿真');
			const ok = engine.update(String(a.id), String(a.attr), String(a.value));
			note(`修改 ${a.id}.${a.attr} = ${a.value}：${ok ? '成功' : '失败'}`);
			return { ok, status: status() };
		}
		case 'restart': {
			if (!session)
				throw new Error('还没有捕获过仿真网表：请先在 EDA 中点击「仿真 → 运行」一次');
			if (mode() !== 'takeover')
				throw new Error('当前为仅观察模式，无法由 Agent 运行仿真');
			await startSession(session.fileName, session.raw);
			return status();
		}
		case 'offline': {
			const raw = typeof a.netlist === 'string' && a.netlist ? a.netlist : session?.raw;
			if (!raw)
				throw new Error('还没有捕获过仿真网表：请先在 EDA 中点击「仿真 → 运行」一次，或传入 netlist');
			const e = await testEngine();
			testRuns++;
			const p = prepare(raw, session?.doc, e);
			const r = e.run(p.netlist, Number(a.steps) || 500);
			e.installCustom([]);
			return { load: r.load, state: r.state, simTimeUs: Math.round(r.timePs / 1e6), rewrite: p.report, values: [...r.stats.entries()].slice(0, 120).map(([key, v]) => ({ key, last: v.last, min: v.min, max: v.max, samples: v.samples })), errors: r.errors.slice(0, 12) };
		}
		case 'lib_search': {
			const e = await testEngine();
			const kw = String(a.keyword ?? '').trim().toUpperCase();
			const list = e.listBuiltin().filter(x => !kw || x.name.toUpperCase().includes(kw) || x.info.toUpperCase().includes(kw) || x.category.toUpperCase().includes(kw));
			return { total: list.length, items: list.slice(0, Math.min(60, Number(a.limit) || 30)).map(x => ({ name: x.name, info: x.info, category: x.category, type: x.type })) };
		}
		case 'lib_get': {
			const e = await testEngine();
			const name = String(a.name ?? '');
			const pins = e.builtinPins(name);
			if (!pins)
				throw new Error(`内置库中没有 ${name}（或它不是子电路，没有封装文件）`);
			return { name, pins: pins.map((p, i) => ({ number: i + 1, ...p })), circuit: a.with_circuit ? e.builtinCircuit(name) : undefined };
		}
		case 'shells': {
			const e = await testEngine();
			return { pinCount: Number(a.pins), candidates: e.shellCandidates(Number(a.pins) || 14, 8) };
		}
		case 'test': {
			const def = a.component as CustomSimComponent;
			if (!def?.name || !Array.isArray(def.pins) || typeof def.circuit !== 'string')
				throw new Error('缺少要测试的元件定义');
			const e = await testEngine();
			testRuns++;
			const inputs: string[] = Array.isArray(a.inputs) && a.inputs.length ? a.inputs.map(String) : inferInputs(def);
			let vectors: TruthVector[] = Array.isArray(a.vectors) && a.vectors.length ? a.vectors : autoVectors(inputs);
			const outputs: string[] = Array.isArray(a.outputs) && a.outputs.length ? a.outputs.map(String) : inferOutputs(def, vectors);
			if (!outputs.length)
				throw new Error('无法推断输出引脚，请指定 outputs');
			// 门级描述且未给期望值：用 JS 求值生成期望，便于自动判定
			if (def.gates?.length)
				vectors = vectors.map(v => v.expect ? v : { ...v, expect: Object.fromEntries(Object.entries(evalGates(def.gates!, Object.fromEntries(Object.entries(v.inputs).map(([k, x]) => [k, Number(x) ? 1 : 0])))).filter(([k, x]) => outputs.includes(k) && x !== 'X')) as Record<string, number> });
			const r = runTruthTable(e, def, vectors, outputs, Number(a.steps) || 200);
			e.installCustom([]);
			return { inputs, outputs, ...r };
		}
		default:
			throw new Error(`未知命令 ${msg?.cmd}`);
	}
}

/** 在扩展激活时调用 */
export function initSimulation(): void {
	subscribeCommands();
	if (mode() === 'off')
		return;
	try {
		eda.sch_Event.addSimulationEnginePullEventListener('jlc-agent-sim-engine', 'all', async (eventType: any, props: any) => {
			try {
				switch (eventType) {
					case 'SESSION_START': {
						const raw = props?.fileContent ?? props?.content ?? props?.netlist ?? props?.raw ?? '';
						const name = props?.fileName ?? props?.filename ?? props?.name ?? 'circuit.sim1';
						if (raw)
							await startSession(String(name), String(raw));
						break;
					}
					case 'SESSION_PAUSE':
						if (mode() === 'takeover' && engine) {
							stopTimers();
							engine.pause();
						}
						break;
					case 'SESSION_RESUME':
						if (mode() === 'takeover' && engine) {
							engine.resume();
							startTimers();
						}
						break;
					case 'SESSION_STOP':
						if (mode() === 'takeover')
							disposeEngine();
						note('仿真已停止');
						break;
					case 'SPEED_SET': {
						const v = Number(props?.speed ?? props?.value ?? 0);
						if (Number.isFinite(v) && v > 0) {
							speed = Math.max(1, Math.min(100, Math.round(v)));
							if (mode() === 'takeover' && running)
								engine?.setSpeed(speed);
						}
						break;
					}
					case 'COMPONENT_UPDATE': {
						const id = props?.updateCirID ?? props?.id ?? props?.componentId;
						const attr = props?.attrInput ?? props?.attr ?? props?.key;
						const val = props?.updateValueStr ?? props?.value ?? props?.val;
						if (mode() === 'takeover' && engine && id && attr)
							engine.update(String(id), String(attr), String(val ?? ''));
						break;
					}
					case 'SESSION_STATE_QUERY':
						if (mode() === 'takeover')
							push('SESSION_STATE', { state: engine ? (SIM_STATE[engine.state()] ?? 'stopped').toUpperCase() : 'STOPPED' });
						break;
				}
			}
			catch (err) {
				lastError = `处理仿真事件 ${eventType} 出错：${String(err)}`;
				note(lastError);
				if (mode() === 'takeover')
					push('ENGINE_ERROR', { message: lastError });
			}
			broadcast();
		});
	}
	catch (e) {
		console.warn('[EDA Agent] 注册仿真引擎监听失败', e);
	}
}

function subscribeCommands(): void {
	try {
		eda.sys_MessageBus.subscribe(TOPIC_SIM_CMD, (msg: any) => {
			void (async () => {
				try {
					const result = await handleCmd(msg);
					publish(TOPIC_SIM_REPLY, { reqId: msg?.reqId, ok: true, result });
				}
				catch (err) {
					publish(TOPIC_SIM_REPLY, { reqId: msg?.reqId, ok: false, error: err instanceof Error ? err.message : String(err) });
				}
			})();
		});
	}
	catch {}
	statusTimer = setInterval(() => {
		if (running)
			broadcast();
	}, STATUS_MS);
	void statusTimer;
}
