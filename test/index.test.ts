import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

// listSourceFiles reads ~/.pi/agent/sources, resolved at module load from os.homedir().
// Point HOME at a fixture home before importing the extension.
const fixtureHome = fs.mkdtempSync(path.join(os.tmpdir(), "model-hub-test-"));
const sourcesDir = path.join(fixtureHome, ".pi", "agent", "sources");
fs.mkdirSync(sourcesDir, { recursive: true });

const realHome = process.env.HOME;
process.env.HOME = fixtureHome;

const extension = await import("../src/index.ts");
const { describeThinkingLevels, deriveThinkingLevelMap, listSourceFiles } = extension;

after(() => {
	process.env.HOME = realHome;
	fs.rmSync(fixtureHome, { recursive: true, force: true });
});

describe("deriveThinkingLevelMap", () => {
	it("maps toggle + effort tiers, promoting xhigh to max", () => {
		assert.deepEqual(
			deriveThinkingLevelMap([{ type: "toggle" }, { type: "effort", values: ["low", "high", "max"] }]),
			{ minimal: null, low: "low", medium: null, high: "high", xhigh: "max", max: "max" },
		);
	});

	it("hides off when the model declares no toggle", () => {
		assert.deepEqual(deriveThinkingLevelMap([{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }]), {
			off: null,
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		});
	});

	it("nulls every tier the catalog does not declare", () => {
		assert.deepEqual(deriveThinkingLevelMap([{ type: "effort", values: ["high", "max"] }]), {
			off: null,
			minimal: null,
			low: null,
			medium: null,
			high: "high",
			xhigh: "max",
			max: "max",
		});
	});

	it("maps a \"none\" tier to off", () => {
		assert.deepEqual(deriveThinkingLevelMap([{ type: "effort", values: ["none", "minimal", "low", "medium", "high"] }]), {
			off: "none",
			minimal: "minimal",
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: null,
			max: null,
		});
	});

	it("ignores values that are not pi thinking levels", () => {
		assert.deepEqual(deriveThinkingLevelMap([{ type: "effort", values: ["low", "custom"] }]), {
			off: null,
			minimal: null,
			low: "low",
			medium: null,
			high: null,
			xhigh: null,
			max: null,
		});
	});

	it("returns undefined for budget_tokens models", () => {
		assert.equal(deriveThinkingLevelMap([{ type: "budget_tokens", min: 1024 }]), undefined);
		assert.equal(deriveThinkingLevelMap([{ type: "toggle" }, { type: "budget_tokens", min: 1024, max: 63999 } as never]), undefined);
	});

	it("returns undefined without usable effort tiers", () => {
		assert.equal(deriveThinkingLevelMap(undefined), undefined);
		assert.equal(deriveThinkingLevelMap([]), undefined);
		assert.equal(deriveThinkingLevelMap([{ type: "toggle" }]), undefined);
		assert.equal(deriveThinkingLevelMap([{ type: "effort" }]), undefined);
		assert.equal(deriveThinkingLevelMap([{ type: "effort", values: [] }]), undefined);
	});

	it("derives from the first effort option when several are declared", () => {
		assert.deepEqual(
			deriveThinkingLevelMap([{ type: "effort", values: ["low", "high", "max"] }, { type: "budget_tokens" }]),
			{ off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: "max", max: "max" },
		);
	});
});

describe("listSourceFiles", () => {
	const write = (name: string) => fs.writeFileSync(path.join(sourcesDir, name), "{}\n", "utf-8");

	before(() => {
		for (const name of fs.readdirSync(sourcesDir)) fs.rmSync(path.join(sourcesDir, name));
		write("ais.json");
		write("_remote.json");
		write("_config.json");
		write("_models-dev-cache.json");
		write("_model-name-footer.json");
		write("compass-openai.json.disable");
	});

	it("skips every _-prefixed file and non-json files", () => {
		assert.deepEqual(listSourceFiles(), ["ais.json"]);
	});

	it("returns an empty list when only metadata files remain", () => {
		fs.rmSync(path.join(sourcesDir, "ais.json"));
		assert.deepEqual(listSourceFiles(), []);
	});

	it("returns an empty list when the sources dir does not exist", () => {
		fs.rmSync(sourcesDir, { recursive: true });
		assert.deepEqual(listSourceFiles(), []);
		fs.mkdirSync(sourcesDir, { recursive: true });
	});
});

// --- end-to-end: source files + models.dev cache -> registered providers -------------------

const catalog = {
	anthropic: {
		models: {
			"claude-sonnet-5": {
				id: "claude-sonnet-5",
				name: "Claude Sonnet 5",
				reasoning: true,
				reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
				limit: { context: 200000, output: 64000 },
			},
			"claude-opus-5": {
				id: "claude-opus-5",
				name: "Claude Opus 5",
				reasoning: true,
				reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
			},
			"claude-haiku-4-5": {
				id: "claude-haiku-4-5",
				name: "Claude Haiku 4.5",
				reasoning: true,
				reasoning_options: [{ type: "budget_tokens", min: 1024 }],
			},
		},
	},
	// Lower priority than anthropic: must not win for the shared claude-sonnet-5 id.
	pioneer: {
		models: {
			"claude-sonnet-5": {
				id: "claude-sonnet-5",
				reasoning: true,
				reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
			},
		},
	},
	moonshotai: {
		models: {
			"kimi-k3": {
				id: "kimi-k3",
				reasoning: true,
				reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["low", "high", "max"] }],
			},
			"kimi-k3-mini": {
				id: "kimi-k3-mini",
				reasoning: true,
				reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["minimal", "low", "high"] }],
			},
		},
	},
	deepseek: {
		models: {
			"deepseek-v4-pro": {
				id: "deepseek-v4-pro",
				reasoning: true,
				reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["high", "max"] }],
			},
		},
	},
	zhipuai: {
		models: {
			"glm-5.3": {
				id: "glm-5.3",
				reasoning: true,
				reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
			},
		},
	},
	google: {
		models: {
			"gemini-3.8-flash": {
				id: "gemini-3.8-flash",
				reasoning: true,
				reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
			},
		},
	},
};

const sourceFile = {
	providers: {
		gateway: {
			baseUrl: "https://example.invalid/v1",
			api: "anthropic-messages",
			models: [
				{ id: "claude-sonnet-5" },
				{ id: "claude-opus-5" },
				{ id: "claude-haiku-4-5" },
				{ id: "kimi-k3", modelsDevProvider: "moonshotai" },
				{ id: "llm-gateway--deepseek-v4-pro", modelsDevId: "deepseek-v4-pro", modelsDevProvider: "deepseek" },
				{ id: "glm-5.3" },
				{ id: "claude-sonnet-5-user-map", modelsDevId: "claude-sonnet-5", thinkingLevelMap: { off: null, xhigh: "xhigh" } },
				{ id: "kimi-k3-mini", modelsDevProvider: "moonshotai" },
				{ id: "wrong-provider", modelsDevId: "claude-sonnet-5", modelsDevProvider: "nonexistent" },
				{ id: "model-not-in-catalog" },
			],
		},
		"gateway-openai": {
			baseUrl: "https://example.invalid/v1",
			api: "openai-completions",
			models: [{ id: "kimi-k3-mini", modelsDevProvider: "moonshotai" }],
		},
		google: {
			baseUrl: "https://example.invalid/v1",
			api: "google-generative-ai",
			models: [{ id: "gemini-3.8-flash" }, { id: "gemini-3.8-flash-user-map", modelsDevId: "gemini-3.8-flash", thinkingLevelMap: { max: "max" } }],
		},
	},
};

/** Run the extension against the fixture home and return the models it registered. */
type LoadedModel = { id: string; contextWindow?: number; thinkingLevelMap?: Record<string, string | null> };

function loadExtension(): { models: Map<string, LoadedModel>; start: () => Promise<string[]> } {
	const models = new Map<string, LoadedModel>();
	const notices: string[] = [];
	let sessionStart: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
	const pi = {
		registerProvider(name: string, config: { models?: LoadedModel[] }) {
			for (const model of config.models ?? []) models.set(`${name}/${model.id}`, model);
		},
		unregisterProvider() {},
		registerCommand() {},
		on(_event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) {
			sessionStart = handler;
		},
	};
	extension.default(pi as never);
	return {
		models,
		async start() {
			// The fixture cache was just written, so this reports load results without fetching.
			await sessionStart?.({}, { ui: { notify: (msg: string) => notices.push(msg) }, isIdle: () => true });
			return notices;
		},
	};
}

function loadModels(): Map<string, LoadedModel> {
	return loadExtension().models;
}

describe("models.dev enrichment", () => {
	let models: Map<string, LoadedModel>;
	const model = (id: string) => models.get(`gateway/${id}`);

	before(() => {
		for (const name of fs.readdirSync(sourcesDir)) fs.rmSync(path.join(sourcesDir, name));
		fs.writeFileSync(path.join(sourcesDir, "_models-dev-cache.json"), JSON.stringify(catalog), "utf-8");
		fs.writeFileSync(path.join(sourcesDir, "gateway.json"), JSON.stringify(sourceFile), "utf-8");
		models = loadModels();
	});

	it("keeps off available for toggle models", () => {
		assert.deepEqual(model("claude-sonnet-5")?.thinkingLevelMap, {
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		});
	});

	it("hides off when the catalog declares no toggle", () => {
		assert.deepEqual(model("claude-opus-5")?.thinkingLevelMap, {
			off: null,
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		});
		assert.deepEqual(model("glm-5.3")?.thinkingLevelMap, {
			off: null,
			minimal: null,
			low: "low",
			medium: null,
			high: "high",
			xhigh: "max",
			max: "max",
		});
	});

	it("derives through modelsDevProvider and modelsDevId aliases", () => {
		assert.deepEqual(model("kimi-k3")?.thinkingLevelMap, {
			minimal: null,
			low: "low",
			medium: null,
			high: "high",
			xhigh: "max",
			max: "max",
		});
		assert.deepEqual(model("llm-gateway--deepseek-v4-pro")?.thinkingLevelMap, {
			minimal: null,
			low: null,
			medium: null,
			high: "high",
			xhigh: "max",
			max: "max",
		});
	});

	it("downgrades minimal to low on anthropic-style efforts", () => {
		// anthropic's effort vocabulary has no minimal tier; pi itself sends "low" for it.
		assert.equal(model("kimi-k3-mini")?.thinkingLevelMap?.minimal, "low");
		assert.equal(models.get("gateway-openai/kimi-k3-mini")?.thinkingLevelMap?.minimal, "minimal");
	});

	it("leaves budget_tokens models on legacy budget thinking", () => {
		assert.equal(model("claude-haiku-4-5")?.thinkingLevelMap, undefined);
	});

	it("never merges into an explicit source map", () => {
		assert.deepEqual(model("claude-sonnet-5-user-map")?.thinkingLevelMap, { off: null, xhigh: "xhigh" });
	});

	it("skips models missing from the catalog", () => {
		assert.equal(model("model-not-in-catalog")?.thinkingLevelMap, undefined);
	});

	it("does not adopt a derived map on google APIs", () => {
		// pi's google path resolves off/minimal itself; the models.dev tiers would only hide them.
		assert.equal(models.get("google/gemini-3.8-flash")?.thinkingLevelMap, undefined);
		assert.deepEqual(models.get("google/gemini-3.8-flash-user-map")?.thinkingLevelMap, { max: "max" });
	});

	it("warns when an explicit modelsDevProvider has no such model", async () => {
		const loaded = loadExtension();
		const notices = await loaded.start();
		assert.equal(loaded.models.get("gateway/wrong-provider")?.contextWindow, 128000);
		assert.match(notices.join(" "), /gateway\/wrong-provider: claude-sonnet-5: models\.dev provider nonexistent not found/);
	});

	it("loads without a models.dev cache", () => {
		fs.rmSync(path.join(sourcesDir, "_models-dev-cache.json"));
		const without = loadModels();
		assert.equal(without.size, 13);
		assert.equal(without.get("gateway/claude-sonnet-5")?.thinkingLevelMap, undefined);
	});
});

describe("describeThinkingLevels", () => {
	it("renders levels in pi order and marks hidden ones", () => {
		const described = describeThinkingLevels({ id: "m" }, { minimal: null, low: "low", xhigh: "max", max: "max" });
		assert.deepEqual(described, { text: "minimal:—  low:low  xhigh:max  max:max", source: "models.dev" });
	});

	it("reports an explicit source map as user-owned", () => {
		const raw = { id: "m", thinkingLevelMap: { off: null, max: "max" } };
		assert.deepEqual(describeThinkingLevels(raw, raw.thinkingLevelMap), { text: "off:—  max:max", source: "user" });
	});

	it("renders no row without a map", () => {
		assert.equal(describeThinkingLevels({ id: "m" }, undefined), undefined);
		assert.equal(describeThinkingLevels({ id: "m" }, {}), undefined);
		assert.equal(describeThinkingLevels(undefined, { max: "max" }), undefined);
	});
});
