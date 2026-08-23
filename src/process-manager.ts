import { type ChildProcess, spawn } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import type { CamofoxClient } from "./client.ts";
import type { PifoxConfig } from "./config.ts";
import { spawnEnv } from "./config.ts";

export type ServerState = "stopped" | "starting" | "running" | "stopping";

export interface ServerStatus {
	state: ServerState;
	adopted: boolean;
	pid: number | undefined;
	startedAt: number | undefined;
	lastUsedAt: number | undefined;
	unexpectedExit: string | undefined;
	idleShutdownMs: number;
	keepAlive: boolean;
}

const SWEEP_INTERVAL_MS = 30_000;
const TERM_GRACE_MS = 10_000;
const KILL_GRACE_MS = 5_000;

export interface ProcessManagerOptions {
	/** Health-probe budget while waiting for a freshly spawned server. */
	startTimeoutMs?: number;
	/** Injectable clock for tests. */
	now?: () => number;
	sweepIntervalMs?: number;
	onEvent?: (event: string, detail?: Record<string, unknown>) => void;
}

/**
 * Owns the camofox server process lifecycle:
 * - lazy start on first use (spawn) or adoption of an already-running server,
 * - idle teardown of spawned servers only (adopted servers are left alone),
 * - SIGTERM → SIGKILL escalation, session-shutdown cleanup.
 */
export class ProcessManager {
	private readonly config: PifoxConfig;
	private readonly client: CamofoxClient;
	private readonly options: Required<Pick<ProcessManagerOptions, "startTimeoutMs">> & ProcessManagerOptions;
	private child: ChildProcess | undefined;
	private sweeper: NodeJS.Timeout | undefined;
	private state: ServerState = "stopped";
	private adopted = false;
	private startedAt: number | undefined;
	private lastUsedAt: number | undefined;
	private unexpectedExit: string | undefined;
	private starting: Promise<void> | undefined;

	constructor(config: PifoxConfig, client: CamofoxClient, options: ProcessManagerOptions = {}) {
		this.config = config;
		this.client = client;
		this.options = { startTimeoutMs: options.startTimeoutMs ?? 30_000, ...options };
	}

	get currentState(): ServerState {
		return this.state;
	}

	status(): ServerStatus {
		return {
			state: this.state,
			adopted: this.adopted,
			pid: this.child?.pid,
			startedAt: this.startedAt,
			lastUsedAt: this.lastUsedAt,
			unexpectedExit: this.unexpectedExit,
			idleShutdownMs: this.config.idleShutdownMs,
			keepAlive: this.config.keepAlive,
		};
	}

	/** Record activity so the idle sweeper does not tear the server down. */
	touch(): void {
		this.lastUsedAt = this.now();
	}

	/**
	 * Ensure a healthy camofox server is reachable: adopt an existing one or
	 * spawn a managed instance. Serialized across concurrent callers.
	 */
	async ensureStarted(): Promise<void> {
		if (this.state === "running") {
			this.touch();
			return;
		}
		if (!this.starting) {
			this.starting = this.startInternal().finally(() => {
				this.starting = undefined;
			});
		}
		await this.starting;
		this.touch();
	}

	/** Stop the managed server (no-op when running was adopted or already stopped). */
	async stop(): Promise<void> {
		if (this.adopted || this.child === undefined) return this.teardownState();
		if (this.state === "stopping") return;
		const child = this.child;
		this.state = "stopping";
		this.emit("stopping", { pid: child.pid });
		const exited = new Promise<void>((resolve) => {
			child.once("exit", () => resolve());
		});
		if (child.exitCode === null && !child.signalCode) {
			try {
				child.kill("SIGTERM");
			} catch {
				// Already dead.
			}
		}
		await this.waitForExit(exited, TERM_GRACE_MS);
		if (child.exitCode === null && !child.signalCode) {
			try {
				child.kill("SIGKILL");
			} catch {
				// Already dead.
			}
			await this.waitForExit(exited, KILL_GRACE_MS);
		}
		this.clearSweeper();
		this.child = undefined;
		this.state = "stopped";
		this.startedAt = undefined;
		this.emit("stopped");
	}

	/** Stop everything and clear timers; used from session_shutdown. */
	async dispose(): Promise<void> {
		this.clearSweeper();
		await this.stop();
	}

	private now(): number {
		return this.options.now?.() ?? Date.now();
	}

	/** Indirect read so control-flow narrowing cannot hide callback mutations. */
	private getUnexpectedExit(): string | undefined {
		return this.unexpectedExit;
	}

	/**
	 * After our spawned child died (or errored), something else may have taken
	 * the port — prefer adoption over failure.
	 */
	private async adoptOrThrow(failure: string | undefined): Promise<void> {
		if (await this.client.isHealthy(1_000)) {
			this.child = undefined;
			this.adopted = true;
			this.state = "running";
			this.startedAt = this.now();
			this.lastUsedAt = this.startedAt;
			this.unexpectedExit = undefined;
			this.emit("adopted", { baseUrl: this.config.baseUrl });
			this.startSweeper();
			return;
		}
		this.state = "stopped";
		throw new Error(`camofox failed to start (${failure ?? "unknown cause"}); see ${this.config.logFile}`);
	}

	private emit(event: string, detail?: Record<string, unknown>): void {
		try {
			this.options.onEvent?.(event, detail);
		} catch {
			// Observer failures must not affect lifecycle state.
		}
	}

	private async startInternal(): Promise<void> {
		this.unexpectedExit = undefined;

		// 1. Adopt an already-running, healthy server on our port.
		if (await this.client.isHealthy()) {
			this.adopted = true;
			this.state = "running";
			this.startedAt = this.now();
			this.lastUsedAt = this.startedAt;
			this.emit("adopted", { baseUrl: this.config.baseUrl });
			this.startSweeper();
			return;
		}

		// 2. Spawn a managed instance bound to loopback.
		this.adopted = false;
		this.state = "starting";
		this.emit("spawning", { entry: this.config.camofoxEntry, port: this.config.port });
		let child: ChildProcess;
		try {
			child = spawn(process.execPath, [this.config.camofoxEntry], {
				env: spawnEnv(this.config),
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (error) {
			this.state = "stopped";
			throw error instanceof Error ? error : new Error(String(error));
		}
		this.child = child;
		child.stdout?.on("data", (chunk: Buffer) => void this.appendLog(chunk));
		child.stderr?.on("data", (chunk: Buffer) => void this.appendLog(chunk));
		child.once("error", (error) => {
			// Spawn failures (bad path, permissions) surface here, not via exit.
			if (this.child === child) {
				this.unexpectedExit = `spawn error: ${error.message}`;
				if (this.state === "starting") this.state = "stopped";
			}
		});
		child.once("exit", (code, signal) => {
			if (this.child === child && this.state !== "stopping" && this.state !== "stopped") {
				this.unexpectedExit = `code=${code ?? "null"} signal=${signal ?? "null"}`;
				this.emit("unexpected_exit", { code, signal });
				this.state = "stopped";
				this.startedAt = undefined;
				this.clearSweeper();
			}
		});

		const deadline = this.now() + this.options.startTimeoutMs;
		for (;;) {
			if (await this.client.isHealthy(1_000)) {
				this.state = "running";
				this.startedAt = this.now();
				this.lastUsedAt = this.startedAt;
				this.emit("started", { pid: child.pid });
				this.startSweeper();
				return;
			}
			const failure = this.getUnexpectedExit();
			if (
				((this.child?.exitCode ?? null) !== null || failure?.startsWith("spawn error") === true) &&
				this.state === "starting"
			) {
				await this.adoptOrThrow(failure);
				return;
			}
			if (this.state !== "starting") {
				// An async exit/error handler already resolved lifecycle state;
				// prefer adopting whatever became healthy on the port.
				await this.adoptOrThrow(failure);
				return;
			}
			if (this.now() > deadline) {
				this.unexpectedExit = "startup timeout";
				child.kill("SIGKILL");
				this.state = "stopped";
				throw new Error(
					`camofox did not become healthy within ${this.options.startTimeoutMs}ms; see ${this.config.logFile}`,
				);
			}
			await sleep(250);
		}
	}

	private async appendLog(chunk: Buffer): Promise<void> {
		try {
			await mkdir(this.logDir(), { recursive: true });
			await appendFile(this.config.logFile, chunk);
		} catch {
			// Logging failures must never affect lifecycle state.
		}
	}

	private logDir(): string {
		const separator = Math.max(this.config.logFile.lastIndexOf("/"), this.config.logFile.lastIndexOf("\\"));
		return separator === -1 ? "." : this.config.logFile.slice(0, separator);
	}

	private startSweeper(): void {
		if (this.sweeper || this.config.keepAlive || this.adopted) return;
		this.sweeper = setInterval(() => {
			if (this.state !== "running") return;
			const idleFor = this.now() - (this.lastUsedAt ?? this.now());
			if (idleFor >= this.config.idleShutdownMs) {
				this.emit("idle_shutdown", { idleForMs: idleFor });
				void this.stop().catch(() => {});
			}
		}, this.options.sweepIntervalMs ?? SWEEP_INTERVAL_MS);
		this.sweeper.unref();
	}

	private clearSweeper(): void {
		if (this.sweeper) {
			clearInterval(this.sweeper);
			this.sweeper = undefined;
		}
	}

	private teardownState(): void {
		this.clearSweeper();
		this.child = undefined;
		this.state = "stopped";
		this.startedAt = undefined;
	}

	private async waitForExit(exited: Promise<void>, graceMs: number): Promise<void> {
		let timer: NodeJS.Timeout | undefined;
		const timeout = new Promise<"timeout">((resolve) => {
			timer = setTimeout(() => resolve("timeout"), graceMs);
			timer.unref();
		});
		try {
			await Promise.race([exited, timeout]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
