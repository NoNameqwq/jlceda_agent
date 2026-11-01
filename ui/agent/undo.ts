/**
 * 改动撤销
 *
 * - create  → 删除该图元
 * - modify  → 用修改前快照的字段写回
 * - delete  → 对可重建的图元（导线 / 文本 / 走线 / 过孔）按快照重建，其余提示使用 EDA 撤销
 * - other   → 无法自动撤销
 */
import type { ChangeItem, ChangeRecord } from './types';
import { callEda } from '../lib/eda';
import { errorMessage } from '../lib/util';

async function recreate(it: ChangeItem): Promise<string | undefined> {
	const b = it.before ?? {};
	switch (it.kind) {
		case 'sch_PrimitiveWire':
			return (await callEda('sch_PrimitiveWire.create', b.line, b.net || undefined))?.getState_PrimitiveId?.();
		case 'sch_PrimitiveText':
			return (await callEda('sch_PrimitiveText.create', b.x, b.y, b.content, b.rotation ?? 0))?.getState_PrimitiveId?.();
		case 'pcb_PrimitiveLine':
			return (await callEda('pcb_PrimitiveLine.create', b.net ?? '', b.layer, b.startX, b.startY, b.endX, b.endY, b.lineWidth))?.getState_PrimitiveId?.();
		case 'pcb_PrimitiveVia':
			return (await callEda('pcb_PrimitiveVia.create', b.net ?? '', b.x, b.y, b.holeDiameter, b.diameter))?.getState_PrimitiveId?.();
		default:
			throw new Error('该类型图元删除后无法自动重建，请在 EDA 中使用 Ctrl+Z');
	}
}

async function undoItem(it: ChangeItem): Promise<void> {
	if (it.undone)
		return;
	switch (it.op) {
		case 'create': {
			if (!it.primitiveId)
				throw new Error('缺少图元 ID');
			const ok = await callEda<boolean>(`${it.kind}.delete`, [it.primitiveId]);
			if (!ok)
				throw new Error(`删除 ${it.primitiveId} 失败（可能已被手动删除）`);
			break;
		}
		case 'modify': {
			if (!it.primitiveId || !it.before)
				throw new Error('缺少修改前快照');
			const r = await callEda(`${it.kind}.modify`, it.primitiveId, it.before);
			if (!r)
				throw new Error(`恢复 ${it.primitiveId} 失败`);
			break;
		}
		case 'delete': {
			if (!it.before)
				throw new Error('缺少删除前快照');
			const id = await recreate(it);
			if (!id)
				throw new Error('重建失败');
			it.primitiveId = id;
			break;
		}
		default:
			throw new Error('通用操作无法自动撤销，请在 EDA 中使用 Ctrl+Z');
	}
	it.undone = true;
}

/** 撤销一条改动记录（逆序处理其中各项），返回错误列表 */
export async function undoChange(rec: ChangeRecord): Promise<string[]> {
	const errors: string[] = [];
	for (const it of [...rec.items].reverse()) {
		try {
			await undoItem(it);
		}
		catch (e) {
			errors.push(`${it.label ?? it.kind}：${errorMessage(e)}`);
		}
	}
	const undone = rec.items.filter(i => i.undone).length;
	rec.status = undone === rec.items.length ? 'undone' : undone > 0 ? 'partial' : rec.status;
	return errors;
}

export function changeStats(records: ChangeRecord[]): { create: number; modify: number; delete: number; other: number } {
	const s = { create: 0, modify: 0, delete: 0, other: 0 };
	for (const r of records) {
		if (r.status === 'undone')
			continue;
		for (const i of r.items) {
			if (!i.undone)
				s[i.op]++;
		}
	}
	return s;
}
