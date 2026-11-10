import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";

export const SEGMENT_ID = "seg_1";
export const TOPIC_ID = "top_1";
export const API_KEY = "re_test_key_123";

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export { json };

export interface Env {
	host: PluginRuntimeTestHost;
	entryId: string;
}

/** Host with Resend configured and one published-ready collection of entries. */
export async function createEnv(
	options: { settings?: Record<string, unknown>; urlPattern?: string | null } = {},
): Promise<PluginRuntimeTestHost> {
	process.env.EMDASH_ENCRYPTION_KEY ??= "emdash_enc_v1_QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU";
	const host = await createPluginRuntimeTestHost({ site: { name: "Test", url: "https://example.com" } });
	await host.fixtures.collection({
		slug: "posts",
		label: "Posts",
		supports: ["drafts"],
		routable: true,
		...(options.urlPattern === null ? {} : { urlPattern: options.urlPattern ?? "/posts/{slug}" }),
		fields: [
			{ slug: "title", label: "Title", type: "string" },
			{ slug: "excerpt", label: "Excerpt", type: "text" },
			{ slug: "content", label: "Content", type: "portableText" },
		],
	});
	const settings = {
		fromAddress: "News <news@example.com>",
		enabledCollections: ["posts"],
		...options.settings,
	};
	for (const [key, value] of Object.entries(settings)) await host.fixtures.plugin.setting(key, value);
	await host.actions.plugin.updateSettings({ apiKey: API_KEY });
	await host.http.respond(
		"https://api.resend.com/segments?limit=100",
		json({ data: [{ id: SEGMENT_ID, name: "Subscribers" }], has_more: false }),
	);
	await host.http.respond(
		"https://api.resend.com/topics?limit=100",
		json({ data: [{ id: TOPIC_ID, name: "Weekly" }], has_more: false }),
	);
	return host;
}

export const paragraph = (text: string) => ({
	_type: "block",
	_key: crypto.randomUUID(),
	style: "normal",
	children: [{ _type: "span", _key: crypto.randomUUID(), text, marks: [] }],
	markDefs: [],
});
