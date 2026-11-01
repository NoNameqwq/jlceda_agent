/**
 * 持久化存储层
 *
 * 优先使用 IndexedDB（容量大，适合存放对话），不可用时依次回退到
 * eda.sys_Storage（扩展用户配置）→ localStorage → 内存。
 * 所有值统一以 JSON 字符串形式保存。
 */
import { getEda } from './eda';

export type StorageBackend = 'idb' | 'eda' | 'local' | 'memory';

const DB_NAME = 'jlc-eda-agent';
const STORE = 'kv';
const LS_PREFIX = 'jlc-eda-agent:';
const memory = new Map<string, string>();

let backend: StorageBackend | undefined;
let db: IDBDatabase | undefined;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
	return new Promise((resolve, reject) => {
		const t = setTimeout(() => reject(new Error('timeout')), ms);
		p.then((v) => {
			clearTimeout(t);
			resolve(v);
		}, (e) => {
			clearTimeout(t);
			reject(e);
		});
	});
}

function openDb(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		try {
			const req = indexedDB.open(DB_NAME, 1);
			req.onupgradeneeded = () => {
				if (!req.result.objectStoreNames.contains(STORE))
					req.result.createObjectStore(STORE);
			};
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
			req.onblocked = () => reject(new Error('indexedDB blocked'));
		}
		catch (e) {
			reject(e);
		}
	});
}

function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		if (!db) {
			reject(new Error('db not ready'));
			return;
		}
		const tx = db.transaction(STORE, mode);
		const r = fn(tx.objectStore(STORE));
		r.onsuccess = () => resolve(r.result);
		r.onerror = () => reject(r.error);
	});
}

function localOk(): boolean {
	try {
		const k = `${LS_PREFIX}__probe`;
		localStorage.setItem(k, '1');
		localStorage.removeItem(k);
		return true;
	}
	catch {
		return false;
	}
}

function edaStore(): any | undefined {
	const s = getEda()?.sys_Storage;
	return s && typeof s.getExtensionUserConfig === 'function' ? s : undefined;
}

export async function initStorage(): Promise<StorageBackend> {
	if (backend)
		return backend;
	try {
		if (typeof indexedDB !== 'undefined') {
			db = await withTimeout(openDb(), 2500);
			await idb('readwrite', s => s.put('1', '__probe'));
			backend = 'idb';
			return backend;
		}
	}
	catch {
		db = undefined;
	}
	if (edaStore())
		backend = 'eda';
	else if (localOk())
		backend = 'local';
	else backend = 'memory';
	return backend;
}

export function storageBackend(): StorageBackend {
	return backend ?? 'memory';
}

async function rawGet(key: string): Promise<string | undefined> {
	switch (backend) {
		case 'idb': {
			const v = await idb<any>('readonly', s => s.get(key));
			return typeof v === 'string' ? v : undefined;
		}
		case 'eda': {
			const v = edaStore()?.getExtensionUserConfig(key);
			return typeof v === 'string' ? v : v === undefined || v === null ? undefined : JSON.stringify(v);
		}
		case 'local':
			return localStorage.getItem(LS_PREFIX + key) ?? undefined;
		default:
			return memory.get(key);
	}
}

async function rawSet(key: string, value: string): Promise<void> {
	memory.set(key, value);
	switch (backend) {
		case 'idb':
			await idb('readwrite', s => s.put(value, key));
			return;
		case 'eda':
			await edaStore()?.setExtensionUserConfig(key, value);
			return;
		case 'local':
			localStorage.setItem(LS_PREFIX + key, value);
	}
}

async function rawDel(key: string): Promise<void> {
	memory.delete(key);
	switch (backend) {
		case 'idb':
			await idb('readwrite', s => s.delete(key));
			return;
		case 'eda':
			await edaStore()?.deleteExtensionUserConfig(key);
			return;
		case 'local':
			localStorage.removeItem(LS_PREFIX + key);
	}
}

export const storage = {
	async get<T>(key: string, fallback: T): Promise<T> {
		try {
			const s = await rawGet(key);
			if (s === undefined)
				return fallback;
			return JSON.parse(s) as T;
		}
		catch {
			const m = memory.get(key);
			if (m) {
				try {
					return JSON.parse(m) as T;
				}
				catch {}
			}
			return fallback;
		}
	},
	async set(key: string, value: unknown): Promise<void> {
		const s = JSON.stringify(value);
		try {
			await rawSet(key, s);
		}
		catch (e) {
			console.warn('[EDA Agent] storage.set failed', key, e);
		}
	},
	async remove(key: string): Promise<void> {
		try {
			await rawDel(key);
		}
		catch {}
	},
};

/** 同步写入 EDA 扩展配置（供主线程读取，例如停靠模式） */
export function setEdaConfig(key: string, value: unknown): void {
	try {
		void edaStore()?.setExtensionUserConfig(key, value);
	}
	catch {}
}
