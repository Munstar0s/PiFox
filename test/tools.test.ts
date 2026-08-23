import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CamofoxClient } from "../src/client.ts";
import type { PifoxConfig } from "../src/config.ts";
import { ProcessManager } from "../src/process-manager.ts";
import { executeTool } from "../src/tools.ts";

const FIXTURE = new URL("./fixtures/fake-camofox.mjs", import.meta.url).pathname;

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("");
}

describe("executeTool against the fake camofox", () => {
	let config: PifoxConfig;
	let manager: ProcessManager;
	let ctx: Parameters<typeof executeTool>[2];
	const tempDirs: string[] = [];

	beforeEach(async () => {
		const port = await new Promise<number>((resolve, reject) => {
			const probe = createServer();
			probe.listen(0, "127.0.0.1", () => {
				const assigned = (probe.address() as { port: number }).port;
				probe.close(() => resolve(assigned));
			});
			probe.on("error", reject);
		});
		config = {
			port,
			baseUrl: `http://127.0.0.1:${port}`,
			idleShutdownMs: 600_000,
			keepAlive: false,
			userId: "pi",
			sessionKey: "default",
			accessKey: undefined,
			apiKey: undefined,
			camofoxEntry: FIXTURE,
			logFile: join(tmpdir(), `pifox-tools-${Date.now()}`, "camofox.log"),
		};
		tempDirs.push(config.logFile);
		manager = new ProcessManager(config, new CamofoxClient(config.baseUrl), { startTimeoutMs: 10_000 });
		ctx = { manager, client: new CamofoxClient(config.baseUrl, { apiKey: config.apiKey }), config };
	});

	afterEach(async () => {
		await manager.dispose();
		for (const file of tempDirs.splice(0)) rmSync(file.split("/camofox.log")[0], { recursive: true, force: true });
	});

	it("creates tabs and lists them", async () => {
		const created = await executeTool("camofox_create_tab", { url: "https://example.com" }, ctx);
		expect(JSON.stringify(created.content)).toContain("tabId");
		const listed = await executeTool("camofox_list_tabs", {}, ctx);
		expect(JSON.stringify(listed.content)).toContain("https://example.com");
	});

	it("forwards interaction calls with userId partitioning", async () => {
		await executeTool("camofox_create_tab", { url: "https://example.com" }, ctx);
		const listed = JSON.parse(
			(await executeTool("camofox_list_tabs", {}, ctx)).content
				.filter((b) => b.type === "text")
				.map((b) => b.text ?? "")
				.join(""),
		);
		const tabId = listed.tabs[0].tabId;
		const clicked = await executeTool("camofox_click", { tabId, ref: "e1" }, ctx);
		expect(textOf(clicked)).toContain('"ref": "e1"');
		expect(textOf(clicked)).toContain('"userId": "pi"');
	});

	it("splits snapshot screenshots into an image block", async () => {
		await executeTool("camofox_create_tab", { url: "https://example.com" }, ctx);
		const listed = JSON.parse(
			(await executeTool("camofox_list_tabs", {}, ctx)).content
				.filter((b) => b.type === "text")
				.map((b) => b.text ?? "")
				.join(""),
		);
		const result = await executeTool("camofox_snapshot", { tabId: listed.tabs[0].tabId }, ctx);
		expect(result.content).toHaveLength(2);
		expect(result.content[0].type).toBe("text");
		expect(result.content[1]).toMatchObject({ type: "image", mimeType: "image/png" });
		expect(textOf(result)).not.toContain("screenshot");
	});

	it("writes screenshots to savePath and returns image content", async () => {
		await executeTool("camofox_create_tab", { url: "https://example.com" }, ctx);
		const listed = JSON.parse(
			(await executeTool("camofox_list_tabs", {}, ctx)).content
				.filter((b) => b.type === "text")
				.map((b) => b.text ?? "")
				.join(""),
		);
		const savePath = join(tmpdir(), `pifox-shot-${Date.now()}.png`);
		try {
			const result = await executeTool("camofox_screenshot", { tabId: listed.tabs[0].tabId, savePath }, ctx);
			expect(result.content.some((block) => block.type === "image")).toBe(true);
			const bytes = readFileSync(savePath);
			expect(bytes.subarray(0, 4)).toEqual(Buffer.from("89504e47", "hex"));
		} finally {
			rmSync(savePath, { force: true });
		}
	});

	it("imports cookies from a Netscape file when an API key is configured", async () => {
		const keyedConfig = { ...config, apiKey: "cookie-secret" };
		const withKey: typeof ctx = {
			manager,
			client: new CamofoxClient(keyedConfig.baseUrl, { apiKey: keyedConfig.apiKey }),
			config: keyedConfig,
		};
		const dir = mkdtempSync(join(tmpdir(), "pifox-cookies-"));
		const cookiesPath = join(dir, "cookies.txt");
		writeFileSync(cookiesPath, ".example.com\tTRUE\t/\tTRUE\t123\tname\tvalue\n");
		try {
			const result = await executeTool("camofox_import_cookies", { cookiesPath }, withKey);
			expect(textOf(result)).toContain('"imported": 1');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("explains missing cookie configuration instead of failing opaquely", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pifox-cookies-"));
		const cookiesPath = join(dir, "cookies.txt");
		writeFileSync(cookiesPath, ".example.com\tTRUE\t/\tTRUE\t123\tname\tvalue\n");
		try {
			await expect(executeTool("camofox_import_cookies", { cookiesPath }, ctx)).rejects.toThrow(/PIFOX_API_KEY/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reports lifecycle status through pifox_status and stops via pifox_shutdown", async () => {
		await executeTool("camofox_create_tab", { url: "https://example.com" }, ctx);
		const status = JSON.parse(
			(await executeTool("pifox_status", {}, ctx)).content
				.filter((b) => b.type === "text")
				.map((b) => b.text ?? "")
				.join(""),
		);
		expect(status.serverState).toBe("running");
		expect(status.reachable).toBe(true);
		expect(status.pid).toBeGreaterThan(0);
		const shutdown = await executeTool("pifox_shutdown", {}, ctx);
		expect(textOf(shutdown)).toContain("stopped");
		expect(manager.currentState).toBe("stopped");
	});
});
