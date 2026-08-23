import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { CamofoxClient } from "../../src/client.ts";
import { loadConfig } from "../../src/config.ts";
import { ProcessManager } from "../../src/process-manager.ts";
import { executeTool } from "../../src/tools.ts";

/**
 * REAL end-to-end against the actual @askjo/camofox-browser server.
 * First ever run downloads the Camoufox engine (~300MB) — guarded by
 * RUN_E2E=1. Run: RUN_E2E=1 npx vitest run test/e2e/
 */
const enabled = process.env.RUN_E2E === "1";

describe.skipIf(!enabled)("PiFox ↔ real camofox", () => {
	const config = loadConfig({
		...process.env,
		PIFOX_PORT: process.env.E2E_PORT ?? "9876",
		PIFOX_IDLE_SHUTDOWN_MS: "600000",
		PIFOX_HOME: mkdtempSync(join(tmpdir(), "pifox-e2e-")),
	});
	const client = new CamofoxClient(config.baseUrl, {
		accessKey: config.accessKey,
		apiKey: config.apiKey,
	});
	let manager: ProcessManager;

	beforeAll(() => {
		manager = new ProcessManager(config, client, { startTimeoutMs: 60_000 });
	}, 60_000);

	it("launches real camofox, browses example.com, snapshots, screenshots, stops", { timeout: 300_000 }, async () => {
		await manager.ensureStarted();
		expect(manager.currentState).toBe("running");

		const created = await executeTool(
			"camofox_create_tab",
			{ url: "https://example.com" },
			{ manager, client, config },
		);
		const createdPayload = JSON.parse(created.content[0].type === "text" ? created.content[0].text : "{}") as {
			tabId: string;
		};
		expect(createdPayload.tabId).toBeTruthy();

		const snapshot = await executeTool(
			"camofox_snapshot",
			{ tabId: createdPayload.tabId },
			{ manager, client, config },
		);
		const text = snapshot.content.find((block) => block.type === "text");
		expect(text && text.type === "text" && text.text).toContain("Example");
		expect(snapshot.content.some((block) => block.type === "image")).toBe(true);

		const savePath = join(config.logFile, "..", "shot.png");
		const shot = await executeTool("camofox_screenshot", { tabId: createdPayload.tabId }, { manager, client, config });
		expect(shot.content.some((block) => block.type === "image")).toBe(true);
		void savePath;

		const closed = await executeTool("camofox_close_tab", { tabId: createdPayload.tabId }, { manager, client, config });
		expect(closed.content.length).toBeGreaterThan(0);

		await manager.stop();
		expect(manager.currentState).toBe("stopped");
	});
});
