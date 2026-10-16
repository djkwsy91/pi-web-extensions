/**
 * DeepSeek 峰谷时段 footer 状态
 *
 * 计费规则（以 UTC 为基准，来源 https://api-docs.deepseek.com/quick_start/pricing/）：
 *   高峰 = 周一至周五 01:00-04:00 与 06:00-10:00 UTC，且非法定节假日
 *        = 北京时间 09:00-12:00 与 14:00-18:00（周一至周五，法定节假日除外）
 *   低谷 = 其余全部时间（含周末与法定节假日全天），价格为高峰的一半（-50%）
 *
 * 节假日数据（三者取并集，无需手工维护）：
 *   1) 内置 2026 年数据（国务院办公厅 2025-11-04 通知，已与 holiday-cn 抓取结果逐日比对一致）
 *   2) 联网自动抓取 → 落盘缓存 ~/.pi/agent/deepseek-peak-cache.json
 *      数据源依次尝试：NateScarlet/holiday-cn（抓取国务院公告）→ timor.tech → jiejiariapi.com
 *   3) 手工覆盖 ~/.pi/agent/deepseek-peak-holidays.json（优先级最高），值为日期或日期区间：
 *      { "2027": ["2027-01-01", "2027-02-05..2027-02-11"] }
 * 注：调休上班的周末（如 2026-10-10）不算法定节假日，按“周末全天低谷”处理。
 *
 * 显示形式: `DeepSeek 峰时段 · 距谷 1h（周一 09:00）`
 *   - 峰时段橙色、谷时段绿色（TUI 用主题色 / pi-web 用 ANSI 256 色；当前模型不是 DeepSeek 时整行压暗）
 *   - 时长零单位省略：`2d15h` / `11h26m` / `26m`
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "deepseek-peak";
const HOLIDAY_FILE = join(homedir(), ".pi", "agent", "deepseek-peak-holidays.json");
/** 联网抓取结果的落盘缓存（扩展自动维护，无需手工编辑）。 */
const CACHE_FILE = join(homedir(), ".pi", "agent", "deepseek-peak-cache.json");
const FETCH_TIMEOUT_MS = 10_000;
/** DeepSeek 官方高峰时段按 UTC 定义，这里统一换算到北京时间（固定 UTC+8，无夏令时）。 */
const CHINA_UTC_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 86_400_000;
/** 已拿到数据后的刷新周期；尚未公布（空结果）时用更短的间隔重试。 */
const FETCH_TTL_MS = 30 * DAY_MS;
const EMPTY_FETCH_TTL_MS = 6 * 60 * 60 * 1000;
const TICK_MS = 1_000;
const HOLIDAY_RECHECK_MS = 60_000;

/** 高峰时段，单位为北京时间当天 00:00 起的分钟数。 */
const PEAK_WINDOWS: ReadonlyArray<readonly [number, number]> = [
	[9 * 60, 12 * 60],
	[14 * 60, 18 * 60],
];

const BUILTIN_HOLIDAY_RANGES: readonly string[] = [
	// 2026 年（国务院办公厅关于 2026 年部分节假日安排的通知）
	"2026-01-01..2026-01-03", // 元旦
	"2026-02-15..2026-02-23", // 春节
	"2026-04-04..2026-04-06", // 清明节
	"2026-05-01..2026-05-05", // 劳动节
	"2026-06-19..2026-06-21", // 端午节
	"2026-09-25..2026-09-27", // 中秋节
	"2026-10-01..2026-10-07", // 国庆节
];

const pad2 = (n: number) => String(n).padStart(2, "0");
const dateKey = (wallMs: number) => {
	const d = new Date(wallMs);
	return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
};

function expandRanges(entries: readonly string[]): string[] {
	const days: string[] = [];
	for (const entry of entries) {
		if (typeof entry !== "string") continue;
		const [from, to] = entry.split("..").map((part) => part.trim());
		const fromMs = Date.parse(`${from}T00:00:00Z`);
		if (!Number.isFinite(fromMs)) continue;
		const toMs = to ? Date.parse(`${to}T00:00:00Z`) : fromMs;
		if (!Number.isFinite(toMs) || toMs < fromMs) continue;
		for (let ms = fromMs; ms <= toMs; ms += DAY_MS) days.push(dateKey(ms));
	}
	return days;
}

/** 缓存中按年保存的抓取结果。 */
export interface HolidayCacheEntry {
	/** 抓取时间（毫秒时间戳）。 */
	fetchedAt: number;
	/** 命中的数据源名称。 */
	source?: string;
	/** 法定节假日日期（YYYY-MM-DD）；空数组代表该年尚未公布。 */
	days: string[];
}

export interface HolidayCache {
	years: Record<string, HolidayCacheEntry>;
}

/** 去重、排序，并丢弃不属于该年或格式不合法的日期。 */
function sanitizeDays(year: string, days: readonly unknown[]): string[] {
	const out = new Set<string>();
	for (const day of days) {
		if (typeof day !== "string") continue;
		const value = day.trim().slice(0, 10);
		if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !value.startsWith(`${year}-`)) continue;
		out.add(value);
	}
	return [...out].sort();
}

/** 一个节假日数据源：URL + 响应解析（只取法定节假日，不含调休上班日）。 */
export interface HolidaySource {
	name: string;
	url: (year: string) => string;
	parse: (year: string, payload: unknown) => string[];
}

export const HOLIDAY_SOURCES: readonly HolidaySource[] = [
	{
		// 每日抓取国务院公告生成，含 papers 原文链接
		name: "holiday-cn",
		url: (year) => `https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/${year}.json`,
		parse: (year, payload) => {
			const days = (payload as { days?: Array<{ date?: unknown; isOffDay?: unknown }> } | null)?.days;
			if (!Array.isArray(days)) return [];
			return sanitizeDays(year, days.filter((day) => day?.isOffDay !== false).map((day) => day?.date));
		},
	},
	{
		name: "timor.tech",
		url: (year) => `https://timor.tech/api/holiday/year/${year}`,
		parse: (year, payload) => {
			const holiday = (payload as { holiday?: Record<string, { holiday?: unknown; date?: unknown }> } | null)?.holiday;
			if (!holiday || typeof holiday !== "object") return [];
			return sanitizeDays(year, Object.values(holiday).filter((day) => day?.holiday === true).map((day) => day?.date));
		},
	},
	{
		name: "jiejiariapi.com",
		url: (year) => `https://api.jiejiariapi.com/v1/holidays/${year}`,
		parse: (year, payload) => {
			if (!payload || typeof payload !== "object") return [];
			const days = Object.values(payload as Record<string, { date?: unknown; isOffDay?: unknown }>);
			return sanitizeDays(year, days.filter((day) => day?.isOffDay === true).map((day) => day?.date));
		},
	},
];

/** 读取抓取缓存；文件缺失或损坏时返回空缓存。 */
export function loadHolidayCache(file: string = CACHE_FILE): HolidayCache {
	try {
		const raw = JSON.parse(readFileSync(file, "utf8")) as { years?: Record<string, HolidayCacheEntry> };
		const years: Record<string, HolidayCacheEntry> = {};
		for (const [year, entry] of Object.entries(raw?.years ?? {})) {
			if (!entry || !Array.isArray(entry.days)) continue;
			years[year] = { fetchedAt: Number(entry.fetchedAt) || 0, source: entry.source, days: sanitizeDays(year, entry.days) };
		}
		return { years };
	} catch {
		return { years: {} };
	}
}

export function saveHolidayCache(cache: HolidayCache, file: string = CACHE_FILE): boolean {
	try {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, `${JSON.stringify(cache, null, "\t")}\n`);
		return true;
	} catch {
		return false;
	}
}

/** 该年是否需要重新抓取。 */
export function needsHolidayFetch(entry: HolidayCacheEntry | undefined, nowMs: number): boolean {
	if (!entry) return true;
	const ttl = entry.days.length > 0 ? FETCH_TTL_MS : EMPTY_FETCH_TTL_MS;
	return nowMs - entry.fetchedAt >= ttl;
}

/** 依次尝试各数据源，返回首个非空结果；全部失败/未公布时返回空数组。 */
export async function fetchHolidayYear(
	year: string,
	fetchImpl: typeof fetch = fetch,
	timeoutMs: number = FETCH_TIMEOUT_MS,
): Promise<{ days: string[]; source?: string }> {
	if (typeof fetchImpl !== "function") return { days: [] };
	for (const source of HOLIDAY_SOURCES) {
		let ceiling: ReturnType<typeof setTimeout> | undefined;
		try {
			// AbortSignal 只能让“守规矩”的 fetch 停下来，外面再套一层硬超时兑现 timeoutMs 承诺。
			const days = await Promise.race([
				(async () => {
					const response = await fetchImpl(source.url(year), {
						headers: { "user-agent": "pi-deepseek-peak/1.0", accept: "application/json" },
						signal: AbortSignal.timeout(timeoutMs),
					});
					if (!response.ok) return undefined;
					return source.parse(year, await response.json());
				})(),
				new Promise<undefined>((resolve) => {
					ceiling = setTimeout(() => resolve(undefined), timeoutMs + 250);
				}),
			]);
			if (days && days.length > 0) return { days, source: source.name };
		} catch {
			// 超时 / 网络错误 / JSON 解析失败：换下一个数据源
		} finally {
			if (ceiling) clearTimeout(ceiling);
		}
	}
	return { days: [] };
}

/** 内置节假日 + 联网缓存 + 用户 JSON 的并集。 */
export function loadHolidays(file: string = HOLIDAY_FILE, cacheFile: string = CACHE_FILE): Set<string> {
	const days = expandRanges(BUILTIN_HOLIDAY_RANGES);
	for (const entry of Object.values(loadHolidayCache(cacheFile).years)) days.push(...entry.days);
	try {
		const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
		for (const [key, value] of Object.entries(raw)) {
			if (key === "holidays") {
				if (Array.isArray(value)) days.push(...expandRanges(value as string[]));
				continue;
			}
			// 年份 → 日期列表
			if (Array.isArray(value)) days.push(...expandRanges(value as string[]));
		}
	} catch {
		// 文件不存在或格式错误时只使用内置数据
	}
	return new Set(days);
}

export type RateReason = "weekday" | "weekend" | "holiday";

/** 着色档位：峰时段用 warning（橙）、谷时段用 success（绿）。 */
export type Tone = "success" | "warning";

/** 给「峰时段 / 谷时段」着色的钩子；不传就是纯文本（测试与调试用）。 */
export interface TextStyle {
	token?: (tone: Tone, text: string) => string;
}

export interface DeepSeekRate {
	/** 当前是否高峰时段。 */
	peak: boolean;
	/** 非高峰的原因；高峰恒为 "weekday"。 */
	reason: RateReason;
	/** 距下次切换的毫秒数。 */
	msToChange: number;
	/** 切换后的状态：true 表示进入高峰。 */
	nextPeak: boolean;
	/** 切换发生的北京时间日期（YYYY-MM-DD）与当天分钟数。 */
	changeDate: string;
	changeMinutes: number;
}

function isPeakDay(key: string, dow: number, holidays: ReadonlySet<string>): boolean {
	if (dow === 0 || dow === 6) return false;
	return !holidays.has(key);
}

function windowsOf(key: string, dow: number, holidays: ReadonlySet<string>): ReadonlyArray<readonly [number, number]> {
	return isPeakDay(key, dow, holidays) ? PEAK_WINDOWS : [];
}

export function evaluateRate(nowMs: number, holidays: ReadonlySet<string> = loadHolidays()): DeepSeekRate {
	// 北京时间时间轴 = UTC 时间轴整体平移 UTC+8，因此 wallNow 既是“北京墙上时间”，也保持了毫秒精度。
	const wallNow = nowMs + CHINA_UTC_OFFSET_MS;
	const bj = new Date(wallNow);
	const key = dateKey(wallNow);
	const dayStart = Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate());
	const sinceMidnight = wallNow - dayStart;
	const dow = bj.getUTCDay();
	const windows = windowsOf(key, dow, holidays);

	const active = windows.find(([start, end]) => sinceMidnight >= start * 60000 && sinceMidnight < end * 60000);
	if (active) {
		return {
			peak: true,
			reason: "weekday",
			msToChange: dayStart + active[1] * 60000 - wallNow,
			nextPeak: false,
			changeDate: key,
			changeMinutes: active[1],
		};
	}

	// 低谷：下一次切换必然是某个高峰时段的开始（当天或之后某天 09:00）。
	for (let offset = 0; offset <= 9; offset++) {
		const wall = dayStart + offset * DAY_MS;
		const d = new Date(wall);
		const dayKey = dateKey(wall);
		for (const [start] of windowsOf(dayKey, d.getUTCDay(), holidays)) {
			const startWall = wall + start * 60000;
			if (startWall > wallNow) {
				return {
					peak: false,
					reason: dow === 0 || dow === 6 ? "weekend" : holidays.has(key) ? "holiday" : "weekday",
					msToChange: startWall - wallNow,
					nextPeak: true,
					changeDate: dayKey,
					changeMinutes: start,
				};
			}
		}
	}
	// 理论上不可达：未来 9 天一定含工作日。
	return { peak: false, reason: dow === 0 || dow === 6 ? "weekend" : "weekday", msToChange: 0, nextPeak: true, changeDate: key, changeMinutes: 0 };
}

/**
 * 时长格式化：`2d15h` / `11h26m` / `26m`（零单位省略，和 opencode-go-usage 一致）。
 */
export function formatDuration(ms: number): string {
	const minutes = Math.max(0, Math.ceil(ms / 60_000));
	const d = Math.floor(minutes / 1440);
	const h = Math.floor((minutes % 1440) / 60);
	const m = minutes % 60;
	if (d > 0) return h > 0 ? `${d}d${h}h` : `${d}d`;
	if (h > 0) return m > 0 ? `${h}h${pad2(m)}m` : `${h}h`;
	return `${m}m`;
}

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** 切换时刻提示：`10:30` / `明天 09:00` / `周一 09:00`（括号由调用方加）。 */
export function formatSwitchHint(nowMs: number, rate: DeepSeekRate): string {
	const clock = `${pad2(Math.floor(rate.changeMinutes / 60))}:${pad2(rate.changeMinutes % 60)}`;
	const todayWall = new Date(nowMs + CHINA_UTC_OFFSET_MS);
	const today = Date.UTC(todayWall.getUTCFullYear(), todayWall.getUTCMonth(), todayWall.getUTCDate());
	const target = Date.parse(`${rate.changeDate}T00:00:00Z`);
	const diff = Math.round((target - today) / DAY_MS);
	if (diff === 0) return `今天 ${clock}`;
	if (diff === 1) return `明天 ${clock}`;
	const dow = new Date(target).getUTCDay();
	return `${WEEKDAYS[dow]} ${clock}`;
}

/**
 * 例如 `DeepSeek 峰时段 · 距谷 1h（周一 09:00）`。
 * 峰时段橙色、谷时段绿色（颜色由 style 决定：TUI 用主题色，RPC 用 ANSI）。
 */
export function formatRateText(
	nowMs: number,
	holidays: ReadonlySet<string> = loadHolidays(),
	style: TextStyle = {},
): string {
	const rate = evaluateRate(nowMs, holidays);
	const raw = rate.peak ? "峰时段" : "谷时段";
	const token = style.token ? style.token(rate.peak ? "warning" : "success", raw) : raw;
	const target = rate.nextPeak ? "峰" : "谷";
	return `DeepSeek ${token} · 距${target} ${formatDuration(rate.msToChange)}（${formatSwitchHint(nowMs, rate)}）`;
}

/** ANSI 256 色：橙 166 / 绿 71（与 pi-web 的 ansi-to-html 调色板对得上）。 */
const ANSI_TONE: Record<Tone, string> = {
	success: "\u001b[38;5;71m",
	warning: "\u001b[38;5;166m",
};
const ANSI_RESET = "\u001b[0m";

/** RPC（pi-web）用；pi-web 的 theme.fg 是恒等函数，只能自己塞 ANSI。 */
export const ANSI_STYLE: TextStyle = {
	token: (tone, text) => `${ANSI_TONE[tone]}${text}${ANSI_RESET}`,
};

/** 当前模型不是 DeepSeek 时整行压暗（RPC）。 */
export function ansiDim(text: string): string {
	return `\u001b[2m${text}${ANSI_RESET}`;
}

const DEEPSEEK_MODEL_RE = /deepseek/i;
function isDeepSeekModel(model: { id?: string; name?: string; provider?: string; baseUrl?: string } | undefined): boolean {
	if (!model) return false;
	return [model.id, model.name, model.provider, model.baseUrl].some((value) => typeof value === "string" && DEEPSEEK_MODEL_RE.test(value));
}

export default function (pi: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | undefined;
	let holidays = loadHolidays();
	const cache = loadHolidayCache();
	const fetching = new Set<string>();
	let holidayMtime = 0;
	let lastHolidayCheck = 0;
	let lastText = "";
	let highlight = false;
	let warnedYear: string | undefined;

	const refreshHolidays = (force = false) => {
		const now = Date.now();
		if (!force && now - lastHolidayCheck < HOLIDAY_RECHECK_MS) return;
		lastHolidayCheck = now;
		let mtime = 0;
		try {
			mtime = statSync(HOLIDAY_FILE).mtimeMs;
		} catch {
			mtime = 0;
		}
		if (force || mtime !== holidayMtime) {
			holidayMtime = mtime;
			holidays = loadHolidays();
		}
	};

	/**
	 * `ctx.hasUI` 在 tui / rpc（pi-web 服务端跑的就是 rpc）下为 true，json / print 下为 false。
	 * 类型定义：node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:216-219
	 */
	const canShowStatus = (ctx: ExtensionContext) => ctx.hasUI;

	/** setStatus 在无 UI 的 mode 下是 no-op；包一层 try/catch 防止会话结束后拿到过期 ctx。 */
	const safeSetStatus = (ctx: ExtensionContext, text: string | undefined) => {
		try {
			ctx.ui.setStatus(STATUS_KEY, text);
		} catch {
			// 会话已结束 / ctx 已过期，忽略
		}
	};

	const render = (ctx: ExtensionContext, force = false) => {
		if (!canShowStatus(ctx)) return;
		refreshHolidays();
		const now = Date.now();
		const style: TextStyle =
			ctx.mode === "tui" ? { token: (tone, text) => ctx.ui.theme.fg(tone, text) } : ANSI_STYLE;
		const text = formatRateText(now, holidays, style);
		if (!force && text === lastText) return;
		lastText = text;
		// pi-web 的 theme.fg 是恒等函数，所以非 TUI 走 ANSI；颜色最终由前端 ansi-to-html 渲染。
		if (ctx.mode === "tui") {
			safeSetStatus(ctx, highlight ? text : ctx.ui.theme.fg("dim", text));
			return;
		}
		safeSetStatus(ctx, highlight ? text : ansiDim(text));
	};

	const missingYear = (year: string) => ![...holidays].some((day) => day.startsWith(`${year}-`));

	/**
	 * 后台抓取缺失/过期的节假日数据。**故意不 await**：session_start 的 handler 会阻塞启动。
	 * 抓到后热更新并重绘；全部失败时静默降级为内置数据 + 手工 JSON。
	 */
	const refreshFromNetwork = (ctx: ExtensionContext) => {
		const now = Date.now();
		const beijing = new Date(now + CHINA_UTC_OFFSET_MS);
		const year = String(beijing.getUTCFullYear());
		// 11 月起下一次切换可能跳年（如 12-31 → 次年 01-04），需要下一年数据
		const targets = beijing.getUTCMonth() >= 10 ? [year, String(Number(year) + 1)] : [year];
		for (const target of targets) {
			if (fetching.has(target) || !needsHolidayFetch(cache.years[target], now)) continue;
			fetching.add(target);
			void fetchHolidayYear(target)
				.then((result) => {
					cache.years[target] = { fetchedAt: Date.now(), source: result.source, days: result.days };
					saveHolidayCache(cache);
					if (result.days.length > 0) {
						holidays = loadHolidays();
						render(ctx, true);
						return;
					}
					// 该年公告尚未发布，或全部数据源不可用
					if (!missingYear(target) || warnedYear === target) return;
					warnedYear = target;
					try {
						ctx.ui.notify(
							`DeepSeek 峰谷：未获取到 ${target} 年法定节假日数据，暂时只按工作日/周末判断。可写入 ${HOLIDAY_FILE} 手工补充。`,
							"warning",
						);
					} catch {
						// ctx 已过期
					}
				})
				.catch(() => {
					// fetchHolidayYear 内部已兜底，这里仅防止未捕获的 rejection
				})
				.finally(() => fetching.delete(target));
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		refreshHolidays(true);
		highlight = isDeepSeekModel(ctx.model);
		if (!canShowStatus(ctx)) return;
		render(ctx, true);
		refreshFromNetwork(ctx);

		if (timer) clearInterval(timer);
		timer = setInterval(() => render(ctx), TICK_MS);
		// 不阻塞事件循环退出（pi-web 的会话进程会空闲回收）
		timer.unref?.();
	});

	pi.on("model_select", async (event, ctx) => {
		highlight = isDeepSeekModel(event.model);
		render(ctx, true);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (timer) clearInterval(timer);
		timer = undefined;
		lastText = "";
		safeSetStatus(ctx, undefined);
	});
}
