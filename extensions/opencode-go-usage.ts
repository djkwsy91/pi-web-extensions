/**
 * opencode-go-usage — 在 footer 显示 OpenCode Go 套餐的额度使用情况。
 *
 * 行为:
 * - 只对 opencode-go / OpenCode Go 模型生效（按 provider / baseUrl 判定）
 * - key 自动读取: 先看 OPENCODE_GO_API_KEY / OPENCODE_API_KEY，再从 ~/.pi/agent/auth.json
 *   取当前 provider 的凭据；读不到 → 不显示任何状态
 * - 每 5 分钟请求一次 https://opencode.ai/zen/go/v1/usage
 *   （percent 就是「已用」百分比，数字用它）
 * - 两次请求之间每 30 秒用本地倒计时重绘，不产生网络请求
 * - 文案形如: ◆ Go │ 5h 40% ↻2h18m │ 周 70% ↻3d4h │ 月 30% ↻16d
 * - 颜色按每个窗口自己的已用百分比: <70 绿、70–89 黄、≥90 红（只给数字上色）
 * - TUI 用主题色（theme.fg/bold），RPC（pi-web）用 ANSI 256 色（前端 ansi-to-html 会渲染）
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "opencode-go-usage";
const USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const USER_AGENT = "pi-opencode-go-usage/1.0";
/** 网络刷新间隔 */
const REFRESH_MS = 5 * 60 * 1000;
/** 本地重绘间隔（只更新倒计时） */
const TICK_MS = 30 * 1000;
const FETCH_TIMEOUT_MS = 10 * 1000;
/** 连续失败多少次后给文案加 ⚠ 前缀 */
const STALE_AFTER_FAILURES = 3;

export type WindowKey = "rolling" | "weekly" | "monthly";

export interface UsageWindow {
	status: string;
	/** 已用百分比（接口语义） */
	percent: number;
	/** 重置时间（epoch ms），接口没给或解析失败时为 undefined */
	resetsAt?: number;
}

export interface UsageSnapshot {
	fetchedAt: number;
	windows: Partial<Record<WindowKey, UsageWindow>>;
}

export interface MinimalModel {
	id?: string;
	name?: string;
	provider?: string;
	baseUrl?: string;
}

const WINDOW_KEYS: readonly WindowKey[] = ["rolling", "weekly", "monthly"];
const WINDOW_LABELS: Record<WindowKey, string> = {
	rolling: "5h",
	weekly: "周",
	monthly: "月",
};

/* ------------------------------------------------------------------ 环境 */

/** pi 的配置目录，尊重 PI_CODING_AGENT_DIR。 */
export function agentDir(): string {
	const fromEnv = process.env.PI_CODING_AGENT_DIR?.trim();
	return fromEnv && fromEnv.length > 0 ? fromEnv : join(homedir(), ".pi", "agent");
}

/** 当前模型是不是走 OpenCode Go。 */
export function isOpenCodeGoModel(model: MinimalModel | undefined): boolean {
	if (!model) return false;
	const provider = (model.provider ?? "").toLowerCase();
	if (provider.includes("opencode")) return true;
	const base = (model.baseUrl ?? "").toLowerCase();
	return base.includes("opencode.ai/inference/go") || base.includes("opencode.ai/zen/go");
}

/**
 * 用量接口固定挂在官方源上；baseUrl 指向别处（自建代理等）就不查，
 * 避免把用户 key 发给第三方。
 */
export function usageUrlFor(model: MinimalModel | undefined): string | undefined {
	const baseUrl = model?.baseUrl?.trim();
	if (!baseUrl) return USAGE_URL;
	let host: string;
	try {
		host = new URL(baseUrl).host.toLowerCase();
	} catch {
		return undefined;
	}
	return host === "opencode.ai" || host.endsWith(".opencode.ai") ? USAGE_URL : undefined;
}

/* ------------------------------------------------------------------ 凭据 */

export interface ResolvedKey {
	key: string;
	source: "env" | "auth.json";
}

function credentialKey(value: unknown): string | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	for (const field of ["key", "access", "access_token", "apiKey", "token"]) {
		const candidate = record[field];
		if (typeof candidate === "string" && candidate.trim().length > 0) return candidate.trim();
	}
	return undefined;
}

/** 从 auth.json 读某个 provider（或名字里带 opencode 的 provider）的 key。 */
export function readStoredKey(providerId: string | undefined, authFile = join(agentDir(), "auth.json")): string | undefined {
	let raw: string;
	try {
		raw = readFileSync(authFile, "utf8");
	} catch {
		return undefined;
	}
	let document: unknown;
	try {
		document = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!document || typeof document !== "object" || Array.isArray(document)) return undefined;
	const entries = document as Record<string, unknown>;
	const ids = Object.keys(entries);
	const looksLikeOpenCode = (id: string): boolean => /opencode/i.test(id);
	// 先精确匹配 provider；provider 名字本身带 opencode 时再放宽到同类 id，
	// 绝不拿别的 provider 的 key 去查 opencode 的接口
	const candidates = providerId
		? [...ids.filter((id) => id === providerId), ...(looksLikeOpenCode(providerId) ? ids.filter(looksLikeOpenCode) : [])]
		: ids.filter(looksLikeOpenCode);
	for (const id of candidates) {
		const key = credentialKey(entries[id]);
		if (key) return key;
	}
	return undefined;
}

export function resolveApiKey(providerId: string | undefined, authFile?: string): ResolvedKey | undefined {
	const fromEnv = process.env.OPENCODE_GO_API_KEY?.trim() || process.env.OPENCODE_API_KEY?.trim();
	if (fromEnv) return { key: fromEnv, source: "env" };
	const stored = readStoredKey(providerId, authFile);
	return stored ? { key: stored, source: "auth.json" } : undefined;
}

/* ------------------------------------------------------------------ 解析 */

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

export function parseUsage(payload: unknown, now = Date.now()): UsageSnapshot | undefined {
	const usage = asRecord(asRecord(payload)?.usage);
	if (!usage) return undefined;
	const windows: Partial<Record<WindowKey, UsageWindow>> = {};
	for (const name of WINDOW_KEYS) {
		const raw = asRecord(usage[name]);
		if (!raw) continue;
		const percent = typeof raw.percent === "number" && Number.isFinite(raw.percent) ? raw.percent : undefined;
		if (percent === undefined) continue;
		const status = typeof raw.status === "string" && raw.status.trim().length > 0 ? raw.status.trim() : "unknown";
		const parsedReset = typeof raw.resetsAt === "string" ? Date.parse(raw.resetsAt) : Number.NaN;
		windows[name] = {
			status,
			percent,
			...(Number.isFinite(parsedReset) ? { resetsAt: parsedReset } : {}),
		};
	}
	return Object.keys(windows).length > 0 ? { fetchedAt: now, windows } : undefined;
}

/* ------------------------------------------------------------------ 文案 */

/** 时长文案：2d9h / 1h20m / 45m。 */
export function formatCountdown(resetsAtMs: number | undefined, nowMs: number): string | undefined {
	if (resetsAtMs === undefined) return undefined;
	const delta = resetsAtMs - nowMs;
	if (!Number.isFinite(delta) || delta <= 0) return undefined;
	const totalMinutes = Math.ceil(delta / 60_000);
	const days = Math.floor(totalMinutes / 1440);
	const hours = Math.floor((totalMinutes % 1440) / 60);
	const minutes = totalMinutes % 60;
	if (days > 0) return hours > 0 ? `${days}d${hours}h` : `${days}d`;
	if (hours > 0) return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
	return `${minutes}m`;
}

/** 已用百分比（接口语义，夹到 0–100）。 */
export function usedPercent(window: UsageWindow): number {
	return Math.max(0, Math.min(100, window.percent));
}

/** 颜色档位：<70 绿、70–89 黄、≥90 红。 */
export function toneFor(percent: number): Tone {
	if (percent >= 90) return "error";
	if (percent >= 70) return "warning";
	return "success";
}

export type Tone = "success" | "warning" | "error";

/** 上色/加粗钩子；不传就是纯文本（测试与降级用）。 */
export interface TextStyle {
	/** 给百分比数字上色 */
	cell?: (tone: Tone, text: string) => string;
	/** 加粗 Go 标签 */
	bold?: (text: string) => string;
}

function windowSegment(name: WindowKey, window: UsageWindow, nowMs: number, style: TextStyle): string {
	const rateLimited = window.status === "rate-limited";
	const percent = rateLimited ? 100 : usedPercent(window);
	const rawValue = rateLimited ? "限流" : `${Math.round(percent)}%`;
	const value = style.cell ? style.cell(toneFor(percent), rawValue) : rawValue;
	const countdown = formatCountdown(window.resetsAt, nowMs);
	return `${WINDOW_LABELS[name]} ${value}${countdown ? ` ↻${countdown}` : ""}`;
}

/**
 * 例如 `◆ Go │ 5h 40% ↻2h18m │ 周 70% ↻3d4h │ 月 30% ↻16d`。
 * 每个窗口的颜色由它自己的已用百分比决定。
 */
export function formatRateText(
	snapshot: UsageSnapshot,
	nowMs: number,
	stale = false,
	style: TextStyle = {},
): string | undefined {
	const segments = WINDOW_KEYS.map((name) => {
		const window = snapshot.windows[name];
		return window ? windowSegment(name, window, nowMs, style) : undefined;
	}).filter((segment): segment is string => Boolean(segment));
	if (segments.length === 0) return undefined;
	const label = style.bold ? style.bold("Go") : "Go";
	return `${stale ? "⚠ " : ""}◆ ${label} │ ${segments.join(" │ ")}`;
}

/** ANSI 256 色：绿 / 橙 / 红。 */
const ANSI_TONE: Record<Tone, string> = {
	success: "\u001b[38;5;71m",
	warning: "\u001b[38;5;166m",
	error: "\u001b[38;5;160m",
};
const ANSI_RESET = "\u001b[0m";

/** RPC 模式（pi-web）用；pi-web 的 theme.fg 是恒等函数，只能自己塞 ANSI。 */
export const ANSI_STYLE: TextStyle = {
	cell: (tone, text) => `${ANSI_TONE[tone]}${text}${ANSI_RESET}`,
	bold: (text) => `\u001b[1m${text}${ANSI_RESET}`,
};

/* ------------------------------------------------------------------ 网络 */

export function fetchUsage(
	url: string,
	key: string,
	timeoutMs = FETCH_TIMEOUT_MS,
): Promise<unknown> {
	const controller = new AbortController();
	const softTimer = setTimeout(() => controller.abort(), timeoutMs);
	let hardTimer: ReturnType<typeof setTimeout> | undefined;
	const hardStop = new Promise<never>((_resolve, reject) => {
		// 这个 timer 故意不 unref：即使 fetch 完全无视 signal，也要保证硬超时能结算
		hardTimer = setTimeout(() => reject(new Error("usage request timed out")), timeoutMs + 250);
	});
	const request = fetch(url, {
		method: "GET",
		headers: {
			authorization: `Bearer ${key}`,
			accept: "application/json",
			"user-agent": USER_AGENT,
		},
		signal: controller.signal,
		// 不要把带 Bearer 的请求转发到别的域名
		redirect: "error",
	}).then(async (response) => {
		if (!response.ok) throw new Error(`usage request failed: HTTP ${response.status}`);
		return (await response.json()) as unknown;
	});
	return Promise.race([request, hardStop]).finally(() => {
		clearTimeout(softTimer);
		if (hardTimer) clearTimeout(hardTimer);
	});
}

/* ------------------------------------------------------------------ 扩展 */

export default function openCodeGoUsage(pi: ExtensionAPI): void {
	let snapshot: UsageSnapshot | undefined;
	let lastAttemptAt = 0;
	let failures = 0;
	let inFlight = false;
	let timer: ReturnType<typeof setInterval> | undefined;
	let timerCtx: ExtensionContext | undefined;

	const safeSetStatus = (ctx: ExtensionContext, text: string | undefined): void => {
		try {
			ctx.ui.setStatus(STATUS_KEY, text);
		} catch {
			// ctx 已过期（会话结束）等情况直接忽略
		}
	};

	const render = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI) return;
		const target = usageUrlFor(ctx.model);
		const key = isOpenCodeGoModel(ctx.model) ? resolveApiKey(ctx.model?.provider) : undefined;
		if (!target || !key || !snapshot) {
			safeSetStatus(ctx, undefined);
			return;
		}
		const style: TextStyle =
			ctx.mode === "tui"
				? { cell: (tone, cells) => ctx.ui.theme.fg(tone, cells), bold: (text) => ctx.ui.theme.bold(text) }
				: ANSI_STYLE;
		const text = formatRateText(snapshot, Date.now(), failures >= STALE_AFTER_FAILURES, style);
		if (!text) {
			safeSetStatus(ctx, undefined);
			return;
		}
		safeSetStatus(ctx, text);
	};

	const refresh = async (ctx: ExtensionContext): Promise<void> => {
		if (inFlight) return;
		const model = ctx.model;
		if (!isOpenCodeGoModel(model)) return;
		const url = usageUrlFor(model);
		const credential = resolveApiKey(model?.provider);
		if (!url || !credential) return;
		inFlight = true;
		lastAttemptAt = Date.now();
		try {
			const payload = await fetchUsage(url, credential.key);
			const parsed = parseUsage(payload);
			if (parsed) {
				snapshot = parsed;
				failures = 0;
			} else {
				failures += 1;
			}
		} catch {
			failures += 1;
		} finally {
			inFlight = false;
			render(ctx);
		}
	};

	const tick = (): void => {
		const ctx = timerCtx;
		if (!ctx) return;
		render(ctx);
		if (Date.now() - lastAttemptAt >= REFRESH_MS) void refresh(ctx);
	};

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		timerCtx = ctx;
		render(ctx);
		await refresh(ctx);
		if (!timer) {
			timer = setInterval(tick, TICK_MS);
			timer.unref?.();
		}
	});

	pi.on("model_select", async (_event, ctx) => {
		timerCtx = ctx;
		snapshot = undefined;
		failures = 0;
		lastAttemptAt = 0;
		render(ctx);
		await refresh(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
		timerCtx = undefined;
		snapshot = undefined;
		safeSetStatus(ctx, undefined);
	});
}
