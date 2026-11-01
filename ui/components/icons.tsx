/** 线性图标（24 网格，1.75 描边） */
import type { JSX } from 'preact';

type P = JSX.SVGAttributes<SVGSVGElement> & { size?: number };

function I(paths: JSX.Element, displayName: string) {
	const C = ({ size = 16, ...rest }: P) => (
		<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={1.75} stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" {...rest}>
			{paths}
		</svg>
	);
	(C as any).displayName = displayName;
	return C;
}

export const IconPlus = I(<path d="M12 5v14M5 12h14" />, 'Plus');
export const IconX = I(<path d="M6 6l12 12M18 6L6 18" />, 'X');
export const IconSend = I(<path d="M12 19V5M5 12l7-7 7 7" />, 'Send');
export const IconStop = I(<rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" stroke="none" />, 'Stop');
export const IconHistory = I(<><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /><path d="M12 7v5l3 2" /></>, 'History');
export const IconSettings = I(<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></>, 'Settings');
export const IconSun = I(<><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>, 'Sun');
export const IconMoon = I(<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />, 'Moon');
export const IconMonitor = I(<><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></>, 'Monitor');
export const IconPanelClose = I(<><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16M9 10l2 2-2 2" /></>, 'PanelClose');
export const IconPaperclip = I(<path d="M21.4 11.1l-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5" />, 'Paperclip');
export const IconImage = I(<><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="M21 15l-5-5L5 21" /></>, 'Image');
export const IconCamera = I(<><path d="M3 8a2 2 0 0 1 2-2h2l2-2h6l2 2h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><circle cx="12" cy="13" r="3.5" /></>, 'Camera');
export const IconFile = I(<><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></>, 'File');
export const IconCopy = I(<><rect x="8" y="8" width="13" height="13" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></>, 'Copy');
export const IconCheck = I(<path d="M20 6L9 17l-5-5" />, 'Check');
export const IconRefresh = I(<><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16" /><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8" /><path d="M21 3v5h-5M3 21v-5h5" /></>, 'Refresh');
export const IconUndo = I(<><path d="M9 14L4 9l5-5" /><path d="M4 9h11a5 5 0 0 1 0 10h-3" /></>, 'Undo');
export const IconRewind = I(<><path d="M11 19l-7-7 7-7" /><path d="M20 19l-7-7 7-7" /></>, 'Rewind');
export const IconBranch = I(<><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="8" r="2" /><path d="M6 7v10M18 10c0 4-6 3-11 7" /></>, 'Branch');
export const IconEdit = I(<><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4z" /></>, 'Edit');
export const IconTrash = I(<><path d="M3 6h18M8 6V4h8v2M6 6l1 14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-14" /></>, 'Trash');
export const IconChevronDown = I(<path d="M6 9l6 6 6-6" />, 'ChevronDown');
export const IconChevronRight = I(<path d="M9 6l6 6-6 6" />, 'ChevronRight');
export const IconSearch = I(<><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></>, 'Search');
export const IconShield = I(<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" />, 'Shield');
export const IconShieldCheck = I(<><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" /><path d="M9 12l2 2 4-4" /></>, 'ShieldCheck');
export const IconLock = I(<><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>, 'Lock');
export const IconZap = I(<path d="M13 2L4 14h7l-1 8 9-12h-7z" />, 'Zap');
export const IconDiff = I(<><path d="M12 3v14M5 10h14" /><path d="M5 21h14" /></>, 'Diff');
export const IconLayers = I(<><path d="M12 3l9 5-9 5-9-5z" /><path d="M3 13l9 5 9-5" /></>, 'Layers');
export const IconCpu = I(<><rect x="6" y="6" width="12" height="12" rx="2" /><rect x="9.5" y="9.5" width="5" height="5" rx=".5" /><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" /></>, 'Cpu');
export const IconEye = I(<><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>, 'Eye');
export const IconEyeOff = I(<><path d="M17.9 17.9A10 10 0 0 1 12 19c-6.5 0-10-7-10-7a18 18 0 0 1 4.1-5.1M9.9 5.2A9 9 0 0 1 12 5c6.5 0 10 7 10 7a18 18 0 0 1-2.2 3.2" /><path d="M14.1 14.1a3 3 0 1 1-4.2-4.2M2 2l20 20" /></>, 'EyeOff');
export const IconBrain = I(<><path d="M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 6 1V5a2 2 0 0 0-3-1z" /><path d="M15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-6 1" /></>, 'Brain');
export const IconTool = I(<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z" />, 'Tool');
export const IconAlert = I(<><path d="M12 3l10 18H2z" /><path d="M12 10v5M12 18h.01" /></>, 'Alert');
export const IconInfo = I(<><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7.5h.01" /></>, 'Info');
export const IconCircle = I(<circle cx="12" cy="12" r="8" />, 'Circle');
export const IconDot = I(<circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />, 'Dot');
export const IconPlug = I(<><path d="M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-12 0z" /><path d="M12 17v5" /></>, 'Plug');
export const IconList = I(<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />, 'List');
export const IconDownload = I(<><path d="M12 3v12M7 10l5 5 5-5" /><path d="M5 21h14" /></>, 'Download');
export const IconCode = I(<path d="M16 18l6-6-6-6M8 6l-6 6 6 6" />, 'Code');
export const IconSparkle = I(<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z" />, 'Sparkle');
export const IconQuestion = I(<><circle cx="12" cy="12" r="9" /><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17h.01" /></>, 'Question');
export const IconMore = I(<path d="M5 12h.01M12 12h.01M19 12h.01" stroke-width={3} />, 'More');
export const IconMaximize = I(<path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3" />, 'Maximize');
export const IconGrid = I(<><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>, 'Grid');
export const IconSliders = I(<><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" /><circle cx="16" cy="6" r="2" /><circle cx="10" cy="12" r="2" /><circle cx="18" cy="18" r="2" /></>, 'Sliders');
export const IconFolder = I(<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />, 'Folder');
export const IconGlobe = I(<><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></>, 'Globe');
