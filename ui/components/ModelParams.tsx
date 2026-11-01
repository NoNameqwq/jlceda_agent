/**
 * 单个模型的参数（嵌在「模型接口」的模型行内展开）
 * 上下文 / 最大输出 / 识图 / 思考强度 / Temperature / Top P，留空即使用自动识别值。
 */
import type { ModelInfo, ModelOverride, ProviderConfig, ThinkingLevel } from '../agent/types';
import type { Workspace } from '../agent/workspace';
import { defaultThinking, inferCapabilities, overrideKey, THINKING_LABEL, thinkingLevels } from '../agent/providers';
import { formatTokens } from '../lib/util';

function Num(props: { value?: number; placeholder?: string; onChange: (v: number | undefined) => void; step?: number; min?: number; max?: number }) {
	return (
		<input
			type="number"
			class="input sm"
			value={props.value ?? ''}
			placeholder={props.placeholder}
			step={props.step}
			min={props.min}
			max={props.max}
			onChange={(e) => {
				const raw = (e.target as HTMLInputElement).value.trim();
				const n = Number(raw);
				props.onChange(raw === '' || Number.isNaN(n) ? undefined : n);
			}}
		/>
	);
}

export function hasOverride(ws: Workspace, p: ProviderConfig, m: ModelInfo): boolean {
	const ov = ws.settings.overrides[overrideKey(p.id, m.id)];
	return !!ov && Object.keys(ov).length > 0;
}

export function ModelParams(props: { ws: Workspace; p: ProviderConfig; m: ModelInfo }) {
	const { ws, p, m } = props;
	const key = overrideKey(p.id, m.id);
	const ov: ModelOverride = ws.settings.overrides[key] ?? {};
	const inf = { ...inferCapabilities(m.id), ...m };
	const set = (x: Partial<ModelOverride>) => {
		const next: ModelOverride = { ...ov, ...x };
		for (const k of Object.keys(next) as Array<keyof ModelOverride>) {
			if (next[k] === undefined || (k === 'vision' && next[k] === 'auto'))
				delete next[k];
		}
		const overrides = { ...ws.settings.overrides };
		if (Object.keys(next).length)
			overrides[key] = next;
		else delete overrides[key];
		ws.updateSettings({ overrides });
	};
	const levels = thinkingLevels(p.kind);
	const thinking: ThinkingLevel = ov.thinking && levels.includes(ov.thinking) ? ov.thinking : defaultThinking(p.kind);
	const thinkingOff = thinking === 'off';

	return (
		<div class="model-params" onClick={e => e.stopPropagation()}>
			<div class="mp-grid">
				<label class="mp-field">
					<span>上下文</span>
					<Num value={ov.contextWindow} placeholder={formatTokens(inf.contextWindow ?? 0)} min={2048} onChange={v => set({ contextWindow: v })} />
				</label>
				<label class="mp-field">
					<span>
						单次最大输出
						{inf.outputLimit ? <i>上限 {formatTokens(inf.outputLimit)}</i> : null}
					</span>
					<Num value={ov.maxOutput} placeholder={formatTokens(inf.maxOutput ?? 0)} min={256} max={inf.outputLimit} onChange={v => set({ maxOutput: v })} />
				</label>
				<label class="mp-field">
					<span>Temperature{!thinkingOff && inf.reasoning ? <i>思考时无效</i> : null}</span>
					<Num value={ov.temperature} placeholder="默认" step={0.1} min={0} max={2} onChange={v => set({ temperature: v })} />
				</label>
				<label class="mp-field">
					<span>Top P</span>
					<Num value={ov.topP} placeholder="默认" step={0.05} min={0} max={1} onChange={v => set({ topP: v })} />
				</label>
			</div>
			<div class="mp-row">
				<span class="mp-label">思考强度</span>
				<div class="seg sm">
					{levels.map(v => (
						<button key={v} type="button" class={thinking === v ? 'on' : ''} onClick={() => set({ thinking: v === defaultThinking(p.kind) ? undefined : v })}>
							{THINKING_LABEL[v]}
						</button>
					))}
				</div>
			</div>
			<div class="mp-row">
				<span class="mp-label">识图</span>
				<div class="seg sm">
					{(['auto', 'on', 'off'] as const).map(v => (
						<button key={v} type="button" class={(ov.vision ?? 'auto') === v ? 'on' : ''} onClick={() => set({ vision: v })}>
							{v === 'auto' ? `自动（${inf.vision ? '支持' : '不支持'}）` : v === 'on' ? '开启' : '关闭'}
						</button>
					))}
				</div>
			</div>
			<div class="mp-foot">
				<span class="muted">{p.kind === 'deepseek' ? 'DeepSeek 思考强度对应 reasoning_effort（低 / 高 / 最大），关闭即 thinking.disabled。' : '思考强度以 reasoning_effort 发送，接口不支持时请选「默认」。'}</span>
				{Object.keys(ov).length > 0 && <button type="button" class="link-btn" onClick={() => ws.updateSettings({ overrides: Object.fromEntries(Object.entries(ws.settings.overrides).filter(([k]) => k !== key)) })}>恢复自动</button>}
			</div>
		</div>
	);
}
