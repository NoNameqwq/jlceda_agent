/**
 * 网络请求层
 *
 * 嘉立创EDA 内联框架可能受宿主 CSP 限制，因此优先使用 eda.sys_ClientUrl.request
 * （需在扩展管理器中为本扩展勾选「允许外部交互」），失败时回退到 fetch。
 */
import { getEda } from './eda';
import { errorMessage } from './util';

export type Transport = 'auto' | 'eda' | 'fetch';

let transportPref: Transport = 'auto';
let edaBlocked = false;

export function setTransport(t: Transport): void {
	transportPref = t;
	edaBlocked = false;
}

export interface HttpOptions {
	method?: 'GET' | 'POST';
	headers?: Record<string, string>;
	body?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
}

export function abortError(): Error {
	const e = new Error('已中止');
	e.name = 'AbortError';
	return e;
}

export function isAbort(e: unknown): boolean {
	return !!e && typeof e === 'object' && (e as Error).name === 'AbortError';
}

function race<T>(p: Promise<T>, signal: AbortSignal | undefined, timeoutMs: number): Promise<T> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(abortError());
			return;
		}
		const onAbort = () => {
			cleanup();
			reject(abortError());
		};
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒无响应）`));
		}, timeoutMs);
		const cleanup = () => {
			clearTimeout(timer);
			signal?.removeEventListener('abort', onAbort);
		};
		signal?.addEventListener('abort', onAbort);
		p.then((v) => {
			cleanup();
			resolve(v);
		}, (e) => {
			cleanup();
			reject(e);
		});
	});
}

async function viaEda(url: string, o: HttpOptions): Promise<Response> {
	const api = getEda()?.sys_ClientUrl;
	if (!api || typeof api.request !== 'function')
		throw new Error('eda.sys_ClientUrl 不可用');
	const method = o.method ?? 'GET';
	return await api.request(url, method, method === 'GET' ? undefined : o.body, { headers: o.headers ?? {} });
}

async function viaFetch(url: string, o: HttpOptions): Promise<Response> {
	return await fetch(url, {
		method: o.method ?? 'GET',
		headers: o.headers,
		body: o.method === 'POST' ? o.body : undefined,
		signal: o.signal,
	});
}

export async function httpRequest(url: string, o: HttpOptions = {}): Promise<Response> {
	const hasEdaClient = !!getEda()?.sys_ClientUrl;
	let order: Array<'eda' | 'fetch'>;
	if (transportPref === 'eda')
		order = ['eda'];
	else if (transportPref === 'fetch')
		order = ['fetch'];
	else order = hasEdaClient && !edaBlocked ? ['eda', 'fetch'] : ['fetch', 'eda'];

	const errors: string[] = [];
	for (const t of order) {
		if (t === 'eda' && !hasEdaClient)
			continue;
		try {
			const p = t === 'eda' ? viaEda(url, o) : viaFetch(url, o);
			return await race(p, o.signal, o.timeoutMs ?? 120_000);
		}
		catch (e) {
			if (o.signal?.aborted || isAbort(e))
				throw abortError();
			const msg = errorMessage(e);
			errors.push(`${t === 'eda' ? 'EDA 外部请求' : 'fetch'}：${msg}`);
			if (t === 'eda')
				edaBlocked = true;
		}
	}
	throw new Error(`网络请求失败（${errors.join('；') || '未知错误'}）。请确认：① 已在「扩展管理器」中为 EDA Agent 勾选「允许外部交互」；② 接口地址可访问且允许跨域（CORS）。`);
}

/** 逐行读取 SSE 流中的 data 字段 */
export class StallError extends Error {
	constructor(sec: number) {
		super(`模型响应中断（${sec} 秒没有收到新数据）`);
		this.name = 'StallError';
	}
}

/** 带空闲超时的 read：超过 idleMs 没有数据就抛出 StallError，避免永久卡住 */
function readWithIdle(reader: any, idleMs: number): Promise<{ done: boolean; value?: Uint8Array }> {
	return new Promise((resolve, reject) => {
		const t = setTimeout(() => {
			reader.cancel().catch(() => {});
			reject(new StallError(Math.round(idleMs / 1000)));
		}, idleMs);
		reader.read().then((r: any) => {
			clearTimeout(t);
			resolve(r);
		}, (e: unknown) => {
			clearTimeout(t);
			reject(e);
		});
	});
}

export async function* readSSE(res: Response, signal?: AbortSignal, idleMs = 90_000): AsyncGenerator<string> {
	const body: any = res.body;
	if (!body || typeof body.getReader !== 'function') {
		const text = await res.text();
		for (const line of text.split(/\r?\n/)) {
			if (line.startsWith('data:'))
				yield line.slice(5).trim();
		}
		return;
	}
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buf = '';
	const onAbort = () => {
		reader.cancel().catch(() => {});
	};
	signal?.addEventListener('abort', onAbort);
	try {
		while (true) {
			if (signal?.aborted)
				throw abortError();
			const { done, value } = await readWithIdle(reader, idleMs);
			if (done)
				break;
			buf += decoder.decode(value, { stream: true });
			let idx = buf.indexOf('\n');
			while (idx >= 0) {
				const line = buf.slice(0, idx).replace(/\r$/, '');
				buf = buf.slice(idx + 1);
				if (line.startsWith('data:'))
					yield line.slice(5).trim();
				idx = buf.indexOf('\n');
			}
		}
		buf += decoder.decode();
		if (buf.startsWith('data:'))
			yield buf.slice(5).trim();
		if (signal?.aborted)
			throw abortError();
	}
	finally {
		signal?.removeEventListener('abort', onAbort);
		try {
			reader.releaseLock();
		}
		catch {}
	}
}
