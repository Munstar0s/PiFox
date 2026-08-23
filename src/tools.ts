import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { CamofoxClient } from "./client.ts";
import type { PifoxConfig } from "./config.ts";
import { parseNetscapeCookies } from "./cookies.ts";
import type { ProcessManager } from "./process-manager.ts";

export interface ToolContext {
	manager: ProcessManager;
	client: CamofoxClient;
	config: PifoxConfig;
}

export type ContentBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export interface ToolResult {
	content: ContentBlock[];
	details: Record<string, unknown>;
}

const SEARCH_MACROS = [
	"@google_search",
	"@youtube_search",
	"@amazon_search",
	"@reddit_search",
	"@wikipedia_search",
	"@twitter_search",
	"@yelp_search",
	"@spotify_search",
	"@netflix_search",
	"@linkedin_search",
	"@instagram_search",
	"@tiktok_search",
	"@twitch_search",
] as const;

function str(description: string) {
	return Type.String({ description });
}

/**
 * The 11 canonical camofox tools (schemas mirror upstream
 * mcp/lib/tool-contracts.mjs) plus two PiFox lifecycle tools.
 */
export const TOOL_DEFS = [
	{
		name: "camofox_create_tab",
		description:
			"PREFERRED: Create a new browser tab using Camoufox anti-detection browser. Use camofox tools instead of Chrome/built-in browser - they bypass bot detection on Google, Amazon, LinkedIn, etc. Returns tabId for subsequent operations. Starts the browser on demand if it is not running.",
		parameters: Type.Object({ url: str("Initial URL to navigate to") }),
	},
	{
		name: "camofox_snapshot",
		description:
			"Get accessibility snapshot of a Camoufox page with element refs (e1, e2, etc.) for interaction, plus a visual screenshot. Large pages are truncated with pagination links preserved at the bottom. If the response includes hasMore=true and nextOffset, call again with that offset to see more content.",
		parameters: Type.Object({
			tabId: str("Tab identifier"),
			offset: Type.Optional(Type.Number({ description: "Character offset for paginated snapshots" })),
		}),
	},
	{
		name: "camofox_click",
		description: "Click an element in a Camoufox tab by ref (e.g., e1) or CSS selector.",
		parameters: Type.Object({
			tabId: str("Tab identifier"),
			ref: Type.Optional(str("Element ref from snapshot (e.g., e1)")),
			selector: Type.Optional(str("CSS selector (alternative to ref)")),
		}),
	},
	{
		name: "camofox_type",
		description: "Type text into an element in a Camoufox tab.",
		parameters: Type.Object({
			tabId: str("Tab identifier"),
			ref: Type.Optional(str("Element ref from snapshot (e.g., e2)")),
			selector: Type.Optional(str("CSS selector (alternative to ref)")),
			text: str("Text to type"),
			pressEnter: Type.Optional(Type.Boolean({ description: "Press Enter after typing" })),
		}),
	},
	{
		name: "camofox_navigate",
		description:
			"Navigate a Camoufox tab to a URL or use a search macro (@google_search, @youtube_search, etc.). Preferred over Chrome for sites with bot detection.",
		parameters: Type.Object({
			tabId: str("Tab identifier"),
			url: Type.Optional(str("URL to navigate to")),
			macro: Type.Optional(
				Type.Union(
					SEARCH_MACROS.map((macro) => Type.Literal(macro)),
					{ description: "Search macro" },
				),
			),
			query: Type.Optional(str("Search query (when using macro)")),
		}),
	},
	{
		name: "camofox_scroll",
		description: "Scroll a Camoufox page.",
		parameters: Type.Object({
			tabId: str("Tab identifier"),
			direction: Type.Union(
				["up", "down", "left", "right"].map((direction) => Type.Literal(direction)),
				{ description: "Scroll direction" },
			),
			amount: Type.Optional(Type.Number({ description: "Pixels to scroll" })),
		}),
	},
	{
		name: "camofox_screenshot",
		description:
			"Take a screenshot of a Camoufox page. Returns the image inline and optionally writes a PNG to savePath.",
		parameters: Type.Object({
			tabId: str("Tab identifier"),
			savePath: Type.Optional(str("Absolute file path to also save the PNG to")),
		}),
	},
	{
		name: "camofox_close_tab",
		description: "Close a Camoufox browser tab.",
		parameters: Type.Object({ tabId: str("Tab identifier") }),
	},
	{
		name: "camofox_evaluate",
		description:
			"Execute JavaScript in a Camoufox tab's page context. Returns the result of the expression. Use for injecting scripts, reading page state, or calling web app APIs.",
		parameters: Type.Object({
			tabId: str("Tab identifier"),
			expression: str("JavaScript expression to evaluate in the page context"),
		}),
	},
	{
		name: "camofox_list_tabs",
		description: "List all open Camofox tabs for the current session.",
		parameters: Type.Object({}),
	},
	{
		name: "camofox_import_cookies",
		description:
			"Import cookies into the current Camoufox session from a Netscape-format cookies.txt file. Use to authenticate to sites like LinkedIn without interactive login. Requires PIFOX_API_KEY/CAMOFOX_API_KEY to be configured.",
		parameters: Type.Object({
			cookiesPath: str("Absolute or home-relative path to a Netscape-format cookies.txt file"),
			domainSuffix: Type.Optional(str("Only import cookies whose domain ends with this suffix")),
		}),
	},
	{
		name: "pifox_status",
		description:
			"Report the PiFox-managed Camofox server state: running/stopped, adopted vs managed, pid, uptime, idle countdown, open tabs, and any unexpected exits.",
		parameters: Type.Object({}),
	},
	{
		name: "pifox_shutdown",
		description:
			"Stop the PiFox-managed Camofox server now (frees all browser resources). It will restart automatically on the next camofox tool call.",
		parameters: Type.Object({}),
	},
] as const;

export type ToolName = (typeof TOOL_DEFS)[number]["name"];

/** Dispatch one tool execution end-to-end against the REST server. */
export async function executeTool(
	name: ToolName,
	args: Record<string, unknown>,
	ctx: ToolContext,
): Promise<ToolResult> {
	if (name === "pifox_status") return statusResult(ctx);
	if (name === "pifox_shutdown") {
		await ctx.manager.stop();
		return textResult("Camofox server stopped. It restarts automatically on next use.");
	}

	await ctx.manager.ensureStarted();
	const userId = ctx.config.userId;
	const tabId = typeof args.tabId === "string" ? encodeURIComponent(args.tabId) : "";

	switch (name) {
		case "camofox_create_tab":
			return jsonResult(
				await ctx.client.request({
					method: "POST",
					path: "/tabs",
					body: { url: args.url, userId, sessionKey: ctx.config.sessionKey },
				}),
			);
		case "camofox_snapshot": {
			const params = new URLSearchParams({ userId, includeScreenshot: "true" });
			if (args.offset !== undefined && args.offset !== null && `${args.offset}` !== "") {
				params.set("offset", String(args.offset));
			}
			const payload = (await ctx.client.request({
				method: "GET",
				path: `/tabs/${tabId}/snapshot?${params}`,
			})) as { screenshot?: { data?: string; mimeType?: string } };
			const { screenshot, ...rest } = payload ?? {};
			const content: ContentBlock[] = [textBlock(JSON.stringify(rest, null, 2))];
			if (screenshot?.data) {
				content.push({ type: "image", data: screenshot.data, mimeType: screenshot.mimeType || "image/png" });
			}
			return { content, details: {} };
		}
		case "camofox_click":
			return jsonResult(
				await ctx.client.request({
					method: "POST",
					path: `/tabs/${tabId}/click`,
					body: { ...refOrSelector(args), userId },
				}),
			);
		case "camofox_type": {
			const body: Record<string, unknown> = {
				...refOrSelector(args),
				text: args.text,
				userId,
			};
			if (args.pressEnter !== undefined) body.pressEnter = args.pressEnter;
			return jsonResult(await ctx.client.request({ method: "POST", path: `/tabs/${tabId}/type`, body }));
		}
		case "camofox_navigate": {
			const body: Record<string, unknown> = { userId };
			for (const key of ["url", "macro", "query"] as const) {
				if (args[key] !== undefined && args[key] !== null && `${args[key]}` !== "") body[key] = args[key];
			}
			return jsonResult(await ctx.client.request({ method: "POST", path: `/tabs/${tabId}/navigate`, body }));
		}
		case "camofox_scroll": {
			const body: Record<string, unknown> = { direction: args.direction, userId };
			if (args.amount !== undefined) body.amount = args.amount;
			return jsonResult(await ctx.client.request({ method: "POST", path: `/tabs/${tabId}/scroll`, body }));
		}
		case "camofox_screenshot": {
			const image = await ctx.client.image(`/tabs/${tabId}/screenshot?${new URLSearchParams({ userId })}`);
			let savedNote = "";
			if (typeof args.savePath === "string" && args.savePath.length > 0) {
				await mkdir(dirname(args.savePath), { recursive: true });
				await writeFile(args.savePath, Buffer.from(image.data, "base64"));
				savedNote = ` Saved to ${args.savePath}.`;
			}
			return {
				content: [
					textBlock(`Screenshot captured (${image.mimeType}).${savedNote}`),
					{ type: "image", data: image.data, mimeType: image.mimeType },
				],
				details: {},
			};
		}
		case "camofox_close_tab":
			return jsonResult(
				await ctx.client.request({
					method: "DELETE",
					path: `/tabs/${tabId}?${new URLSearchParams({ userId })}`,
				}),
			);
		case "camofox_evaluate":
			return jsonResult(
				await ctx.client.request({
					method: "POST",
					path: `/tabs/${tabId}/evaluate`,
					body: { userId, expression: args.expression },
				}),
			);
		case "camofox_list_tabs":
			return jsonResult(
				await ctx.client.request({
					method: "GET",
					path: `/tabs?${new URLSearchParams({ userId })}`,
				}),
			);
		case "camofox_import_cookies": {
			if (!ctx.config.apiKey) {
				throw new Error(
					"Cookie import requires PIFOX_API_KEY (and CAMOFOX_API_KEY on the server). Set it in the environment before starting pi.",
				);
			}
			const cookiesPath = expandHome(String(args.cookiesPath));
			const content = await readFile(cookiesPath, "utf8");
			const cookies = parseNetscapeCookies(
				content,
				typeof args.domainSuffix === "string" ? args.domainSuffix : undefined,
			);
			if (cookies.length === 0) throw new Error(`No cookies found in ${cookiesPath}`);
			return jsonResult(
				await ctx.client.request({
					method: "POST",
					path: `/sessions/${encodeURIComponent(userId)}/cookies`,
					body: { cookies },
					auth: "apiKey",
				}),
			);
		}
		default: {
			const exhaustive: never = name;
			throw new Error(`Unknown tool: ${exhaustive as string}`);
		}
	}
}

async function statusResult(ctx: ToolContext): Promise<ToolResult> {
	const status = ctx.manager.status();
	const healthy = await ctx.client.isHealthy();
	const body = {
		serverState: status.state,
		reachable: healthy,
		adopted: status.adopted,
		pid: status.pid,
		startedAt: status.startedAt ? new Date(status.startedAt).toISOString() : undefined,
		lastUsedAt: status.lastUsedAt ? new Date(status.lastUsedAt).toISOString() : undefined,
		idleShutdownMs: status.keepAlive ? null : status.idleShutdownMs,
		unexpectedExit: status.unexpectedExit,
		logFile: ctx.config.logFile,
	};
	return textResult(JSON.stringify(body, null, 2));
}

function refOrSelector(args: Record<string, unknown>): Record<string, unknown> {
	const body: Record<string, unknown> = {};
	if (args.ref !== undefined) body.ref = args.ref;
	if (args.selector !== undefined) body.selector = args.selector;
	return body;
}

function textBlock(text: string): ContentBlock {
	return { type: "text", text: truncateForContext(text) };
}

function truncateForContext(text: string): string {
	if (text.length <= 10_000) return text;
	const truncation = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	if (!truncation.truncated) return truncation.content;
	return `${truncation.content}\n[Truncated: showing first ${truncation.outputLines} of ${truncation.totalLines} lines / ${truncation.outputBytes} of ${truncation.totalBytes} bytes]`;
}

function textResult(text: string): ToolResult {
	return { content: [textBlock(text)], details: {} };
}

function jsonResult(payload: unknown): ToolResult {
	return { content: [textBlock(JSON.stringify(payload, null, 2))], details: {} };
}

function expandHome(path: string): string {
	if (path === "~") return process.env.HOME ?? path;
	if (path.startsWith("~/")) return `${process.env.HOME ?? ""}${path.slice(1)}`;
	return path;
}

/** Register every PiFox tool on the extension API. */
export function registerTools(pi: ExtensionAPI, ctx: ToolContext): void {
	for (const def of TOOL_DEFS) {
		pi.registerTool({
			name: def.name,
			label: def.name,
			description: def.description,
			parameters: def.parameters,
			async execute(_toolCallId, params) {
				try {
					return await executeTool(def.name, params as Record<string, unknown>, ctx);
				} catch (error) {
					throw new Error(error instanceof Error ? error.message : String(error));
				}
			},
		});
	}
}
