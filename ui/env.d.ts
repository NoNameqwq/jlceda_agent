declare module '*.css' {
	const css: string;
	export default css;
}

declare const __APP_VERSION__: string;

interface Window {
	eda?: any;
}
