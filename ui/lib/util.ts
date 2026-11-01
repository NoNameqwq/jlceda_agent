/** 通用工具函数 */

export function uid(prefix = ''): string {
	const r = Math.random().toString(36).slice(2, 10);
	return `${prefix}${Date.now().toString(36)}${r}`;
}

export function clamp(v: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, v));
}

export function sleep(ms: number): Promise<void> {
	return new Promise(r => setTimeout(r, ms));
}

export function truncate(s: string, max: number, note = true): string {
	if (s.length <= max)
		return s;
	const head = s.slice(0, Math.floor(max * 0.8));
	const tail = s.slice(-Math.floor(max * 0.15));
	return note ? `${head}\n…[已截断 ${s.length - head.length - tail.length} 字符]…\n${tail}` : `${head}…`;
}

export function safeJsonParse<T = any>(s: string | undefined | null, fallback: T): T {
	if (!s)
		return fallback;
	try {
		return JSON.parse(s) as T;
	}
	catch {
		return fallback;
	}
}

export function safeStringify(v: unknown, space?: number): string {
	const seen = new WeakSet();
	try {
		return JSON.stringify(v, (_k, val) => {
			if (typeof val === 'bigint')
				return val.toString();
			if (val && typeof val === 'object') {
				if (seen.has(val))
					return '[Circular]';
				seen.add(val);
			}
			return val;
		}, space) ?? 'undefined';
	}
	catch (e) {
		return String(v ?? e);
	}
}

/** 粗略估算 token 数（中文按 0.7/字，其它按 4 字符/token） */
export function estimateTokens(text: string): number {
	if (!text)
		return 0;
	let ascii = 0;
	let other = 0;
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) < 128)
			ascii++;
		else other++;
	}
	return Math.ceil(ascii / 4 + other * 0.7);
}

export function formatTokens(n: number): string {
	if (n >= 1_000_000)
		return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
	if (n >= 1000)
		return `${Math.round(n / 1000)}K`;
	return String(n);
}

export function formatTime(ts: number): string {
	const d = new Date(ts);
	const now = new Date();
	const pad = (n: number) => String(n).padStart(2, '0');
	if (d.toDateString() === now.toDateString())
		return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
	return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatBytes(n: number): string {
	if (n < 1024)
		return `${n} B`;
	if (n < 1024 * 1024)
		return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function blobToDataUrl(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const fr = new FileReader();
		fr.onload = () => resolve(String(fr.result));
		fr.onerror = () => reject(fr.error);
		fr.readAsDataURL(blob);
	});
}

export function blobToText(blob: Blob): Promise<string> {
	if (typeof (blob as any).text === 'function')
		return (blob as any).text();
	return new Promise((resolve, reject) => {
		const fr = new FileReader();
		fr.onload = () => resolve(String(fr.result));
		fr.onerror = () => reject(fr.error);
		fr.readAsText(blob);
	});
}

/** 将图片压缩到最长边 maxSide，返回 JPEG/PNG dataURL */
export async function downscaleImage(dataUrl: string, maxSide = 1600): Promise<string> {
	try {
		const img = new Image();
		img.src = dataUrl;
		await img.decode();
		const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
		if (scale >= 1 && dataUrl.length < 1_500_000)
			return dataUrl;
		const w = Math.max(1, Math.round(img.naturalWidth * scale));
		const h = Math.max(1, Math.round(img.naturalHeight * scale));
		const c = document.createElement('canvas');
		c.width = w;
		c.height = h;
		const g = c.getContext('2d');
		if (!g)
			return dataUrl;
		g.fillStyle = '#fff';
		g.fillRect(0, 0, w, h);
		g.drawImage(img, 0, 0, w, h);
		return c.toDataURL('image/jpeg', 0.88);
	}
	catch {
		return dataUrl;
	}
}

export function debounce<T extends (...a: any[]) => void>(fn: T, ms: number): T & { flush: () => void } {
	let t: ReturnType<typeof setTimeout> | undefined;
	let lastArgs: any[] | undefined;
	const wrapped = ((...args: any[]) => {
		lastArgs = args;
		if (t)
			clearTimeout(t);
		t = setTimeout(() => {
			t = undefined;
			fn(...(lastArgs as any[]));
		}, ms);
	}) as T & { flush: () => void };
	wrapped.flush = () => {
		if (t) {
			clearTimeout(t);
			t = undefined;
			fn(...(lastArgs as any[]));
		}
	};
	return wrapped;
}

export function deepClone<T>(v: T): T {
	if (typeof structuredClone === 'function') {
		try {
			return structuredClone(v);
		}
		catch {}
	}
	return JSON.parse(JSON.stringify(v));
}

export function copyText(text: string): Promise<void> {
	if (navigator.clipboard?.writeText)
		return navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
	fallbackCopy(text);
	return Promise.resolve();
}

function fallbackCopy(text: string): void {
	const ta = document.createElement('textarea');
	ta.value = text;
	ta.style.position = 'fixed';
	ta.style.opacity = '0';
	document.body.appendChild(ta);
	ta.select();
	try {
		document.execCommand('copy');
	}
	catch {}
	ta.remove();
}

export function errorMessage(e: unknown): string {
	if (e instanceof Error)
		return e.message || e.name;
	if (typeof e === 'string')
		return e;
	return safeStringify(e);
}
