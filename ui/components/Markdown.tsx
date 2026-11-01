/**
 * Markdown 渲染组件
 * - 渲染 marked 输出的 HTML
 * - 把 html-preview 占位替换为沙箱 iframe（allow-scripts，无同源权限），高度自适应
 * - 代码块复制按钮
 */
import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import { buildPreviewDoc, renderMarkdown, takeHtmlBlock } from '../lib/markdown';
import { copyText } from '../lib/util';
import { notify } from './common';

let frameSeq = 0;
const heights = new Map<string, number>();

window.addEventListener('message', (e) => {
	const d = e.data;
	if (!d || d.__edaAgentPreview !== 1 || typeof d.id !== 'string')
		return;
	const frame = document.querySelector<HTMLIFrameElement>(`iframe[name="${CSS.escape(d.id)}"]`);
	if (!frame)
		return;
	const h = Math.min(1600, Math.max(60, Number(d.h) || 0));
	heights.set(frame.dataset.key ?? '', h);
	frame.style.height = `${h}px`;
});

function mountPreviews(root: HTMLElement, theme: 'light' | 'dark', streaming: boolean): void {
	root.querySelectorAll<HTMLDivElement>('.html-preview').forEach((el) => {
		const id = el.dataset.htmlId;
		if (!id)
			return;
		const code = takeHtmlBlock(id);
		if (code === undefined)
			return;
		const key = `${id}|${theme}`;
		if (el.dataset.mounted === key)
			return;
		el.dataset.mounted = key;
		el.innerHTML = '';
		const bar = document.createElement('div');
		bar.className = 'preview-bar';
		bar.innerHTML = `<span class="preview-tag">${el.dataset.lang === 'svg' ? 'SVG' : 'HTML'} 预览</span><span class="preview-actions"><button type="button" data-act="code">源码</button><button type="button" data-act="copy">复制</button></span>`;
		el.appendChild(bar);
		if (streaming) {
			const ph = document.createElement('div');
			ph.className = 'preview-loading';
			ph.textContent = '正在绘制…';
			el.appendChild(ph);
			return;
		}
		const frame = document.createElement('iframe');
		frame.name = `eap_${++frameSeq}`;
		frame.dataset.key = id.split('_').slice(0, 2).join('_');
		frame.setAttribute('sandbox', 'allow-scripts');
		frame.setAttribute('referrerpolicy', 'no-referrer');
		frame.className = 'preview-frame';
		frame.style.height = `${heights.get(frame.dataset.key) ?? 220}px`;
		frame.srcdoc = buildPreviewDoc(code, theme);
		el.appendChild(frame);
		const pre = document.createElement('pre');
		pre.className = 'preview-code';
		pre.textContent = code;
		pre.hidden = true;
		el.appendChild(pre);
		bar.addEventListener('click', (ev) => {
			const act = (ev.target as HTMLElement).closest('button')?.dataset.act;
			if (act === 'copy') {
				void copyText(code).then(() => notify('已复制 HTML'));
			}
			else if (act === 'code') {
				pre.hidden = !pre.hidden;
				frame.hidden = !pre.hidden;
				(ev.target as HTMLElement).textContent = pre.hidden ? '源码' : '预览';
			}
		});
	});
}

export function Markdown(props: { text: string; streaming?: boolean; theme: 'light' | 'dark'; class?: string }) {
	const ref = useRef<HTMLDivElement>(null);
	const html = renderMarkdown(props.text, props.streaming);
	const last = useRef('');

	useLayoutEffect(() => {
		const el = ref.current;
		if (!el || last.current === html)
			return;
		last.current = html;
		el.innerHTML = html;
		mountPreviews(el, props.theme, !!props.streaming);
	}, [html, props.streaming]);

	useEffect(() => {
		const el = ref.current;
		if (!el)
			return;
		el.querySelectorAll<HTMLDivElement>('.html-preview').forEach(p => delete p.dataset.mounted);
		mountPreviews(el, props.theme, !!props.streaming);
	}, [props.theme]);

	const onClick = (e: MouseEvent) => {
		const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-copy]');
		if (!btn)
			return;
		const code = btn.closest('.code-block')?.querySelector('code')?.textContent ?? '';
		void copyText(code).then(() => {
			btn.textContent = '已复制';
			setTimeout(() => (btn.textContent = '复制'), 1400);
		});
	};

	return <div ref={ref} class={`md ${props.streaming ? 'streaming' : ''} ${props.class ?? ''}`} onClick={onClick} />;
}
