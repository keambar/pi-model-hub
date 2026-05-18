/**
 * Model Hub Extension
 *
 * Loads model providers from multiple local JSON files and optional remote URLs.
 *
 * Directory: ~/.pi/agent/sources/
 *   - Each *.json file defines providers in { "providers": { ... } } format
 *   - _remote.json declares which files are synced from remote URLs
 *   - Files not listed in _remote.json are purely local
 *
 * Commands:
 *   /hub         — overlay panel: toggle, sync, reload, status
 *
 * Behavior:
 *   - On startup: load all source files, register providers
 *   - Remote sources: read cached file on disk, background refresh if stale
 *   - Toggle: enable/disable individual providers at runtime
 */

import type {
	ExtensionAPI,
	ProviderConfig,
	ProviderModelConfig,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, Focusable, TUI } from "@earendil-works/pi-tui";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Global configuration in _config.json */
interface GlobalConfig {
	/** Priority order for model parameter lookup from models.dev. Earlier entries win. */
	modelSourcePriority?: string[];
	/** TTL for models.dev cache in seconds. Default: 86400 (24h) */
	modelsDevTtl?: number;
}

/** A single model entry from models.dev */
interface ModelsDevModel {
	id?: string;
	name?: string;
	reasoning?: boolean;
	attachment?: boolean;
	limit?: { context?: number; output?: number };
	cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
	modalities?: { input?: string[]; output?: string[] };
}

/** Top-level models.dev response: { [providerId]: { models: { [key]: ModelsDevModel } } } */
type ModelsDevData = Record<string, { models?: Record<string, ModelsDevModel> }>;

/** Enrichment parameters resolved from models.dev for a model ID */
interface ModelDevParams {
	/** Which models.dev provider this data came from */
	provider: string;
	name?: string;
	reasoning?: boolean;
	input?: ("text" | "image")[];
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow?: number;
	maxTokens?: number;
}

/** Lookup map: model ID → resolved parameters from models.dev */
type ModelLookup = Map<string, ModelDevParams>;

/** Remote source declaration in _remote.json */
interface RemoteSource {
	url: string;
	/** Cache TTL in seconds. Default: 3600 */
	ttl?: number;
}

/** Format of _remote.json */
interface RemoteConfig {
	[filename: string]: RemoteSource;
}

/** Format of each source file (same as models.json providers section) */
interface SourceFileContent {
	providers: Record<string, SourceProviderConfig>;
}

/** Provider config in source files — mirrors models.json format with optional fields */
interface SourceProviderConfig {
	baseUrl?: string;
	apiKey?: string;
	api?: string;
	headers?: Record<string, string>;
	authHeader?: boolean;
	compat?: Record<string, unknown>;
	models?: SourceModelConfig[];
}

/** Model config in source files — optional fields with defaults */
interface SourceModelConfig {
	id: string;
	name?: string;
	api?: string;
	reasoning?: boolean;
	input?: ("text" | "image")[];
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow?: number;
	maxTokens?: number;
	headers?: Record<string, string>;
	compat?: Record<string, unknown>;
}

/** Tracked state per provider for toggle support */
interface ProviderState {
	sourceFile: string;
	config: ProviderConfig;
	enabled: boolean;
	/** Original model configs from source file (before enrichment) */
	rawModels?: SourceModelConfig[];
}

/** Result of a load/reload operation */
interface LoadResult {
	loaded: number;
	skipped: number;
	errors: string[];
	warnings: string[];
}

/** Row in the overlay provider list */
interface HubProviderRow {
	name: string;
	enabled: boolean;
	modelCount: number;
	sourceFile: string;
	isRemote: boolean;
	isStale: boolean;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const SOURCES_DIR = path.join(os.homedir(), ".pi", "agent", "sources");
const REMOTE_CONFIG_FILE = "_remote.json";
const CONFIG_FILE = "_config.json";
const MODELS_DEV_CACHE_FILE = "_models-dev-cache.json";
const MODELS_DEV_URL = "https://models.dev/api.json";
const MODELS_DEV_TTL = 86400; // 24h default

const DEFAULT_MODEL_SOURCE_PRIORITY = [
	"anthropic",
	"openai",
	"google",
	"deepseek",
	"moonshotai",
	"zai",
	"minimax",
	"xai",
	"meta",
	"openrouter",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureSourcesDir(): void {
	if (!fs.existsSync(SOURCES_DIR)) {
		fs.mkdirSync(SOURCES_DIR, { recursive: true });
	}
}

interface ReadJsonResult<T> {
	data?: T;
	error?: string;
}

function readJsonFile<T>(filePath: string): ReadJsonResult<T> {
	try {
		const content = fs.readFileSync(filePath, "utf-8");
		return { data: JSON.parse(content) as T };
	} catch (err) {
		if (err instanceof SyntaxError) {
			return { error: `invalid JSON: ${err.message}` };
		}
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			return { error: "file not found" };
		}
		return { error: `read error: ${err instanceof Error ? err.message : String(err)}` };
	}
}

function readRemoteConfig(): RemoteConfig {
	const configPath = path.join(SOURCES_DIR, REMOTE_CONFIG_FILE);
	const result = readJsonFile<RemoteConfig>(configPath);
	return result.data ?? {};
}

function readGlobalConfig(): GlobalConfig {
	const configPath = path.join(SOURCES_DIR, CONFIG_FILE);
	const result = readJsonFile<GlobalConfig>(configPath);
	return result.data ?? {};
}

const RESERVED_FILES = new Set([REMOTE_CONFIG_FILE, CONFIG_FILE, MODELS_DEV_CACHE_FILE]);

function listSourceFiles(): string[] {
	if (!fs.existsSync(SOURCES_DIR)) return [];
	return fs
		.readdirSync(SOURCES_DIR)
		.filter((f) => f.endsWith(".json") && !RESERVED_FILES.has(f))
		.sort();
}

/**
 * Build a model lookup map from models.dev cache data.
 * Models from providers earlier in the priority list win over later entries.
 */
function buildModelLookup(data: ModelsDevData, priority: string[]): ModelLookup {
	const lookup = new Map<string, ModelDevParams>();

	const providerIds = Object.keys(data);
	// Process in order: non-priority first, then priority in reverse (lowest first)
	// so the highest-priority provider is the last writer and wins.
	const ordered = [
		...providerIds.filter((p) => !priority.includes(p)),
		...priority.filter((p) => providerIds.includes(p)).reverse(),
	];

	for (const providerId of ordered) {
		const providerData = data[providerId];
		if (!providerData?.models) continue;

		for (const [, model] of Object.entries(providerData.models)) {
			const id = model.id;
			if (!id) continue;

			const inputModalities = model.modalities?.input ?? [];
			const input: ("text" | "image")[] = [];
			if (inputModalities.includes("text")) input.push("text");
			if (inputModalities.includes("image") || model.attachment) input.push("image");
			if (input.length === 0) input.push("text");

			const params: ModelDevParams = { provider: providerId, name: model.name, reasoning: model.reasoning, input };
			if (model.limit?.context) params.contextWindow = model.limit.context;
			if (model.limit?.output) params.maxTokens = model.limit.output;
			if (model.cost) {
				params.cost = {
					input: model.cost.input ?? 0,
					output: model.cost.output ?? 0,
					cacheRead: model.cost.cache_read ?? 0,
					cacheWrite: model.cost.cache_write ?? 0,
				};
			}
			lookup.set(id, params);
		}
	}

	return lookup;
}

/** Read models.dev cache from disk. Returns null if missing or corrupt. */
function readModelsDevCache(): ModelsDevData | null {
	const cachePath = path.join(SOURCES_DIR, MODELS_DEV_CACHE_FILE);
	const result = readJsonFile<ModelsDevData>(cachePath);
	return result.data ?? null;
}

/** Fetch models.dev data and write to cache file. */
async function fetchAndCacheModelsDev(): Promise<boolean> {
	const cachePath = path.join(SOURCES_DIR, MODELS_DEV_CACHE_FILE);
	try {
		const response = await fetch(MODELS_DEV_URL, { signal: AbortSignal.timeout(20000) });
		if (!response.ok) return false;
		const data = (await response.json()) as ModelsDevData;
		if (typeof data !== "object" || data === null) return false;
		ensureSourcesDir();
		fs.writeFileSync(cachePath, JSON.stringify(data) + "\n", "utf-8");
		return true;
	} catch {
		return false;
	}
}

function toProviderModelConfig(
	model: SourceModelConfig,
	providerApi?: string,
	lookup?: ModelLookup,
): ProviderModelConfig {
	const ref = lookup?.get(model.id);
	return {
		id: model.id,
		name: model.name ?? ref?.name ?? model.id,
		api: (model.api ?? providerApi) as ProviderModelConfig["api"],
		reasoning: model.reasoning ?? ref?.reasoning ?? false,
		input: model.input ?? ref?.input ?? ["text"],
		cost: model.cost ?? ref?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: model.contextWindow ?? ref?.contextWindow ?? 128000,
		maxTokens: model.maxTokens ?? ref?.maxTokens ?? 16384,
		headers: model.headers,
		compat: model.compat as ProviderModelConfig["compat"],
	};
}

function toProviderConfig(source: SourceProviderConfig, lookup?: ModelLookup): ProviderConfig {
	const models = source.models?.map((m) => toProviderModelConfig(m, source.api, lookup));
	return {
		baseUrl: source.baseUrl,
		apiKey: source.apiKey,
		api: source.api as ProviderConfig["api"],
		headers: source.headers,
		authHeader: source.authHeader,
		models,
	};
}

function isStale(filePath: string, ttlSeconds: number): boolean {
	try {
		const stat = fs.statSync(filePath);
		const ageMs = Date.now() - stat.mtimeMs;
		return ageMs > ttlSeconds * 1000;
	} catch {
		return true;
	}
}

async function fetchAndSave(url: string, saveTo: string): Promise<boolean> {
	try {
		const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
		if (!response.ok) return false;
		const text = await response.text();
		const parsed = JSON.parse(text);
		if (!parsed.providers || typeof parsed.providers !== "object") return false;
		fs.writeFileSync(saveTo, JSON.stringify(parsed, null, "\t") + "\n", "utf-8");
		return true;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	const providerStates = new Map<string, ProviderState>();
	const manuallyDisabled = new Set<string>();

	// Build model lookup from models.dev cache (lazy, rebuilt on reload/sync)
	function buildLookup(): ModelLookup {
		const cache = readModelsDevCache();
		if (!cache) return new Map();
		const config = readGlobalConfig();
		const priority = config.modelSourcePriority ?? DEFAULT_MODEL_SOURCE_PRIORITY;
		return buildModelLookup(cache, priority);
	}

	let modelLookup: ModelLookup = buildLookup();

	// -----------------------------------------------------------------------
	// Core: load all sources and register providers
	// -----------------------------------------------------------------------

	function loadAllSources(): LoadResult {
		const errors: string[] = [];
		const warnings: string[] = [];
		let loaded = 0;
		let skipped = 0;

		ensureSourcesDir();
		const files = listSourceFiles();

		for (const file of files) {
			const filePath = path.join(SOURCES_DIR, file);
			const result = readJsonFile<SourceFileContent>(filePath);

			if (result.error) {
				errors.push(`${file}: ${result.error}`);
				continue;
			}

			if (!result.data?.providers) {
				errors.push(`${file}: missing "providers" key`);
				continue;
			}

			for (const [providerName, providerSource] of Object.entries(result.data.providers)) {
				const config = toProviderConfig(providerSource, modelLookup);

				if (!config.models || config.models.length === 0) {
					warnings.push(`${file}/${providerName}: no models defined`);
				}
				if (config.models && config.models.length > 0 && !config.baseUrl) {
					warnings.push(`${file}/${providerName}: has models but no baseUrl`);
				}

				const enabled = !manuallyDisabled.has(providerName);

				providerStates.set(providerName, {
					sourceFile: file,
					config,
					enabled,
					rawModels: providerSource.models,
				});

				if (enabled) {
					pi.registerProvider(providerName, config);
					loaded++;
				} else {
					skipped++;
				}
			}
		}

		return { loaded, skipped, errors, warnings };
	}

	function reloadAll(): LoadResult {
		for (const [name, state] of providerStates) {
			if (state.enabled) {
				pi.unregisterProvider(name);
			}
		}
		providerStates.clear();
		modelLookup = buildLookup();
		return loadAllSources();
	}

	// -----------------------------------------------------------------------
	// Remote sync
	// -----------------------------------------------------------------------

	async function syncRemoteSources(): Promise<{ synced: number; failed: string[] }> {
		const remoteConfig = readRemoteConfig();
		const entries = Object.entries(remoteConfig);
		let synced = 0;
		const failed: string[] = [];

		// Also refresh models.dev cache on explicit sync
		void fetchAndCacheModelsDev().then((ok) => {
			if (ok) modelLookup = buildLookup();
		});

		for (const [filename, source] of entries) {
			const saveTo = path.join(SOURCES_DIR, filename);
			const ok = await fetchAndSave(source.url, saveTo);
			if (ok) {
				synced++;
			} else {
				failed.push(filename);
			}
		}

		return { synced, failed };
	}

	async function backgroundRefresh(
		notify?: (msg: string) => void,
		isIdle?: () => boolean,
	): Promise<void> {
		const globalConfig = readGlobalConfig();
		const modelsDevTtl = globalConfig.modelsDevTtl ?? MODELS_DEV_TTL;
		const cachePath = path.join(SOURCES_DIR, MODELS_DEV_CACHE_FILE);

		// Refresh models.dev cache in background if stale
		if (isStale(cachePath, modelsDevTtl)) {
			void fetchAndCacheModelsDev().then((ok) => {
				if (ok) modelLookup = buildLookup();
			});
		}

		const remoteConfig = readRemoteConfig();
		const refreshedFiles: string[] = [];
		const failedFiles: string[] = [];

		for (const [filename, source] of Object.entries(remoteConfig)) {
			const filePath = path.join(SOURCES_DIR, filename);
			const ttl = source.ttl ?? 3600;

			if (isStale(filePath, ttl)) {
				const ok = await fetchAndSave(source.url, filePath);
				if (ok) {
					refreshedFiles.push(filename);
				} else if (!fs.existsSync(filePath)) {
					failedFiles.push(filename);
				}
			}
		}

		if (failedFiles.length > 0) {
			notify?.(`fetch failed (no cache): ${failedFiles.join(", ")}`);
		}

		if (refreshedFiles.length === 0) return;

		if (isIdle && !isIdle()) {
			const checkInterval = setInterval(() => {
				if (isIdle()) {
					clearInterval(checkInterval);
					applyRefreshedFiles(refreshedFiles, notify);
				}
			}, 2000);
			setTimeout(() => clearInterval(checkInterval), 120000);
		} else {
			applyRefreshedFiles(refreshedFiles, notify);
		}
	}

	function applyRefreshedFiles(files: string[], notify?: (msg: string) => void): void {
		let updated = 0;

		for (const file of files) {
			const filePath = path.join(SOURCES_DIR, file);
			const result = readJsonFile<SourceFileContent>(filePath);

			if (result.error || !result.data?.providers) {
				notify?.(`${file}: skipped (${result.error ?? "missing providers key"})`);
				continue;
			}

			const newProviders = result.data.providers;

			for (const [name, state] of providerStates) {
				if (state.sourceFile === file && state.enabled) {
					pi.unregisterProvider(name);
					providerStates.delete(name);
				}
			}

			for (const [providerName, providerSource] of Object.entries(newProviders)) {
				const config = toProviderConfig(providerSource, modelLookup);
				const enabled = !manuallyDisabled.has(providerName);

				providerStates.set(providerName, { sourceFile: file, config, enabled, rawModels: providerSource.models });

				if (enabled) {
					pi.registerProvider(providerName, config);
					updated++;
				}
			}
		}

		if (updated > 0) {
			notify?.(`Updated ${updated} providers from ${files.join(", ")}`);
		}
	}

	// -----------------------------------------------------------------------
	// Startup
	// -----------------------------------------------------------------------

	const startupResult = loadAllSources();

	pi.on("session_start", async (_event, ctx) => {
		const parts: string[] = [];
		if (startupResult.loaded > 0 || startupResult.skipped > 0) {
			const counts = [`${startupResult.loaded} providers`];
			if (startupResult.skipped > 0) counts.push(`${startupResult.skipped} disabled`);
			parts.push(counts.join(", "));
		}
		if (startupResult.warnings.length > 0) {
			parts.push(startupResult.warnings.join("; "));
		}
		if (startupResult.errors.length > 0) {
			parts.push(startupResult.errors.join("; "));
		}

		if (parts.length > 0) {
			const severity = startupResult.errors.length > 0 ? "warning" : "info";
			ctx.ui.notify(`model-hub: ${parts.join(" | ")}`, severity);
		}

		await backgroundRefresh(
			(msg) => ctx.ui.notify(`model-hub: ${msg}`, "info"),
			() => ctx.isIdle(),
		);
	});

	// -----------------------------------------------------------------------
	// /hub command — overlay panel
	// -----------------------------------------------------------------------

	pi.registerCommand("hub", {
		description: "Manage model hub: sync, toggle, reload",
		async handler(_args, ctx) {
			if (!ctx.hasUI) {
				ctx.ui.notify("Model hub requires interactive mode", "warning");
				return;
			}

			const buildRows = (): HubProviderRow[] => {
				const remotes = readRemoteConfig();
				const rows: HubProviderRow[] = [];
				for (const [name, state] of providerStates) {
					rows.push({
						name,
						enabled: state.enabled,
						modelCount: state.config.models?.length ?? 0,
						sourceFile: state.sourceFile,
						isRemote: !!remotes[state.sourceFile],
						isStale: remotes[state.sourceFile]
							? isStale(path.join(SOURCES_DIR, state.sourceFile), remotes[state.sourceFile].ttl ?? 3600)
							: false,
					});
				}
				return rows;
			};

			const toggleProvider = (name: string): void => {
				const state = providerStates.get(name);
				if (!state) return;
				if (state.enabled) {
					pi.unregisterProvider(name);
					state.enabled = false;
					manuallyDisabled.add(name);
				} else {
					pi.registerProvider(name, state.config);
					state.enabled = true;
					manuallyDisabled.delete(name);
				}
			};

			const result = await ctx.ui.custom<HubPanelResult | undefined>(
				(tui, theme, _keybindings, done) =>
					new HubPanel(
						tui,
						theme,
						done,
						buildRows,
						toggleProvider,
						async () => {
							const syncResult = await syncRemoteSources();
							const loadResult = reloadAll();
							return { ...syncResult, loaded: loadResult.loaded };
						},
						() => reloadAll(),
						(name: string) => providerStates.get(name)?.config,
						(name: string) => providerStates.get(name)?.rawModels,
						modelLookup,
					),
				{
					overlay: true,
					overlayOptions: {
						anchor: "bottom-left",
						width: "100%",
						maxHeight: "80%",
						margin: { bottom: 1 },
					},
				},
			);

			if (result?.message) {
				ctx.ui.notify(result.message, result.severity);
			}
		},
	});
}

// ---------------------------------------------------------------------------
// Overlay Panel Component
// ---------------------------------------------------------------------------

interface HubPanelResult {
	message: string;
	severity: "info" | "warning" | "error";
}

class HubPanel implements Component, Focusable {
	focused = false;

	private selected = 0;
	private listScroll = 0;
	private syncing = false;
	private statusText: string | undefined;
	private statusSeverity: "info" | "warning" = "info";
	private rows: HubProviderRow[];
	private fileCount: number;
	private remoteCount: number;

	/** When set, shows detail view for this provider */
	private detailProvider: string | undefined;
	private detailScroll = 0;

	constructor(
		private tui: TUI,
		private theme: Theme,
		private done: (result: HubPanelResult | undefined) => void,
		private buildRows: () => HubProviderRow[],
		private toggleProvider: (name: string) => void,
		private doSync: () => Promise<{ synced: number; failed: string[]; loaded: number }>,
		private doReload: () => { loaded: number; errors: string[] },
		private getProviderConfig: (name: string) => ProviderConfig | undefined,
		private getRawModels: (name: string) => SourceModelConfig[] | undefined,
		private modelLookupRef: ModelLookup,
	) {
		this.rows = buildRows();
		this.fileCount = listSourceFiles().length;
		this.remoteCount = Object.keys(readRemoteConfig()).length;
		this.clampSelection();
	}

	private clampSelection(): void {
		if (this.rows.length === 0) {
			this.selected = 0;
			this.listScroll = 0;
		} else if (this.selected >= this.rows.length) {
			this.selected = this.rows.length - 1;
		}
		this.listScroll = Math.max(0, Math.min(this.listScroll, Math.max(0, this.rows.length - 1)));
	}

	private refreshState(): void {
		this.rows = this.buildRows();
		this.fileCount = listSourceFiles().length;
		this.remoteCount = Object.keys(readRemoteConfig()).length;
		this.clampSelection();
	}

	invalidate(): void {
		// No cached rendering state
	}

	handleInput(data: string): void {
		if (this.syncing) return;

		// Detail view input handling
		if (this.detailProvider) {
			if (matchesKey(data, Key.escape) || data === "q" || matchesKey(data, Key.backspace)) {
				this.detailProvider = undefined;
				this.detailScroll = 0;
				this.tui.requestRender();
				return;
			}
			if (matchesKey(data, Key.up) || data === "k") {
				if (this.detailScroll > 0) {
					this.detailScroll--;
					this.tui.requestRender();
				}
				return;
			}
			if (matchesKey(data, Key.down) || data === "j") {
				this.detailScroll++;
				this.tui.requestRender();
				return;
			}
			return;
		}

		// List view input handling
		if (matchesKey(data, Key.escape) || data === "q") {
			this.done(undefined);
			return;
		}

		if (matchesKey(data, Key.up) || data === "k") {
			if (this.rows.length > 0) {
				this.selected = this.selected === 0 ? this.rows.length - 1 : this.selected - 1;
				this.tui.requestRender();
			}
			return;
		}

		if (matchesKey(data, Key.down) || data === "j") {
			if (this.rows.length > 0) {
				this.selected = this.selected === this.rows.length - 1 ? 0 : this.selected + 1;
				this.tui.requestRender();
			}
			return;
		}

		if (matchesKey(data, Key.enter)) {
			const row = this.rows[this.selected];
			if (row) {
				this.detailProvider = row.name;
				this.detailScroll = 0;
				this.tui.requestRender();
			}
			return;
		}

		if (matchesKey(data, " ")) {
			const row = this.rows[this.selected];
			if (row) {
				this.toggleProvider(row.name);
				this.refreshState();
				this.statusText = `${row.name}: ${row.enabled ? "disabled" : "enabled"}`;
				this.statusSeverity = "info";
				this.tui.requestRender();
			}
			return;
		}

		if (data === "s" && this.remoteCount > 0) {
			void this.execSync();
			return;
		}

		if (data === "r") {
			this.execReload();
			return;
		}
	}

	private async execSync(): Promise<void> {
		this.syncing = true;
		this.statusText = "Syncing remote sources...";
		this.tui.requestRender();

		const result = await this.doSync();
		this.syncing = false;
		this.refreshState();

		const parts: string[] = [`Synced ${result.synced}`];
		if (result.failed.length > 0) parts.push(`failed: ${result.failed.join(", ")}`);
		parts.push(`${result.loaded} active`);
		this.statusText = parts.join(" · ");
		this.statusSeverity = result.failed.length > 0 ? "warning" : "info";
		this.tui.requestRender();
	}

	private execReload(): void {
		const result = this.doReload();
		this.refreshState();

		if (result.errors.length > 0) {
			this.statusText = `Reloaded ${result.loaded}. Errors: ${result.errors.join("; ")}`;
			this.statusSeverity = "warning";
		} else {
			this.statusText = `Reloaded ${result.loaded} providers`;
			this.statusSeverity = "info";
		}
		this.tui.requestRender();
	}

	/** Pad or truncate a string to exactly `w` visible columns */
	private pad(text: string, w: number): string {
		const vw = visibleWidth(text);
		if (vw >= w) return truncateToWidth(text, w);
		return text + " ".repeat(w - vw);
	}

	/** Horizontal separator line */
	private separator(width: number): string {
		return this.theme.fg("border", "─".repeat(width));
	}

	render(width: number): string[] {
		const lines = this.detailProvider ? this.renderDetail(width) : this.renderList(width);
		return lines.map((line) => truncateToWidth(line, width));
	}

	private overlayRowBudget(): number {
		const termRows = this.tui.terminal?.rows ?? process.stdout.rows ?? 24;
		return Math.max(8, Math.floor(termRows * 0.8));
	}

	private visibleListRows(): number {
		const fixedRows = 6;
		return Math.max(1, Math.min(this.rows.length, this.overlayRowBudget() - fixedRows));
	}

	private clampListScroll(visibleRows: number): void {
		if (this.selected < this.listScroll) this.listScroll = this.selected;
		if (this.selected >= this.listScroll + visibleRows) this.listScroll = this.selected - visibleRows + 1;
		this.listScroll = Math.max(0, Math.min(this.listScroll, Math.max(0, this.rows.length - visibleRows)));
	}

	private renderDetail(width: number): string[] {
		const th = this.theme;
		const lines: string[] = [];
		const config = this.getProviderConfig(this.detailProvider!);
		const rawModels = this.getRawModels(this.detailProvider!) ?? [];
		const row = this.rows.find((r) => r.name === this.detailProvider);

		// Header
		lines.push(this.separator(width));
		const title = th.fg("accent", th.bold(` ${this.detailProvider}`));
		const status = row?.enabled ? th.fg("success", " ✓ enabled") : th.fg("muted", " ○ disabled");
		lines.push(title + status);

		if (row) {
			const meta: string[] = [];
			if (row.sourceFile) meta.push(`source: ${row.sourceFile}`);
			if (row.isRemote) meta.push(row.isStale ? "remote (stale)" : "remote");
			if (meta.length > 0) lines.push(th.fg("muted", `  ${meta.join(" · ")}`));
		}

		if (config?.baseUrl) {
			lines.push(th.fg("dim", `  baseUrl: ${config.baseUrl}`));
		}
		if (config?.api) {
			lines.push(th.fg("dim", `  api: ${config.api}`));
		}

		lines.push(this.separator(width));

		const userTag = th.fg("success", " [user]");

		if (!config?.models || config.models.length === 0) {
			lines.push(th.fg("muted", "  No models"));
		} else {
			const labelW = 14;

			for (let i = 0; i < config.models.length; i++) {
				const m = config.models[i]!;
				const raw = rawModels.find((r) => r.id === m.id);
				const ref = this.modelLookupRef.get(m.id);
				const autoTag = th.fg("warning", ` [${ref?.provider ?? "auto"}]`);

				const tag = (field: keyof SourceModelConfig): string => {
					if (!raw) return "";
					return raw[field] !== undefined ? userTag : autoTag;
				};

				const idx = th.fg("dim", `  [${i + 1}] `);
				lines.push(idx + th.fg("accent", m.id));
				if (m.name && m.name !== m.id) {
					lines.push(th.fg("dim", `  ${this.pad("name", labelW)}`) + th.fg("text", m.name) + tag("name"));
				}
				lines.push(th.fg("dim", `  ${this.pad("context", labelW)}`) + th.fg("text", `${(m.contextWindow ?? 0).toLocaleString()}`) + tag("contextWindow"));
				lines.push(th.fg("dim", `  ${this.pad("maxTokens", labelW)}`) + th.fg("text", `${(m.maxTokens ?? 0).toLocaleString()}`) + tag("maxTokens"));
				lines.push(th.fg("dim", `  ${this.pad("reasoning", labelW)}`) + th.fg("text", m.reasoning ? "yes" : "no") + tag("reasoning"));
				lines.push(th.fg("dim", `  ${this.pad("input", labelW)}`) + th.fg("text", (m.input ?? ["text"]).join(", ")) + tag("input"));
				if (m.cost) {
					const c = m.cost;
					const parts = [`in:$${c.input}`, `out:$${c.output}`];
					if (c.cacheRead) parts.push(`cR:$${c.cacheRead}`);
					if (c.cacheWrite) parts.push(`cW:$${c.cacheWrite}`);
					lines.push(th.fg("dim", `  ${this.pad("cost/1M", labelW)}`) + th.fg("text", parts.join("  ")) + tag("cost"));
				}
				if (i < config.models.length - 1) lines.push("");
			}
		}

		lines.push(this.separator(width));
		lines.push(th.fg("dim", " ") + userTag + th.fg("dim", " source  ") + th.fg("warning", "[provider]") + th.fg("dim", " models.dev"));
		lines.push(th.fg("dim", " esc/q back  ·  ↑↓ scroll"));

		// Apply scroll based on the overlay height budget.
		const viewportRows = this.overlayRowBudget();
		const maxScroll = Math.max(0, lines.length - viewportRows);
		this.detailScroll = Math.max(0, Math.min(this.detailScroll, maxScroll));
		return lines.slice(this.detailScroll, this.detailScroll + viewportRows);
	}

	private renderList(width: number): string[] {
		const th = this.theme;
		const lines: string[] = [];

		// Title
		lines.push(this.separator(width));
		const title = th.fg("accent", th.bold(" Model Hub"));
		const stats = th.fg("muted", `  ${this.fileCount} files · ${this.rows.length} providers · ${this.remoteCount} remote`);
		lines.push(title + stats);
		lines.push(this.separator(width));

		// Empty state
		if (this.rows.length === 0) {
			if (this.statusText) {
				const color = this.syncing ? "accent" : this.statusSeverity === "warning" ? "warning" : "success";
				lines.push(th.fg(color, ` ${this.statusText}`));
				lines.push("");
			}
			lines.push(th.fg("muted", " No providers — add JSON files to ~/.pi/agent/sources/"));
			lines.push(this.separator(width));
			lines.push(th.fg("dim", " r:reload  q:close"));
			return lines;
		}

		// Provider rows
		//   ▸ [✓] provider-name        3 models   source.json
		const srcW = 28;
		const modelW = 10;
		const fixedW = 3 + 4 + 2 + modelW + 2 + srcW + 2; // cursor+check+gaps+models+gap+source+remote
		const nameW = Math.max(12, width - fixedW);

		const visibleRows = this.visibleListRows();
		this.clampListScroll(visibleRows);
		if (this.listScroll > 0) {
			lines.push(th.fg("dim", `   … ${this.listScroll} previous`));
		}
		const visible = this.rows.slice(this.listScroll, this.listScroll + visibleRows);
		for (let visibleIndex = 0; visibleIndex < visible.length; visibleIndex++) {
			const i = this.listScroll + visibleIndex;
			const row = visible[visibleIndex]!;
			const sel = i === this.selected;

			const cursor = sel ? th.fg("accent", "▸") : " ";
			const check = row.enabled ? th.fg("success", "✓") : th.fg("muted", "○");
			const nameColor = sel ? "accent" : row.enabled ? "text" : "muted";

			const name = this.pad(th.fg(nameColor, truncateToWidth(row.name, nameW)), nameW);
			const models = th.fg("dim", this.pad(`${row.modelCount} models`, modelW));
			const srcDisplay = row.sourceFile.replace(/\.json$/, "");
			const src = th.fg("muted", this.pad(truncateToWidth(srcDisplay, srcW), srcW));
			const remote = row.isRemote
				? (row.isStale ? th.fg("warning", "⚠") : th.fg("dim", "·"))
				: " ";

			lines.push(` ${cursor} [${check}] ${name}  ${models}  ${src}${remote}`);
		}

		const remaining = this.rows.length - (this.listScroll + visibleRows);
		if (remaining > 0) {
			lines.push(th.fg("dim", `   … ${remaining} more`));
		}

		// Separator
		lines.push(this.separator(width));

		// Status line (feedback from sync/reload/toggle)
		if (this.statusText) {
			const color = this.syncing ? "accent" : this.statusSeverity === "warning" ? "warning" : "success";
			lines.push(th.fg(color, ` ${this.statusText}`));
		}

		// Keybinding hints
		const hints: string[] = ["↑↓ navigate", "enter detail", "space toggle"];
		if (this.remoteCount > 0) hints.push("s sync");
		hints.push("r reload", "q close");
		lines.push(th.fg("dim", ` ${hints.join("  ·  ")}`));

		return lines;
	}
}
