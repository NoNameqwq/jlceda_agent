/**
 * Markdown 渲染：marked + KaTeX（行内 $…$ / 块级 $$…$$ / \( \) / \[ \]）+ highlight.js + DOMPurify。
 * ```html 代码块会被标记为 html-preview，由界面渲染到沙箱 iframe 中。
 */
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/core';
import armasm from 'highlight.js/lib/languages/armasm';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import css from 'highlight.js/lib/languages/css';
import ini from 'highlight.js/lib/languages/ini';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import makefile from 'highlight.js/lib/languages/makefile';
import markdown from 'highlight.js/lib/languages/markdown';
import plaintext from 'highlight.js/lib/languages/plaintext';
import python from 'highlight.js/lib/languages/python';
import typescript from 'highlight.js/lib/languages/typescript';
import verilog from 'highlight.js/lib/languages/verilog';
import vhdl from 'highlight.js/lib/languages/vhdl';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import katex from 'katex';
import { Marked, Renderer } from 'marked';

const langs: Record<string, any> = { armasm, bash, c, cpp, css, ini, javascript, json, makefile, markdown, plaintext, python, typescript, verilog, vhdl, xml, yaml };
for (const [k, v] of Object.entries(langs))
	hljs.registerLanguage(k, v);
hljs.registerAliases(['sh', 'shell', 'zsh', 'powershell', 'ps1'], { languageName: 'bash' });
hljs.registerAliases(['js', 'jsx', 'mjs'], { languageName: 'javascript' });
hljs.registerAliases(['ts', 'tsx'], { languageName: 'typescript' });
hljs.registerAliases(['h', 'ino', 'arduino'], { languageName: 'cpp' });
hljs.registerAliases(['html', 'svg', 'xhtml'], { languageName: 'xml' });
hljs.registerAliases(['py'], { languageName: 'python' });
hljs.registerAliases(['v', 'sv', 'systemverilog'], { languageName: 'verilog' });
hljs.registerAliases(['asm', 's'], { languageName: 'armasm' });
hljs.registerAliases(['yml'], { languageName: 'yaml' });
hljs.registerAliases(['text', 'txt', 'spice', 'cir'], { languageName: 'plaintext' });
hljs.registerAliases(['md'], { languageName: 'markdown' });

function escapeHtml(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderMath(tex: string, display: boolean): string {
	try {
		return katex.renderToString(tex, { displayMode: display, throwOnError: false, strict: 'ignore', output: 'htmlAndMathml', trust: false });
	}
	catch {
		return `<code>${escapeHtml(tex)}</code>`;
	}
}

/** html 代码块内容暂存，渲染后由组件按 id 取出 */
const htmlStore = new Map<string, string>();
let htmlSeq = 0;

export function takeHtmlBlock(id: string): string | undefined {
	return htmlStore.get(id);
}

function htmlKey(code: string): string {
	let h = 0;
	for (let i = 0; i < code.length; i++)
		h = (h * 31 + code.charCodeAt(i)) | 0;
	return `h${(h >>> 0).toString(36)}_${code.length}`;
}

const marked = new Marked({
	gfm: true,
	breaks: true,
	extensions: [
		{
			name: 'mathBlock',
			level: 'block',
			start(src: string) {
				const m = src.match(/\$\$|\\\[/);
				return m?.index;
			},
			tokenizer(src: string) {
				const m = /^\$\$([\s\S]+?)\$\$/.exec(src) || /^\\\[([\s\S]+?)\\\]/.exec(src);
				if (m)
					return { type: 'mathBlock', raw: m[0], text: m[1].trim() };
				return undefined;
			},
			renderer(t: any) {
				return `<div class="math-block">${renderMath(t.text, true)}</div>`;
			},
		},
		{
			name: 'mathInline',
			level: 'inline',
			start(src: string) {
				const m = src.match(/\$|\\\(/);
				return m?.index;
			},
			tokenizer(src: string) {
				let m = /^\$\$([^$]+?)\$\$/.exec(src);
				if (m)
					return { type: 'mathInline', raw: m[0], text: m[1].trim(), display: true };
				m = /^\\\(([\s\S]+?)\\\)/.exec(src);
				if (m)
					return { type: 'mathInline', raw: m[0], text: m[1].trim(), display: false };
				// $…$：内容不以空格开头/结尾，且右侧不紧跟数字（避免 $5 和 $10 被误判）
				m = /^\$(?!\s)((?:\\\$|[^$\n])+?)(?<!\s)\$(?!\d)/.exec(src);
				if (m)
					return { type: 'mathInline', raw: m[0], text: m[1], display: false };
				return undefined;
			},
			renderer(t: any) {
				return renderMath(t.text, !!t.display);
			},
		},
	],
	renderer: {
		code({ text, lang }) {
			const l = (lang || '').trim().split(/\s+/)[0].toLowerCase();
			if (l === 'html' || l === 'svg') {
				const key = `${htmlKey(text)}_${++htmlSeq % 1_000_000}`;
				htmlStore.set(key, text);
				if (htmlStore.size > 300) {
					const first = htmlStore.keys().next().value;
					if (first)
						htmlStore.delete(first);
				}
				return `<div class="html-preview" data-html-id="${key}" data-lang="${l}"></div>`;
			}
			let body: string;
			try {
				body = l && hljs.getLanguage(l) ? hljs.highlight(text, { language: l, ignoreIllegals: true }).value : escapeHtml(text);
			}
			catch {
				body = escapeHtml(text);
			}
			return `<div class="code-block"><div class="code-head"><span>${escapeHtml(l || 'text')}</span><button class="code-copy" type="button" data-copy>复制</button></div><pre><code class="hljs">${body}</code></pre></div>`;
		},
		link({ href, title, tokens }) {
			const text = this.parser.parseInline(tokens);
			return `<a href="${escapeHtml(href)}"${title ? ` title="${escapeHtml(title)}"` : ''} target="_blank" rel="noopener noreferrer">${text}</a>`;
		},
		table(token) {
			const html = Renderer.prototype.table.call(this, token);
			return `<div class="table-wrap">${html}</div>`;
		},
	},
});

DOMPurify.addHook('uponSanitizeAttribute', (_node, data) => {
	if (data.attrName === 'target')
		data.forceKeepAttr = true;
});

const PURIFY = {
	ADD_TAGS: ['math', 'semantics', 'mrow', 'mi', 'mo', 'mn', 'msup', 'msub', 'mfrac', 'msqrt', 'mroot', 'mtext', 'annotation', 'mspace', 'mtable', 'mtr', 'mtd', 'munder', 'mover', 'munderover', 'msubsup', 'mpadded', 'mstyle', 'menclose'],
	ADD_ATTR: ['target', 'data-html-id', 'data-lang', 'data-copy', 'encoding', 'aria-hidden'],
	FORBID_TAGS: ['style', 'script', 'iframe', 'form', 'input', 'object', 'embed'],
};

/** 流式时补齐未闭合的代码块与公式，避免渲染抖动 */
function balance(src: string): string {
	let s = src;
	const fences = s.match(/^```/gm)?.length ?? 0;
	if (fences % 2 === 1)
		s += '\n```';
	const blocks = s.replace(/```[\s\S]*?```/g, '').match(/\$\$/g)?.length ?? 0;
	if (blocks % 2 === 1)
		s += '$$';
	return s;
}

const cache = new Map<string, string>();

export function renderMarkdown(src: string, streaming = false): string {
	if (!src)
		return '';
	const input = streaming ? balance(src) : src;
	const hit = cache.get(input);
	if (hit)
		return hit;
	let html: string;
	try {
		html = DOMPurify.sanitize(marked.parse(input, { async: false }) as string, PURIFY) as unknown as string;
	}
	catch (e) {
		html = `<pre>${escapeHtml(src)}</pre><p class="md-error">渲染失败：${escapeHtml(String(e))}</p>`;
	}
	if (!streaming) {
		cache.set(input, html);
		if (cache.size > 400) {
			const first = cache.keys().next().value;
			if (first !== undefined)
				cache.delete(first);
		}
	}
	return html;
}

/** 构造 html 预览 iframe 的 srcdoc：注入主题色与自适应高度脚本 */
export function buildPreviewDoc(code: string, theme: 'light' | 'dark'): string {
	const fg = theme === 'dark' ? '#e6e6e6' : '#1f2328';
	const bg = theme === 'dark' ? '#17181b' : '#ffffff';
	const isFull = /<html[\s>]/i.test(code);
	const style = `<style>html,body{margin:0;padding:0;background:${bg};color:${fg};font:13px/1.5 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}body{padding:12px;box-sizing:border-box;display:flex;justify-content:center}body>*{max-width:100%}svg{max-width:100%;height:auto;color:${fg}}svg text{fill:currentColor}</style>`;
	const script = `<script>(function(){function post(){var h=Math.ceil(Math.max(document.documentElement.scrollHeight,document.body?document.body.scrollHeight:0));parent.postMessage({__edaAgentPreview:1,h:h,id:window.name},'*')}window.addEventListener('load',post);new ResizeObserver(post).observe(document.documentElement);setTimeout(post,60);setTimeout(post,400)})();<\/script>`;
	if (isFull)
		return code.replace(/<head[^>]*>/i, m => `${m}${style}`).replace(/<\/body>/i, `${script}</body>`);
	return `<!doctype html><html><head><meta charset="utf-8">${style}</head><body>${code}${script}</body></html>`;
}
