import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Runtime configuration for the PiFox extension (env-overridable). */
export interface PifoxConfig {
	port: number;
	baseUrl: string;
	idleShutdownMs: number;
	keepAlive: boolean;
	userId: string;
	/** Tab partition within the user session (camofox sessionKey). */
	sessionKey: string;
	accessKey: string | undefined;
	apiKey: string | undefined;
	/** Absolute path to the camofox-browser entry script to spawn. */
	camofoxEntry: string;
	/** Where spawned-server stdout/stderr is appended. */
	logFile: string;
}

type Env = Record<string, string | undefined>;

function positiveInt(raw: string | undefined, fallback: number): number {
	if (raw === undefined || raw === "") return fallback;
	const value = Number(raw);
	return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function truthy(raw: string | undefined): boolean {
	return raw === "1" || raw?.toLowerCase() === "true" || raw?.toLowerCase() === "yes";
}

/**
 * Resolve the camofox-browser entry script. Walks up from this module to the
 * package root and into its node_modules, so it works both in this repository
 * and when installed by pi under ~/.pi/agent/npm/<package>/.
 */
export function resolveCamofoxEntry(startDir: string, env: Env): string {
	const override = env.PIFOX_CAMOFOX_ENTRY;
	if (override) {
		const resolved = resolve(override);
		if (!existsSync(resolved)) throw new Error(`PIFOX_CAMOFOX_ENTRY does not exist: ${resolved}`);
		return resolved;
	}
	let dir = startDir;
	for (;;) {
		const candidate = join(dir, "node_modules", "@askjo", "camofox-browser", "bin", "camofox-browser.js");
		if (existsSync(candidate)) return candidate;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	throw new Error(
		"Cannot locate @askjo/camofox-browser. Run `npm install` inside the PiFox package directory, or set PIFOX_CAMOFOX_ENTRY.",
	);
}

export function loadConfig(env: Env = process.env): PifoxConfig {
	const port = positiveInt(env.PIFOX_PORT, 9377);
	const idleShutdownMs = positiveInt(env.PIFOX_IDLE_SHUTDOWN_MS, 600_000);
	const pifoxHome = env.PIFOX_HOME ?? join(homedir(), ".pifox");
	return {
		port,
		baseUrl: `http://127.0.0.1:${port}`,
		idleShutdownMs,
		keepAlive: truthy(env.PIFOX_KEEP_ALIVE),
		userId: env.PIFOX_USER_ID ?? "pi",
		sessionKey: env.PIFOX_SESSION_KEY ?? "default",
		accessKey: env.PIFOX_ACCESS_KEY,
		apiKey: env.PIFOX_API_KEY,
		camofoxEntry: resolveCamofoxEntry(dirname(fileURLToPath(import.meta.url)), env),
		logFile: join(pifoxHome, "camofox.log"),
	};
}

/** Spawn-time environment for the managed camofox server. */
export function spawnEnv(config: PifoxConfig, parentEnv: Env = process.env): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...parentEnv };
	env.CAMOFOX_PORT = String(config.port);
	env.CAMOFOX_BIND_HOST = "127.0.0.1";
	if (config.accessKey) env.CAMOFOX_ACCESS_KEY = config.accessKey;
	if (config.apiKey) env.CAMOFOX_API_KEY = config.apiKey;
	return env;
}
