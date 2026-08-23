import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CamofoxClient } from "./client.ts";
import { loadConfig } from "./config.ts";
import { ProcessManager } from "./process-manager.ts";
import { registerTools, type ToolContext } from "./tools.ts";

/**
 * PiFox — Camofox anti-detection browser as native Pi tools.
 *
 * The camofox server is launched lazily on the first tool call, kept warm
 * while in use, and torn down after an idle timeout (or session shutdown) so
 * no browser resources are held while pi sits idle. An already-running
 * server on the configured port is adopted, never killed.
 */
export default function pifoxExtension(pi: ExtensionAPI): void {
	let context: ToolContext | undefined;

	const getContext = (): ToolContext => {
		if (!context) {
			const config = loadConfig();
			const client = new CamofoxClient(config.baseUrl, { accessKey: config.accessKey, apiKey: config.apiKey });
			const manager = new ProcessManager(config, client, {
				onEvent: (event, detail) => pi.events.emit("pifox:lifecycle", { event, ...detail }),
			});
			context = { manager, client, config };
		}
		return context;
	};

	registerTools(pi, getContext());

	pi.registerCommand("camofox", {
		description: "PiFox: show camofox status, or force start/stop (`/camofox status|start|stop`)",
		handler: async (args, ctx) => {
			const toolContext = getContext();
			const subcommand = (args ?? "").trim().toLowerCase() || "status";
			if (subcommand === "stop") {
				await toolContext.manager.stop();
				ctx.ui.notify("Camofox stopped.", "info");
				return;
			}
			if (subcommand === "start") {
				await toolContext.manager.ensureStarted();
				ctx.ui.notify("Camofox running.", "info");
				return;
			}
			await toolContext.manager.ensureStarted();
			const status = toolContext.manager.status();
			ctx.ui.notify(
				`Camofox ${status.state}${status.adopted ? " (adopted)" : ""} pid=${status.pid ?? "-"} port=${toolContext.config.port}`,
				"info",
			);
		},
	});

	pi.on("session_shutdown", async () => {
		if (!context) return;
		await context.manager.dispose();
	});
}
