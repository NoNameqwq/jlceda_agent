/** 侧边栏入口 */
import { render } from 'preact';
import { workspace } from './agent/workspace';
import { App } from './components/App';
import { initStorage } from './lib/storage';
import { registerEdaTools } from './tools/eda-tools';
import { registerSimTools } from './tools/sim-tools';
import 'katex/dist/katex.min.css';
import './styles.css';

registerEdaTools();
registerSimTools();

const root = document.getElementById('app')!;

async function boot(): Promise<void> {
	render(<App />, root);
	try {
		await initStorage();
		await workspace.init();
	}
	catch (e) {
		console.error('[EDA Agent] 初始化失败', e);
		root.innerHTML = `<div class="fatal"><b>EDA Agent 初始化失败</b><pre>${String((e as Error)?.stack ?? e).replace(/</g, '&lt;')}</pre></div>`;
	}
}

window.addEventListener('beforeunload', () => workspace.flush());

void boot();
