/**
 * 首轮提示词中的 EDA 接口与工具手册。
 *
 * 工具清单由注册表实时生成，和本轮实际下发的 function tools 保持一致；
 * 常用底层 API 则直接给出已验证路径，避免模型为了常规操作反复调用 eda_help。
 */
import type { ToolDef, ToolGroup } from '../tools/registry';
import { GROUP_LABEL } from '../tools/registry';

const API_PRIMER = `# EDA 接口与工具手册（已在对话开始注入）
以下就是本轮可直接调用的权威工具清单，不需要先读文档。专用工具已覆盖的操作，禁止再调用 eda_help。

## 通用 API 调用约定
- eda_call.path 使用 \`类实例名.方法名\`，args 是按位置排列的参数数组；例如 \`{"path":"sch_PrimitiveComponent.getAllPinsByPrimitiveId","args":["图元ID"]}\`。
- 图元 ID、UUID、网络名和坐标必须来自当前工程的查询结果。不要沿用其它工程、其它文档或旧快照中的 ID。
- 写操作返回空、超时或部分成功时，先回读真实状态，不要盲目重放；同一窗口的写调用串行执行。
- 只有专用工具无法完成、且下方没有列出签名时，才用 eda_help 查一个明确的类或方法。不要先读取类列表或整套文档。
- run_script 只用于批量/复杂逻辑，不用于替代已有的单个专用工具。

## 常用底层接口速查（eda_call 可直接使用）
- 工程：\`dmt_Project.getCurrentProjectInfo()\`；\`dmt_Board.getAllBoardsInfo()\`；\`dmt_Schematic.getAllSchematicsInfo()\`；\`dmt_Pcb.getAllPcbsInfo()\`。
- 文档：\`dmt_EditorControl.openDocument(uuid)\` → tabId；\`dmt_EditorControl.activateDocument(tabId)\`；\`sch_Document.save()\` / \`pcb_Document.save()\`。
- 原理图器件：\`sch_PrimitiveComponent.getAll(componentType?, allPages?)\`、\`.get(idOrIds)\`、\`.getAllPinsByPrimitiveId(id)\`、\`.create({libraryUuid,uuid},x,y,subPart?,rotation=0,mirror=false)\`、\`.modify(id,props)\`、\`.delete(ids)\`。
- 原理图连接：\`sch_PrimitiveWire.create([x1,y1,x2,y2,...],net?)\`；\`sch_PrimitiveComponent.createNetFlag(kind,net,x,y,rotation=0,mirror=false)\`；\`.createNetPort(kind,net,x,y,rotation=0,mirror=false)\`；\`sch_PrimitiveAttribute.createNetLabel(x,y,net)\`。
- 原理图检查：\`sch_Net.getAllNetsName()\`、\`sch_Net.getNet(net)\`、\`sch_Netlist.getNetlist("JLCEDA")\`；ERC 直接使用 sch_drc 工具，不必展开底层参数。
- PCB 器件与网络：\`pcb_PrimitiveComponent.getAll(layer?)\`、\`.get(idOrIds)\`、\`.getAllPinsByPrimitiveId(id)\`、\`.modify(id,props)\`；\`pcb_Net.getAllNets()\`、\`.getNet(net)\`、\`.getAllPrimitivesByNet(net)\`。
- PCB 图层：\`pcb_Layer.getTheNumberOfCopperLayers()\`、\`.getAllLayers()\`、\`.selectLayer(layerId)\`；TOP=1、BOTTOM=2、BOARD_OUTLINE=11。
- PCB 铜：\`pcb_PrimitiveLine.create(net,layer,x1,y1,x2,y2,widthMil,locked=false)\`；\`pcb_PrimitiveVia.create(net,x,y,holeMil,diameterMil)\`；\`pcb_PrimitivePour.rebuildCopperRegions()\`。
- 库：\`lib_Device.getByLcscIds(["Cxxxx"])\`、\`.get(uuid,libraryUuid?)\`；搜索统一使用 lib_search_device / lib_search_footprint 工具。结果中的 libraryUuid/uuid 必须重新用于当前放置。
- 视图：\`dmt_EditorControl.zoomToAllPrimitives()\`、\`.zoomToSelectedPrimitives()\`、\`.getCurrentRenderedAreaImage()\`。

## 单位、坐标与电气硬约束
- SCH/符号：1 单位 = 10mil = 0.01inch，Y 向上；优先 5/10 栅格。PCB/封装：mil，1mm≈39.37mil。
- 导线端点必须与引脚端点完全一致。折线优先水平/垂直；T 形连接才是节点，跨过其它引脚或异网导线可能意外合并网络。
- 不得把未知引脚当成 NC，不得从位号、相似型号或料号字符串猜测引脚/参数。多供电脚、同名脚和 NC 要逐一核对。
- 网络标签/电源旗应通过短桩线连接引脚；密集区域错开标签，避免穿过器件本体、其它引脚、图签或异网导线。

## 本轮工具参数速查
参数名后 \`*\` 表示必填；\`[]\` 表示数组；枚举列出允许值。完整 JSON Schema 也已随 tools 下发。`;

function typeOf(schema: any): string {
	if (!schema)
		return 'any';
	if (Array.isArray(schema.enum))
		return schema.enum.map((v: any) => JSON.stringify(v)).join('|');
	if (schema.type === 'array')
		return `${typeOf(schema.items)}[]`;
	if (schema.type === 'object')
		return 'object';
	if (Array.isArray(schema.type))
		return schema.type.join('|');
	return schema.type || 'any';
}

function signature(t: ToolDef): string {
	const p = t.parameters?.properties ?? {};
	const required = new Set<string>(t.parameters?.required ?? []);
	const names = Object.keys(p);
	if (!names.length)
		return '()';
	return `(${names.map(k => `${k}${required.has(k) ? '*' : ''}:${typeOf(p[k])}`).join(', ')})`;
}

export function buildToolPrimer(tools: ToolDef[]): string {
	const groups = new Map<ToolGroup, ToolDef[]>();
	for (const t of tools)
		groups.set(t.group, [...(groups.get(t.group) ?? []), t]);
	const manual = [...groups.entries()].map(([group, list]) => [
		`### ${GROUP_LABEL[group]}`,
		...list.map(t => `- \`${t.name}${signature(t)}\`：${t.description}`),
	].join('\n')).join('\n\n');
	return `${API_PRIMER}\n\n${manual}`;
}
