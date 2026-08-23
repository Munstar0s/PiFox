import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pifoxExtension from "../src/index.ts";

/**
 * Loads the extension through pi's real extension pipeline (inline factory →
 * DefaultResourceLoader → AgentSession) and verifies all 13 tools register
 * and are executable through the agent tool path — no LLM involved.
 */

process.env.PIFOX_IDLE_SHUTDOWN_MS = "600000";

const FIXTURE = new URL("./fixtures/fake-camofox.mjs", import.meta.url).pathname;
const { spawn } = await import("node:child_process");

let port: number;
let fixtureChild: ReturnType<typeof spawn>;
let sessionTools: Array<{ name: string }>;
let executeToolCall: (
	name: string,
	args?: Record<string, unknown>,
) => Promise<{ content: Array<{ type: string; text?: string }> }>;

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const probe = createServer();
		probe.listen(0, "127.0.0.1", () => {
			const assigned = (probe.address() as AddressInfo).port;
			probe.close(() => resolve(assigned));
		});
		probe.on("error", reject);
	});
}

beforeAll(async () => {
	port = await freePort();
	// Point the extension's lazy config at the fixture server.
	process.env.PIFOX_PORT = String(port);
	process.env.PIFOX_CAMOFOX_ENTRY = FIXTURE;

	fixtureChild = spawn(process.execPath, [FIXTURE, String(port)], {
		env: { ...process.env, CAMOFOX_PORT: String(port) },
		stdio: "ignore",
	});

	try {
		const modelRuntime = await ModelRuntime.create();
		const loader = new DefaultResourceLoader({
			cwd: process.cwd(),
			agentDir: `${process.env.HOME ?? "."}/.pifox-test-agent`,
			extensionFactories: [{ name: "pifox", factory: pifoxExtension }],
		});
		await loader.reload();

		const { session } = await createAgentSession({
			sessionManager: SessionManager.inMemory(),
			modelRuntime,
			resourceLoader: loader,
			noTools: "builtin",
		});

		sessionTools = session.getAllTools().map((tool) => ({ name: tool.name }));

		// Execute one tool directly through the registered definition to prove
		// the full registration → schema validation → execution path works.
		const definition = session.getToolDefinition("camofox_list_tabs");
		if (!definition) throw new Error("camofox_list_tabs was not registered");
		executeToolCall = async (name, args = {}) => {
			const target = name === "camofox_list_tabs" ? definition : session.getToolDefinition(name);
			if (!target) throw new Error(`${name} was not registered`);
			const result = await target.execute("test-call", args, undefined, undefined, {} as never);
			return result as { content: Array<{ type: string; text?: string }> };
		};
	} catch (error) {
		fixtureChild.kill("SIGKILL");
		throw error;
	}
}, 30_000);

afterAll(() => {
	if (!fixtureChild.killed) fixtureChild.kill("SIGKILL");
});

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("");
}

describe("PiFox inside a real AgentSession", () => {
	it("registers all 13 camofox/pifox tools", () => {
		const names = sessionTools.map((tool) => tool.name);
		for (const expected of [
			"camofox_create_tab",
			"camofox_snapshot",
			"camofox_click",
			"camofox_type",
			"camofox_navigate",
			"camofox_scroll",
			"camofox_screenshot",
			"camofox_close_tab",
			"camofox_evaluate",
			"camofox_list_tabs",
			"camofox_import_cookies",
			"pifox_status",
			"pifox_shutdown",
		]) {
			expect(names).toContain(expected);
		}
	});

	it("executes a tool end-to-end through the agent tool path", async () => {
		const created = await executeToolCall("camofox_create_tab", { url: "https://example.com/harness" });
		expect(JSON.stringify(created.content)).toContain("tabId");
		const status = await executeToolCall("pifox_status");
		expect(textOf(status)).toContain("running");
		await executeToolCall("pifox_shutdown");
	}, 20_000);
});
