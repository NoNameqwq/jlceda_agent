/**
 * SimulIDE 仿真工具（侧边栏侧）
 *
 * 引擎运行在扩展主线程（src/sim/live.ts），这里通过消息总线 RPC 调用：
 *   jlc-agent:sim-cmd   { reqId, cmd, args }  →  主线程
 *   jlc-agent:sim-reply { reqId, ok, result | error }  ←  主线程
 * 自定义元件与绑定关系保存在扩展用户配置中，主线程开始仿真时读取。
 */
import type { CustomSimComponent, SimGateDef, SimPinDef } from '../../src/sim/simulide';
import type { ToolDef } from './registry';
import { BIND_PROP, buildGateCircuit, decodeCustomList, NAME_RE, STORAGE_KEY, validatePins } from '../../src/sim/simulide';
import { callEda, getEda } from '../lib/eda';
import { uid } from '../lib/util';
import { defineTools, S } from './registry';

const TOPIC_CMD = 'jlc-agent:sim-cmd';
const TOPIC_REPLY = 'jlc-agent:sim-reply';
const TOPIC_STATUS = 'jlc-agent:sim-status';
const BINDINGS_KEY = 'simBindings';
export const SIM_MODE_KEY = 'simEngineMode';

// ———————————————————————— RPC ————————————————————————

const pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
let subscribed = false;
let lastStatus: any;

function bus(): any {
	const b = getEda()?.sys_MessageBus;
	if (!b)
		throw new Error('未检测到 EDA 消息总线，仿真工具不可用');
	return b;
}

function ensureSubscribed(): void {
	if (subscribed)
		return;
	const b = bus();
	b.subscribe(TOPIC_REPLY, (m: any) => {
		const p = m?.reqId ? pending.get(m.reqId) : undefined;
		if (!p)
			return;
		pending.delete(m.reqId);
		clearTimeout(p.timer);
		if (m.ok)
			p.resolve(m.result);
		else
			p.reject(new Error(String(m.error ?? '仿真命令失败')));
	});
	try {
		b.subscribe(TOPIC_STATUS, (m: any) => {
			lastStatus = m;
		});
	}
	catch {}
	subscribed = true;
}

export function simCall<T = any>(cmd: string, args: Record<string, unknown> = {}, timeoutMs = 30_000, signal?: AbortSignal): Promise<T> {
	ensureSubscribed();
	const reqId = uid('sim_');
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			pending.delete(reqId);
			reject(new Error(`仿真引擎 ${Math.round(timeoutMs / 1000)} 秒未响应（命令 ${cmd}）。请确认本扩展已启用并在 EDA 中重新加载过；首次加载 SimulIDE 引擎需要几秒。`));
		}, timeoutMs);
		pending.set(reqId, { resolve, reject, timer });
		signal?.addEventListener('abort', () => {
			if (pending.delete(reqId)) {
				clearTimeout(timer);
				const e = new Error('已中止');
				e.name = 'AbortError';
				reject(e);
			}
		});
		try {
			bus().publish(TOPIC_CMD, { reqId, cmd, args });
		}
		catch (e) {
			pending.delete(reqId);
			clearTimeout(timer);
			reject(e instanceof Error ? e : new Error(String(e)));
		}
	});
}

export function lastSimStatus(): any {
	return lastStatus;
}

// ———————————————————————— 存储 ————————————————————————

function store(): any {
	const s = getEda()?.sys_Storage;
	if (!s)
		throw new Error('未检测到 EDA 存储接口');
	return s;
}

export function readCustoms(): CustomSimComponent[] {
	try {
		return decodeCustomList(store().getExtensionUserConfig(STORAGE_KEY) ?? '[]');
	}
	catch {
		return [];
	}
}

async function writeCustoms(list: CustomSimComponent[]): Promise<void> {
	await store().setExtensionUserConfig(STORAGE_KEY, JSON.stringify(list));
}

interface Binding { designator?: string; componentName?: string; model: string; doc?: string; at: number }

function readBindings(): Binding[] {
	try {
		const raw = store().getExtensionUserConfig(BINDINGS_KEY) ?? '[]';
		const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
		return Array.isArray(v) ? v : [];
	}
	catch {
		return [];
	}
}

async function writeBindings(list: Binding[]): Promise<void> {
	await store().setExtensionUserConfig(BINDINGS_KEY, JSON.stringify(list));
}

export function readSimMode(): 'takeover' | 'observe' | 'off' {
	try {
		const m = store().getExtensionUserConfig(SIM_MODE_KEY);
		return m === 'observe' || m === 'off' ? m : 'takeover';
	}
	catch {
		return 'takeover';
	}
}

export function writeSimMode(m: 'takeover' | 'observe' | 'off'): void {
	try {
		void store().setExtensionUserConfig(SIM_MODE_KEY, m);
	}
	catch {}
}

// ———————————————————————— 参数 Schema ————————————————————————

const PIN_SCHEMA = S.obj({
	number: S.int('物理引脚号，从 1 连续编号'),
	id: S.str('引脚 ID（字母数字下划线，如 A、B、Y、GND、VCC、NC9）；门电路的输入/输出网络名直接写这个 ID'),
	label: S.str('显示名（可选）'),
	type: S.enum(['', 'unused', 'inverted'], '\'\' 普通；unused = 电源/地/NC 等不参与逻辑仿真的引脚；inverted = 显示反相圈'),
	side: S.enum(['left', 'right'], '放在封装哪一侧（可选，缺省按 DIP 排列）'),
}, ['number', 'id']);

const GATE_SCHEMA = S.obj({
	type: S.enum(['and', 'nand', 'or', 'nor', 'xor', 'xnor', 'buffer', 'not'], '门类型；and/nand/or/nor 支持 2~16 输入，xor/xnor 仅 2 输入，buffer/not 1 输入'),
	inputs: S.arr(S.str('引脚 ID / 内部网络名 / HIGH / LOW'), '输入网络'),
	output: S.str('输出网络：引脚 ID 或内部网络名（内部网络可再作为其它门的输入）'),
	open_collector: S.bool('开漏输出'),
	tpd_ns: S.num('传播延时 ns，默认 10'),
}, ['type', 'inputs', 'output']);

const VECTOR_SCHEMA = S.obj({
	inputs: { type: 'object', description: '输入引脚 ID → 0/1', additionalProperties: true },
	expect: { type: 'object', description: '期望输出引脚 ID → 0/1（可选；门级元件可自动计算）', additionalProperties: true },
}, ['inputs']);

function compact(r: any): any {
	if (!r || !Array.isArray(r.rows))
		return r;
	const failed = r.rows.filter((x: any) => x.pass === false);
	const fmt = (x: any) => ({
		in: Object.entries(x.inputs).map(([k, v]) => `${k}=${v}`).join(' '),
		out: Object.entries(x.outputs).map(([k, v]: [string, any]) => `${k}=${v.logic}(${v.volt ?? '-'}V)`).join(' '),
		expect: x.expect ? Object.entries(x.expect).map(([k, v]) => `${k}=${v}`).join(' ') : undefined,
		pass: x.pass,
	});
	return {
		summary: r.checked ? `${r.passed}/${r.checked} 组通过` : `已运行 ${r.total} 组（无期望值，未判定）`,
		inputs: r.inputs,
		outputs: r.outputs,
		simTimeUs: r.simTimeUs,
		failed: failed.slice(0, 16).map(fmt),
		rows: r.rows.length <= 40 ? r.rows.map(fmt) : undefined,
		errors: r.errors?.length ? r.errors : undefined,
	};
}

async function findComponentByDesignator(designator: string): Promise<{ id: string; name?: string } | undefined> {
	const list = await callEda<any[]>('sch_PrimitiveComponent.getAll', undefined, false).catch(() => []);
	for (const c of list ?? []) {
		try {
			if (String(c.getState_Designator?.() ?? '') === designator)
				return { id: String(c.getState_PrimitiveId?.()), name: c.getState_Name?.() || c.getState_Component?.()?.name };
		}
		catch {}
	}
	return undefined;
}

// ———————————————————————— 工具 ————————————————————————

const simTools: ToolDef[] = [
	{
		name: 'sim_status',
		title: '仿真状态',
		group: 'sim',
		risk: 'read',
		description: '查看 SimulIDE 动态仿真状态：引擎模式、运行状态、仿真时间、已安装的自定义元件、网表改写报告，以及探针/仪表的最新读数（last/min/max）和引擎报错。',
		parameters: S.obj({}),
		async run(_a, ctx) {
			return simCall('status', {}, 15_000, ctx.signal);
		},
	},
	{
		name: 'sim_control',
		title: '控制仿真',
		group: 'sim',
		risk: 'write',
		description: '控制当前仿真会话：pause 暂停 / resume 继续 / stop 停止 / speed 设置速度(1-100) / restart 用最近捕获的网表重新运行（会安装最新的自定义元件）。开始仿真需用户在 EDA 点击「仿真 → 运行」，之后 Agent 才能 restart。',
		parameters: S.obj({
			action: S.enum(['pause', 'resume', 'stop', 'speed', 'restart'], '操作'),
			value: S.num('speed 时的速度值 1-100'),
		}, ['action']),
		summarize: a => `${a.action}${a.value ? ` ${a.value}` : ''}`,
		async run(a, ctx) {
			return simCall(String(a.action), { value: a.value }, a.action === 'restart' ? 90_000 : 15_000, ctx.signal);
		},
	},
	{
		name: 'sim_set_property',
		title: '修改仿真参数',
		group: 'sim',
		risk: 'write',
		description: '仿真运行中实时修改元件属性（等同于在右侧仿真属性面板修改），例如电压源 Voltage、电阻 Resistance、开关状态。id 为网表中的 CircId（用 sim_get_netlist 查看），attr 为 SimulIDE 属性名，value 带单位，如 "3.3 V"、"10 kΩ"。只影响本次仿真，不写回原理图。',
		parameters: S.obj({
			id: S.str('元件 CircId，如 "Fixed Voltage-12"'),
			attr: S.str('属性名，如 Voltage / Resistance / Out'),
			value: S.str('新值（字符串，可带单位）'),
		}, ['id', 'attr', 'value']),
		summarize: a => `${a.id}.${a.attr} = ${a.value}`,
		async run(a, ctx) {
			return simCall('update', { id: a.id, attr: a.attr, value: a.value }, 15_000, ctx.signal);
		},
	},
	{
		name: 'sim_get_netlist',
		title: '读取仿真网表',
		group: 'sim',
		risk: 'read',
		description: '读取最近一次仿真时 EDA 生成的 SimulIDE 网表（.sim1 XML，每行一个 item：元件 itemtype/CircId/属性，Connector 表示连接）。用于分析电路结构、找到元件 CircId、确认外壳芯片是否被替换。可只看摘要。',
		parameters: S.obj({
			mode: S.enum(['summary', 'raw', 'rewritten'], 'summary = 元件列表（默认）；raw = 原始网表；rewritten = 替换自定义元件后的网表'),
			max_chars: S.int('raw/rewritten 时最多返回字符数，默认 12000'),
		}),
		async run(a, ctx) {
			const r = await simCall<any>('netlist', {}, 15_000, ctx.signal);
			if (!r)
				return { captured: false, hint: '还没有捕获网表：请让用户在 SimulIDE 仿真图页点击「仿真 → 运行」一次（本扩展需处于接管或观察模式）。' };
			const max = Math.max(1000, Number(a.max_chars) || 12_000);
			if (a.mode === 'raw' || a.mode === 'rewritten') {
				const text = String(a.mode === 'raw' ? r.raw : r.netlist);
				return { doc: r.doc, at: r.at, length: text.length, text: text.slice(0, max), truncated: text.length > max };
			}
			const items: any[] = [];
			let connectors = 0;
			for (const line of String(r.raw).split('\n')) {
				const m = /<item itemtype="([^"]+)"([^>]*)/.exec(line);
				if (!m)
					continue;
				if (m[1] === 'Connector') {
					connectors++;
					continue;
				}
				const attrs: Record<string, string> = {};
				for (const x of m[2].matchAll(/([\w.:-]+)="([^"]*)"/g)) {
					if (!/^(mainComp|Show_id|Show_Val|Pos|rotation|hflip|vflip|idLabPos|labelrot|valLabPos|valLabRot)$/.test(x[1]))
						attrs[x[1]] = x[2];
				}
				items.push({ itemtype: m[1], ...attrs });
			}
			return { doc: r.doc, at: r.at, components: items.slice(0, 150), componentCount: items.length, connectors, rewrite: r.report };
		},
	},
	{
		name: 'sim_run_offline',
		title: '离线仿真',
		group: 'sim',
		risk: 'read',
		description: '在后台独立引擎中运行一次仿真（不影响 EDA 界面上的仿真），返回所有探针/仪表的读数与引擎报错。默认使用最近捕获的网表（含自定义元件替换）；也可传入完整 .sim1 网表做实验。steps 每步 1µs 仿真时间。',
		parameters: S.obj({
			steps: S.int('仿真步数，默认 500，最大 20000'),
			netlist: S.str('可选：自定义 .sim1 网表全文'),
		}),
		summarize: a => `${a.steps ?? 500} 步`,
		async run(a, ctx) {
			return simCall('offline', { steps: a.steps, netlist: a.netlist }, 120_000, ctx.signal);
		},
	},
	{
		name: 'sim_lib_search',
		title: '搜索仿真元件库',
		group: 'sim',
		risk: 'read',
		description: '搜索 SimulIDE 引擎内置元件库（74/CD 系列、MCU、显示器等子电路，约 450 个）。用于确认某型号是否已有内置仿真模型、找参考实现，或寻找引脚数相同的「外壳」芯片。',
		parameters: S.obj({
			keyword: S.str('关键字，如 74HC、NAND、CD40'),
			limit: S.int('返回数量，默认 30'),
		}),
		summarize: a => a.keyword ?? '',
		async run(a, ctx) {
			return simCall('lib_search', { keyword: a.keyword, limit: a.limit }, 60_000, ctx.signal);
		},
	},
	{
		name: 'sim_lib_get',
		title: '内置仿真元件详情',
		group: 'sim',
		risk: 'read',
		description: '获取内置子电路的封装引脚（物理顺序 1..N 与引脚 ID），可选返回其 .sim1 子电路，用作编写自定义元件的参考（例如参考 74HC00 的门级实现写 74HC30）。',
		parameters: S.obj({
			name: S.str('内置元件名，如 74HC00'),
			with_circuit: S.bool('同时返回子电路 .sim1 文本'),
		}, ['name']),
		summarize: a => a.name,
		async run(a, ctx) {
			return simCall('lib_get', { name: a.name, with_circuit: !!a.with_circuit }, 60_000, ctx.signal);
		},
	},
	{
		name: 'sim_component_create',
		title: '创建仿真元件',
		group: 'sim',
		risk: 'write',
		description: `创建（或覆盖同名的）自定义 SimulIDE 仿真元件，例如 SimulIDE 内置库没有的 74HC30（8 输入与非门）。
两种描述方式：
1. gates（推荐）：用逻辑门网表描述内部逻辑，门的输入/输出直接写引脚 ID 或内部网络名，自动生成子电路；
2. circuit：直接给出 .sim1 子电路 XML（高级；子电路用与引脚 ID 同名的 Tunnel 连接外部引脚，可参考 sim_lib_get 返回的内置实现）。
创建后默认自动运行真值表测试（≤6 输入穷举，否则全 0/全 1/逐位翻转），并返回可作为 EDA 外壳的同引脚数内置芯片。
注意：EDA 仿真图里无法直接放置这个新元件，需要放置一个引脚数相同的外壳芯片（如 14 脚的 74HC00），再用 sim_bind 绑定；仿真时外壳会被替换为本元件，按物理引脚号对应。`,
		parameters: S.obj({
			name: S.str('元件名（字母开头，字母数字下划线），如 74HC30。不要与内置元件同名'),
			info: S.str('一句话说明，如 8-input NAND gate'),
			pins: S.arr(PIN_SCHEMA, '全部物理引脚（含电源/地/NC，标为 unused）'),
			gates: S.arr(GATE_SCHEMA, '逻辑门网表（与 circuit 二选一）'),
			circuit: S.str('子电路 .sim1 XML（与 gates 二选一）'),
			test: S.bool('创建后是否立即测试，默认 true'),
		}, ['name', 'pins']),
		summarize: a => `${a.name}（${a.pins?.length ?? 0} 脚${a.gates ? `，${a.gates.length} 个门` : ''}）`,
		async run(a, ctx) {
			const name = String(a.name ?? '').trim();
			if (!NAME_RE.test(name))
				throw new Error('元件名只能含字母数字下划线，且不能以数字开头之外的符号开头');
			const pins: SimPinDef[] = (a.pins ?? []).map((p: any) => ({
				number: Number(p.number),
				id: String(p.id ?? '').trim(),
				label: p.label ? String(p.label) : undefined,
				type: p.type === 'unused' || p.type === 'inverted' ? p.type : '',
				side: p.side === 'left' || p.side === 'right' ? p.side : undefined,
			}));
			const perr = validatePins(pins);
			if (perr.length)
				throw new Error(`引脚定义有误：${perr.join('；')}`);
			let circuit = '';
			let gates: SimGateDef[] | undefined;
			let warnings: string[] = [];
			if (Array.isArray(a.gates) && a.gates.length) {
				gates = a.gates.map((g: any) => ({ type: g.type, inputs: (g.inputs ?? []).map(String), output: String(g.output ?? ''), open_collector: !!g.open_collector, tpd_ns: g.tpd_ns !== undefined ? Number(g.tpd_ns) : undefined }));
				const r = buildGateCircuit(pins, gates!);
				if (r.errors.length)
					throw new Error(`门网表有误：${r.errors.join('；')}`);
				circuit = r.circuit;
				warnings = r.warnings;
			}
			else if (typeof a.circuit === 'string' && a.circuit.includes('<circuit')) {
				circuit = a.circuit;
				const tunnels = new Set([...a.circuit.matchAll(/itemtype="Tunnel"[^>]*\bName="([^"]+)"/g)].map(m => m[1]));
				for (const p of pins) {
					if (p.type !== 'unused' && !tunnels.has(p.id))
						warnings.push(`子电路中没有名为 ${p.id} 的 Tunnel，引脚 ${p.number} 将悬空`);
				}
			}
			else {
				throw new Error('需要提供 gates 或 circuit');
			}
			const now = Date.now();
			const list = readCustoms();
			const old = list.find(c => c.name === name);
			const def: CustomSimComponent = { name, info: a.info ? String(a.info) : old?.info, pins, circuit, source: gates ? 'gates' : 'raw', gates, createdAt: old?.createdAt ?? now, updatedAt: now };
			let builtinClash = false;
			try {
				const s = await simCall<any>('lib_search', { keyword: name, limit: 5 }, 60_000, ctx.signal);
				builtinClash = (s?.items ?? []).some((x: any) => String(x.name).toUpperCase() === name.toUpperCase());
			}
			catch {}
			if (builtinClash)
				throw new Error(`内置库已有 ${name}，无需新建；如需修改行为请换一个名字（如 ${name}_X）`);
			let test: any;
			if (a.test !== false) {
				try {
					test = await simCall<any>('test', { component: def }, 120_000, ctx.signal);
					def.lastTest = { passed: test.passed, total: test.checked || test.total, at: Date.now() };
				}
				catch (e) {
					test = { error: e instanceof Error ? e.message : String(e) };
				}
			}
			let shells: string[] = [];
			try {
				shells = (await simCall<any>('shells', { pins: pins.length }, 60_000, ctx.signal))?.candidates ?? [];
			}
			catch {}
			def.shell = old?.shell ?? shells[0];
			await writeCustoms([...list.filter(c => c.name !== name), def]);
			ctx.recordChange([{ op: 'other', kind: 'sim_CustomComponent', label: `${old ? '更新' : '创建'}仿真元件 ${name}`, after: { name, pins: pins.length, gates: gates?.length } }], { undoable: false, summary: name, note: '自定义仿真元件保存在扩展配置中，可用 sim_component_delete 删除' });
			return {
				saved: name,
				updated: !!old,
				pins: pins.length,
				warnings: warnings.length ? warnings : undefined,
				test: test ? compact(test) : '未测试',
				shellCandidates: shells,
				next: `在仿真图中放置一个 ${pins.length} 脚的外壳芯片（推荐 ${shells.slice(0, 3).join(' / ') || '同引脚数的 74 系列'}，用 lib_search_device 搜索并 sch_place_component 放置），按 ${name} 的引脚号接线，然后调用 sim_bind 绑定位号。`,
			};
		},
	},
	{
		name: 'sim_component_test',
		title: '测试仿真元件',
		group: 'sim',
		risk: 'read',
		description: '在独立引擎中对自定义元件运行真值表测试，返回每组输入下输出引脚的电压与逻辑值（≥3.5V=1，≤1.5V=0）。不给 vectors 时自动生成；门级元件自动计算期望值并判定通过与否。',
		parameters: S.obj({
			name: S.str('自定义元件名'),
			vectors: S.arr(VECTOR_SCHEMA, '测试向量（可选）'),
			outputs: S.arr(S.str('引脚 ID'), '要观测的输出引脚（可选）'),
			steps: S.int('每次运行步数（1µs/步），默认 200；时序电路可加大'),
		}, ['name']),
		summarize: a => a.name,
		async run(a, ctx) {
			const def = readCustoms().find(c => c.name === a.name);
			if (!def)
				throw new Error(`没有名为 ${a.name} 的自定义元件（用 sim_component_list 查看）`);
			const r = await simCall<any>('test', { component: def, vectors: a.vectors, outputs: a.outputs, steps: a.steps }, 120_000, ctx.signal);
			const list = readCustoms();
			const it = list.find(c => c.name === def.name);
			if (it) {
				it.lastTest = { passed: r.passed, total: r.checked || r.total, at: Date.now() };
				await writeCustoms(list).catch(() => {});
			}
			return compact(r);
		},
	},
	{
		name: 'sim_component_list',
		title: '自定义仿真元件',
		group: 'sim',
		risk: 'read',
		description: '列出 Agent 创建的全部自定义仿真元件、引脚、门级描述、最近测试结果，以及当前的外壳绑定关系。',
		parameters: S.obj({ name: S.str('只看某个元件的完整定义（含子电路）') }),
		async run(a) {
			const list = readCustoms();
			const bindings = readBindings();
			if (a.name) {
				const c = list.find(x => x.name === a.name);
				if (!c)
					throw new Error(`没有 ${a.name}`);
				return { ...c, bindings: bindings.filter(b => b.model === c.name) };
			}
			return {
				components: list.map(c => ({ name: c.name, info: c.info, pins: c.pins.map(p => `${p.number}:${p.id}${p.type ? `(${p.type})` : ''}`).join(' '), gates: c.gates?.length, source: c.source, shell: c.shell, lastTest: c.lastTest })),
				bindings,
			};
		},
	},
	{
		name: 'sim_component_delete',
		title: '删除仿真元件',
		group: 'sim',
		risk: 'danger',
		description: '删除自定义仿真元件，同时移除它的所有外壳绑定。',
		parameters: S.obj({ name: S.str('元件名') }, ['name']),
		summarize: a => a.name,
		async run(a, ctx) {
			const list = readCustoms();
			if (!list.some(c => c.name === a.name))
				throw new Error(`没有 ${a.name}`);
			await writeCustoms(list.filter(c => c.name !== a.name));
			await writeBindings(readBindings().filter(b => b.model !== a.name));
			ctx.recordChange([{ op: 'other', kind: 'sim_CustomComponent', label: `删除仿真元件 ${a.name}` }], { undoable: false });
			return { deleted: a.name };
		},
	},
	{
		name: 'sim_bind',
		title: '绑定外壳芯片',
		group: 'sim',
		risk: 'write',
		description: '把仿真图中一个已放置的外壳芯片（按位号，如 U1）绑定到自定义仿真元件。开始仿真时该芯片会被替换为自定义元件，按物理引脚号一一对应（外壳的第 n 脚 = 自定义元件的第 n 脚）。传 unbind=true 解除绑定。绑定后需重新运行仿真（用户点运行，或 sim_control restart）。',
		parameters: S.obj({
			designator: S.str('外壳芯片位号，如 U1'),
			model: S.str('自定义元件名，如 74HC30'),
			unbind: S.bool('解除绑定'),
		}, ['designator']),
		summarize: a => a.unbind ? `解除 ${a.designator}` : `${a.designator} → ${a.model}`,
		async run(a, ctx) {
			const des = String(a.designator).trim();
			const doc = ctx.editor.documentUuid;
			let list = readBindings().filter(b => !(b.designator === des && (!b.doc || !doc || b.doc === doc)));
			if (a.unbind) {
				await writeBindings(list);
				ctx.recordChange([{ op: 'other', kind: 'sim_Binding', label: `解除 ${des} 的仿真绑定` }], { undoable: false });
				return { unbound: des };
			}
			const model = String(a.model ?? '');
			const def = readCustoms().find(c => c.name === model);
			if (!def)
				throw new Error(`没有名为 ${model} 的自定义元件`);
			let comp: { id: string; name?: string } | undefined;
			if (ctx.editor.scene === 'sch')
				comp = await findComponentByDesignator(des);
			if (ctx.editor.scene === 'sch' && !comp)
				throw new Error(`当前图页找不到位号 ${des} 的器件`);
			list = [...list, { designator: des, componentName: comp?.name, model, doc, at: Date.now() }];
			await writeBindings(list);
			if (comp?.id) {
				// 在器件上留一个可见标记，便于用户识别（失败不影响绑定）
				await callEda('sch_PrimitiveComponent.modify', comp.id, { otherProperty: { [BIND_PROP]: model } }).catch(() => {});
			}
			ctx.recordChange([{ op: 'other', kind: 'sim_Binding', primitiveId: comp?.id, label: `${des} 绑定仿真模型 ${model}` }], { undoable: false });
			return {
				bound: des,
				model,
				shell: comp?.name,
				pinMap: def.pins.map(p => `${p.number}→${p.id}`).join(' '),
				next: '让用户点击「仿真 → 运行」（或在已有会话时调用 sim_control restart），再用 sim_status 查看 rewrite 报告确认替换成功、pinsMapped 不为 0。',
			};
		},
	},
];

export function registerSimTools(): void {
	defineTools(simTools);
}
