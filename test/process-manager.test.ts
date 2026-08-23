import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CamofoxClient } from "../src/client.ts";
import type { PifoxConfig } from "../src/config.ts";
import { ProcessManager } from "../src/process-manager.ts";

const FIXTURE = new URL("./fixtures/fake-camofox.mjs", import.meta.url).pathname;

function makeConfig(port: number): PifoxConfig {
	const home = mkdtempSync(join(tmpdir(), "pifox-test-"));
	return {
		port,
		baseUrl: `http://127.0.0.1:${port}`,
		idleShutdownMs: 600_000,
		keepAlive: false,
		userId: "pi",
		sessionKey: "default",
		accessKey: undefined,
		apiKey: undefined,
		camofoxEntry: FIXTURE,
		logFile: join(home, "logs", "camofox.log"),
	};
}

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.listen(0, "127.0.0.1", () => {
			const port = (server.address() as AddressInfo).port;
			server.close(() => resolve(port));
		});
		server.on("error", reject);
	});
}

describe("ProcessManager", () => {
	let config: PifoxConfig;
	let manager: ProcessManager;
	let port: number;
	const events: string[] = [];
	const tempDirs: string[] = [];

	beforeEach(async () => {
		port = await freePort();
		config = makeConfig(port);
		tempDirs.push(config.logFile);
		events.length = 0;
		manager = new ProcessManager(config, new CamofoxClient(config.baseUrl), {
			startTimeoutMs: 10_000,
			sweepIntervalMs: 25,
			onEvent: (event) => events.push(event),
		});
	});

	afterEach(async () => {
		await manager.dispose();
		for (const dir of tempDirs.splice(0)) rmSync(dir.split("/camofox.log")[0], { recursive: true, force: true });
	});

	it("spawns the entry script and reaches running state with health verified", async () => {
		await manager.ensureStarted();
		expect(manager.currentState).toBe("running");
		expect(manager.status().adopted).toBe(false);
		expect(manager.status().pid).toBeGreaterThan(0);
		expect(events).toContain("started");
		expect(await new CamofoxClient(config.baseUrl).isHealthy()).toBe(true);
	});

	it("adopts an already-running healthy server and never kills it", async () => {
		const external: ChildProcess = spawn(process.execPath, [FIXTURE, String(port)]);
		try {
			const client = new CamofoxClient(config.baseUrl);
			const deadline = Date.now() + 5_000;
			while (!(await client.isHealthy(500)) && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			await manager.ensureStarted();
			expect(manager.status().adopted).toBe(true);
			expect(manager.status().pid).toBeUndefined();
			await manager.stop();
			expect(await client.isHealthy()).toBe(true);
		} finally {
			external.kill("SIGKILL");
		}
	});

	it("stops the managed server on explicit stop", async () => {
		await manager.ensureStarted();
		const pid = manager.status().pid;
		await manager.stop();
		expect(manager.currentState).toBe("stopped");
		expect(await new CamofoxClient(config.baseUrl).isHealthy(500)).toBe(false);
		void pid;
	});

	it("tears down an idle managed server via the sweeper", async () => {
		const idle = new ProcessManager({ ...config, idleShutdownMs: 40 }, new CamofoxClient(config.baseUrl), {
			startTimeoutMs: 10_000,
			sweepIntervalMs: 25,
			onEvent: (event) => events.push(event),
		});
		await idle.ensureStarted();
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(idle.currentState).toBe("stopped");
		expect(events).toContain("idle_shutdown");
	}, 15_000);

	it("keeps adopted servers despite idle time", async () => {
		const external: ChildProcess = spawn(process.execPath, [FIXTURE, String(port)]);
		try {
			const client = new CamofoxClient(config.baseUrl);
			const deadline = Date.now() + 5_000;
			while (!(await client.isHealthy(500)) && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			const idle = new ProcessManager({ ...config, idleShutdownMs: 40 }, client, {
				startTimeoutMs: 10_000,
				sweepIntervalMs: 25,
			});
			await idle.ensureStarted();
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(idle.currentState).toBe("running");
			await idle.dispose();
			expect(await client.isHealthy()).toBe(true);
			external.kill("SIGKILL");
		} catch (error) {
			external.kill("SIGKILL");
			throw error;
		}
	}, 15_000);

	it("reports unexpected exits and recovers on next use", async () => {
		const crashEntry = `${FIXTURE}`;
		const crashing = new ProcessManager({ ...config }, new CamofoxClient(config.baseUrl), {
			startTimeoutMs: 10_000,
			sweepIntervalMs: 3_600_000,
			onEvent: (event) => events.push(event),
		});
		// Spawn a variant that self-crashes after startup by using the same
		// fixture but killing it externally after health is observed.
		await crashing.ensureStarted();
		process.kill(crashing.status().pid as number, "SIGKILL");
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(crashing.currentState).toBe("stopped");
		expect(crashing.status().unexpectedExit).toBeTruthy();

		// Next ensureStarted transparently restarts.
		await crashing.ensureStarted();
		expect(crashing.currentState).toBe("running");
		await crashing.dispose();
		void crashEntry;
	}, 15_000);

	it("fails with a clear error when the entry never becomes healthy", async () => {
		const bad = new ProcessManager(
			{ ...config, camofoxEntry: "/nonexistent/entry.js" },
			new CamofoxClient(config.baseUrl),
			{ startTimeoutMs: 700 },
		);
		await expect(bad.ensureStarted()).rejects.toThrow(/failed to start|healthy|startup/i);
		expect(bad.currentState).toBe("stopped");
	});
});
