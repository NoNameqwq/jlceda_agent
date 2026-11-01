/**
 * 权限体系
 *
 * 决策顺序：工具级规则（deny/allow/ask） → 会话内「本次对话始终允许」 → 权限模式 × 风险等级。
 *
 *              read    write   danger
 * readonly     allow   deny    deny
 * ask          allow   ask     ask
 * auto-edit    allow   allow   ask
 * full         allow   allow   allow
 */
import type { PermissionMode, RiskLevel, ToolRule } from './types';

export type Decision = 'allow' | 'ask' | 'deny';

export const MODE_LABEL: Record<PermissionMode, string> = {
	'readonly': '只读',
	'ask': '每次询问',
	'auto-edit': '自动编辑',
	'full': '完全访问',
};

export const MODE_DESC: Record<PermissionMode, string> = {
	'readonly': '只能查询，不修改设计',
	'ask': '修改前逐次确认',
	'auto-edit': '常规编辑自动执行，高风险操作确认',
	'full': '全部自动执行',
};

export const RISK_LABEL: Record<RiskLevel, string> = {
	read: '只读',
	write: '编辑',
	danger: '高风险',
};

const MATRIX: Record<PermissionMode, Record<RiskLevel, Decision>> = {
	'readonly': { read: 'allow', write: 'deny', danger: 'deny' },
	'ask': { read: 'allow', write: 'ask', danger: 'ask' },
	'auto-edit': { read: 'allow', write: 'allow', danger: 'ask' },
	'full': { read: 'allow', write: 'allow', danger: 'allow' },
};

export function decide(opts: {
	tool: string;
	risk: RiskLevel;
	mode: PermissionMode;
	rules: Record<string, ToolRule>;
	sessionAllow: string[];
}): { decision: Decision; reason: string } {
	const rule = opts.rules[opts.tool];
	if (rule === 'deny')
		return { decision: 'deny', reason: '该工具已在设置中被禁用' };
	// 只读模式下，即使规则为 allow，写操作仍被拒绝
	if (opts.mode === 'readonly' && opts.risk !== 'read')
		return { decision: 'deny', reason: '当前为只读模式' };
	if (rule === 'allow')
		return { decision: 'allow', reason: '设置中始终允许' };
	if (rule === 'ask' && opts.risk !== 'read')
		return { decision: 'ask', reason: '设置中要求确认' };
	if (opts.sessionAllow.includes(opts.tool))
		return { decision: 'allow', reason: '本次对话已允许' };
	const d = MATRIX[opts.mode][opts.risk];
	return { decision: d, reason: d === 'ask' ? `${MODE_LABEL[opts.mode]}模式下需要确认` : MODE_LABEL[opts.mode] };
}
