import type { PluginContext, SandboxedPlugin } from "emdash/plugin";
import { handleAdmin } from "./lib/admin.js";
import { toEntry } from "./lib/fields.js";
import { handlePanel } from "./lib/panel.js";
import { loadSettings } from "./lib/settings.js";
import {
	deactivate,
	getCollectionInfo,
	getRecord,
	isSendable,
	lapseIfChanged,
	onScheduled,
	sendRecord,
} from "./lib/state.js";

/** Hooks must never throw into the content pipeline; failures are logged and recorded on the broadcast record. */
async function guard(ctx: PluginContext, hook: string, run: () => Promise<void>): Promise<void> {
	try {
		await run();
	} catch (error) {
		ctx.log.error(`${hook} failed`, { message: error instanceof Error ? error.message : String(error) });
	}
}

/**
 * Sandboxed plugin entry.
 *
 * Nothing is sent without an approval record whose content hash still matches
 * the entry when it publishes. See README.md for the full state machine.
 */
const plugin: SandboxedPlugin = {
	hooks: {
		"content:afterPublish": async (event, ctx) =>
			guard(ctx, "content:afterPublish", async () => {
				const entry = toEntry(event.content);
				if (!entry) return;
				const record = await getRecord(ctx, event.collection, entry.id);
				if (!record || !isSendable(record)) return;
				const settings = await loadSettings(ctx);
				if (!settings.enabledCollections.includes(event.collection)) return;
				const collection = await getCollectionInfo(ctx, event.collection);
				if (!collection) return;
				await sendRecord(ctx, settings, collection, entry);
			}),

		"content:afterSave": async (event, ctx) =>
			guard(ctx, "content:afterSave", async () => {
				if (event.isNew) return;
				const entry = toEntry(event.content);
				if (!entry) return;
				const record = await getRecord(ctx, event.collection, entry.id);
				if (!record || !isSendable(record)) return;
				const settings = await loadSettings(ctx);
				const collection = await getCollectionInfo(ctx, event.collection);
				if (!collection) return;
				await lapseIfChanged(ctx, settings, collection, entry);
			}),

		"content:afterSchedule": async (event, ctx) =>
			guard(ctx, "content:afterSchedule", async () => {
				const entry = toEntry(event.content);
				if (!entry) return;
				const record = await getRecord(ctx, event.collection, entry.id);
				if (!record) return;
				const settings = await loadSettings(ctx);
				const collection = await getCollectionInfo(ctx, event.collection);
				if (!collection) return;
				await onScheduled(ctx, settings, collection, entry, entry.scheduledAt ?? null);
			}),

		"content:afterUnschedule": async (event, ctx) =>
			guard(ctx, "content:afterUnschedule", async () => {
				const entry = toEntry(event.content);
				if (entry) await deactivate(ctx, event.collection, entry.id);
			}),

		"content:afterUnpublish": async (event, ctx) =>
			guard(ctx, "content:afterUnpublish", async () => {
				const entry = toEntry(event.content);
				if (entry) await deactivate(ctx, event.collection, entry.id);
			}),

		"content:afterDelete": async (event, ctx) =>
			guard(ctx, "content:afterDelete", async () => {
				await deactivate(ctx, event.collection, event.id, event.permanent);
			}),
	},

	routes: {
		// Block Kit pages: /overview and /settings. Settings writes are re-checked for admin role inside.
		admin: { permission: "content:publish_any", handler: handleAdmin },
		// Editor sidebar panel declared in emdash-plugin.jsonc.
		"editor/panel": { permission: "content:publish_any", handler: handlePanel },
	},
};

export default plugin;
