/**
 * 构建侧边栏界面：把 ui/ 打包为单个自包含的 iframe/index.html
 *
 * EDA 加载内联框架时只解析 HTML 直接引用的文件、不会递归解析（CSS 里的字体就加载不到），
 * 所以 JS、CSS 和 KaTeX 字体（woff2，转成 dataURL）全部内联进同一个 HTML。
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ext = JSON.parse(fs.readFileSync(path.join(root, 'extension.json'), 'utf-8'));
const watch = process.argv.includes('--watch');

/** KaTeX 同时引用 woff2/woff/ttf，只保留 woff2，其余替换为空，避免包体膨胀 */
const dropLegacyFonts = {
	name: 'drop-legacy-fonts',
	setup(b) {
		b.onResolve({ filter: /\.(woff|ttf)$/ }, a => ({ path: a.path, namespace: 'empty-font' }));
		b.onLoad({ filter: /.*/, namespace: 'empty-font' }, () => ({ contents: '', loader: 'dataurl' }));
	},
};

const options = {
	entryPoints: [path.join(root, 'ui/main.tsx')],
	bundle: true,
	write: false,
	outdir: path.join(root, '.ui-out'),
	format: 'iife',
	platform: 'browser',
	target: ['chrome100', 'safari15'],
	minify: !watch,
	sourcemap: false,
	legalComments: 'none',
	jsx: 'automatic',
	jsxImportSource: 'preact',
	loader: { '.woff2': 'dataurl', '.css': 'css' },
	define: { __APP_VERSION__: JSON.stringify(ext.version), 'process.env.NODE_ENV': '"production"' },
	plugins: [dropLegacyFonts],
	logLevel: 'warning',
};

function emit(result) {
	let js = '';
	let css = '';
	for (const f of result.outputFiles) {
		if (f.path.endsWith('.js'))
			js = f.text;
		else if (f.path.endsWith('.css'))
			css = f.text;
	}
	// 防止内联脚本 / 样式提前闭合
	js = js.replace(/<\/script/gi, '<\\/script');
	css = css.replace(/<\/style/gi, '<\\/style');
	const html = `<!doctype html>
<html lang="zh-Hans">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>EDA Agent</title>
<style>${css}</style>
</head>
<body>
<div id="app"></div>
<script>${js}</script>
</body>
</html>
`;
	const out = path.join(root, 'iframe/index.html');
	fs.mkdirSync(path.dirname(out), { recursive: true });
	fs.writeFileSync(out, html, 'utf-8');
	console.log(`[ui] iframe/index.html  ${(Buffer.byteLength(html) / 1024).toFixed(0)} KB  (js ${(js.length / 1024).toFixed(0)} KB, css ${(css.length / 1024).toFixed(0)} KB)`);
}

if (watch) {
	const ctx = await esbuild.context({
		...options,
		plugins: [...options.plugins, { name: 'emit', setup(b) {
			b.onEnd((r) => {
				if (!r.errors.length)
					emit(r);
			});
		} }],
	});
	await ctx.watch();
	console.log('[ui] watching…');
}
else {
	const r = await esbuild.build(options);
	emit(r);
}
