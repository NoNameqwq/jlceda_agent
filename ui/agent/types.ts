/** Agent 核心数据结构 */

export type PermissionMode = 'readonly' | 'ask' | 'auto-edit' | 'full';
export type RiskLevel = 'read' | 'write' | 'danger';
export type ToolRule = 'allow' | 'ask' | 'deny';
export type ThemeMode = 'system' | 'light' | 'dark';

export interface Attachment {
	id: string;
	kind: 'image' | 'file';
	name: string;
	mime: string;
	size: number;
	/** 图片：压缩后的 dataURL */
	dataUrl?: string;
	/** 文本文件：内容 */
	text?: string;
	truncated?: boolean;
}

export interface ToolCall {
	id: string;
	name: string;
	arguments: string;
}

export type ToolRunStatus = 'pending' | 'awaiting' | 'running' | 'done' | 'error' | 'denied' | 'cancelled';

export interface PlanStep {
	title: string;
	status: 'pending' | 'in_progress' | 'done';
}

export type ToolDisplay =
	| { kind: 'image'; src: string; caption?: string }
	| { kind: 'plan'; steps: PlanStep[]; note?: string }
	| { kind: 'answer'; question: string; answer: string }
	| { kind: 'text'; text: string };

export interface ToolRun {
	callId: string;
	name: string;
	title: string;
	summary?: string;
	args: any;
	risk: RiskLevel;
	status: ToolRunStatus;
	result?: string;
	error?: string;
	startedAt?: number;
	endedAt?: number;
	changeId?: string;
	display?: ToolDisplay;
	denyReason?: string;
}

export interface Usage {
	prompt: number;
	completion: number;
}

export interface ChatMessage {
	id: string;
	role: 'user' | 'assistant' | 'tool';
	/** injection：工具产生的图片等注入消息（界面不单独展示） */
	kind?: 'normal' | 'injection';
	content: string;
	reasoning?: string;
	attachments?: Attachment[];
	toolCalls?: ToolCall[];
	toolRuns?: ToolRun[];
	toolCallId?: string;
	toolName?: string;
	createdAt: number;
	model?: string;
	usage?: Usage;
	error?: string;
	streaming?: boolean;
	durationMs?: number;
}

export interface ChangeItem {
	op: 'create' | 'modify' | 'delete' | 'other';
	/** eda 类实例名，如 sch_PrimitiveWire */
	kind: string;
	primitiveId?: string;
	before?: any;
	after?: any;
	label?: string;
	undone?: boolean;
}

export interface ChangeRecord {
	id: string;
	messageId: string;
	callId: string;
	tool: string;
	title: string;
	summary: string;
	createdAt: number;
	docUuid?: string;
	scene: string;
	items: ChangeItem[];
	undoable: boolean;
	status: 'applied' | 'undone' | 'partial';
	note?: string;
}

export interface Conversation {
	id: string;
	projectKey: string;
	title: string;
	createdAt: number;
	updatedAt: number;
	messages: ChatMessage[];
	changes: ChangeRecord[];
	permissionMode: PermissionMode;
	sessionAllow: string[];
	scope?: AgentScope;
	plan?: PlanStep[];
	/** 被压缩为摘要的前置消息数量 */
	compactedCount?: number;
	summary?: string;
	titleLocked?: boolean;
	lastPromptTokens?: number;
}

export interface ConversationMeta {
	id: string;
	title: string;
	createdAt: number;
	updatedAt: number;
	count: number;
}

export interface ModelInfo {
	id: string;
	contextWindow?: number;
	/** 默认每次请求的最大输出 */
	maxOutput?: number;
	/** 模型输出上限（仅展示） */
	outputLimit?: number;
	vision?: boolean;
	reasoning?: boolean;
}

/** 思考强度：default = 不发送参数（接口默认）；off = 关闭思考 */
export type ThinkingLevel = 'default' | 'off' | 'low' | 'medium' | 'high' | 'max';

export type AgentScope = 'project' | 'global';

export interface ProviderConfig {
	id: string;
	kind: 'deepseek' | 'openai';
	name: string;
	baseUrl: string;
	apiKey: string;
	models: ModelInfo[];
	builtin?: boolean;
	extraHeaders?: Record<string, string>;
	lastCheck?: { ok: boolean; message: string; at: number };
}

export interface ModelOverride {
	contextWindow?: number;
	maxOutput?: number;
	vision?: 'auto' | 'on' | 'off';
	temperature?: number;
	topP?: number;
	thinking?: ThinkingLevel;
	/** @deprecated 旧版字段，加载时迁移到 thinking */
	reasoningEffort?: string;
}

export interface Settings {
	providers: ProviderConfig[];
	activeProviderId: string;
	activeModel: string;
	theme: ThemeMode;
	defaultPermissionMode: PermissionMode;
	toolRules: Record<string, ToolRule>;
	overrides: Record<string, ModelOverride>;
	autoContext: boolean;
	maxToolRounds: number;
	transport: 'auto' | 'eda' | 'fetch';
	streaming: boolean;
	dockMode: 'panel' | 'float';
	/** 界面缩放（Ctrl + 滚轮） */
	uiScale: number;
	/** Agent 范围：绑定当前工程 / 独立（全局） */
	scope: AgentScope;
	/** 打开工程文档时自动唤出工程 Agent */
	autoOpenOnProject: boolean;
	showReasoning: boolean;
	customInstructions: string;
	/** 已挂载的内置技能 ID；仅挂载项注入系统提示词 */
	enabledSkills: string[];
	sendKey: 'enter' | 'ctrlEnter';
}

export interface EditorContext {
	available: boolean;
	scene: string;
	sceneLabel: string;
	documentType?: number;
	documentUuid?: string;
	documentName?: string;
	projectUuid?: string;
	projectName?: string;
	selection: Array<{ id: string; type: string; label?: string }>;
	selectionCount: number;
	theme?: 'light' | 'dark';
	editorVersion?: string;
	user?: string;
}

/** 工程概览（工程模式下注入系统提示词） */
export interface ProjectOverview {
	projectUuid: string;
	boards: Array<{ name: string }>;
	schematics: Array<{ name: string; uuid: string; pages: Array<{ name: string; uuid: string }> }>;
	pcbs: Array<{ name: string; uuid: string }>;
	at: number;
}

export interface ContextSegment {
	key: string;
	label: string;
	tokens: number;
	note?: string;
}

export interface ContextBreakdown {
	segments: ContextSegment[];
	total: number;
	window: number;
	reservedOutput: number;
	/** 触发自动压缩的估算阈值 */
	threshold: number;
	compacted: number;
	lastUsage?: Usage;
	model: string;
}
