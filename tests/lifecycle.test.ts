import { afterEach, describe, expect, it } from "vitest";
import type { PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import type { BroadcastRecord } from "../src/lib/types";
import { API_KEY, createEnv, json, paragraph, SEGMENT_ID, TOPIC_ID } from "./helpers";

let host: PluginRuntimeTestHost;
afterEach(async () => {
	await host?.dispose();
});

const PANEL = "send-broadcast";
const SAVE = { subject: "Hello", preheader: "" };
const FUTURE = () => new Date(Date.now() + 3_600_000).toISOString();

async function createEntry(data: Record<string, unknown> = {}): Promise<string> {
	const created = await host.actions.content.create("posts", {
		data: { title: "Hello", content: [paragraph("Body text")], ...data },
	});
	if (!created.success) throw new Error(JSON.stringify(created.error));
	return created.data.item.id;
}

const record = (id: string) => host.inspect.storage.get<BroadcastRecord>("broadcasts", `posts:${id}`);
const broadcastRequests = () =>
	host.http.requests().filter((r) => r.method === "POST" && r.url === "https://api.resend.com/broadcasts");

async function savePanel(id: string) {
	await host.admin.actEditorPanel(PANEL, "posts", id, "segment", { value: SEGMENT_ID });
	await host.admin.submitEditorPanel(PANEL, "posts", id, "save", SAVE);
}

async function respondBroadcast(response = json({ id: "bc_1" })) {
	await host.http.respond("https://api.resend.com/broadcasts", response);
}

async function approveScheduled(id: string, at = FUTURE()) {
	const scheduled = await host.actions.content.schedule("posts", id, at);
	if (!scheduled.success) throw new Error(JSON.stringify(scheduled.error));
	await savePanel(id);
	await host.admin.actEditorPanel(PANEL, "posts", id, "approve");
	return at;
}

async function runScheduler(at: string) {
	host.scheduled.setTime(new Date(Date.parse(at) + 60_000));
	const result = await host.scheduled.run();
	await host.waitForDeferredTasks();
	return result;
}

describe("approval and sending", () => {
	it("sends the approved snapshot once when the scheduled entry publishes", async () => {
		host = await createEnv();
		await respondBroadcast();
		const id = await createEntry();
		const at = await approveScheduled(id);
		expect((await record(id))?.status).toBe("approved");
		expect(broadcastRequests().length).toBe(0);

		const result = await runScheduler(at);
		expect(result.published.length).toBe(1);

		const sent = await record(id);
		expect(sent?.status).toBe("sent");
		expect(sent?.broadcastId).toBe("bc_1");
		expect(sent?.html).toBe("");

		const requests = broadcastRequests();
		expect(requests.length).toBe(1);
		const body = JSON.parse(new TextDecoder().decode(requests[0].body));
		expect(body).toMatchObject({ segment_id: SEGMENT_ID, subject: "Hello", send: true });
		expect(body.html).toContain("Body text");
		expect(body.html).toContain("Read this on the web");
		expect(body.html).toMatch(/href="https:\/\/example\.com\/posts\/[^"]+"/);
		expect(body.html).toContain("{{{RESEND_UNSUBSCRIBE_URL}}}");
		expect(requests[0].headers.authorization ?? requests[0].headers.Authorization).toBe(`Bearer ${API_KEY}`);
	});

	it("does not send a second time when published again", async () => {
		host = await createEnv();
		await respondBroadcast();
		const id = await createEntry();
		await runScheduler(await approveScheduled(id));
		await host.actions.content.unpublish("posts", id);
		await host.actions.content.publish("posts", id);
		await host.waitForDeferredTasks();
		expect(broadcastRequests().length).toBe(1);
		expect((await record(id))?.status).toBe("sent");
	});

	it("sends nothing for a scheduled entry that was never approved", async () => {
		host = await createEnv();
		await respondBroadcast();
		const id = await createEntry();
		const at = FUTURE();
		await host.actions.content.schedule("posts", id, at);
		await runScheduler(at);
		expect(broadcastRequests().length).toBe(0);
		expect(await record(id)).toBeNull();
	});

	it("lapses the approval when the entry is edited, and sends nothing", async () => {
		host = await createEnv();
		await respondBroadcast();
		const id = await createEntry();
		const at = await approveScheduled(id);

		await host.actions.content.update("posts", id, { data: { content: [paragraph("Edited body")] } });
		await host.waitForDeferredTasks();
		expect((await record(id))?.status).toBe("lapsed");

		await runScheduler(at);
		expect(broadcastRequests().length).toBe(0);
	});

	it("deactivates on unschedule and revives when rescheduled unchanged", async () => {
		host = await createEnv();
		await respondBroadcast();
		const id = await createEntry();
		await approveScheduled(id);
		await host.actions.content.unschedule("posts", id);
		await host.waitForDeferredTasks();
		expect((await record(id))?.status).toBe("inactive");

		const at = FUTURE();
		await host.actions.content.schedule("posts", id, at);
		await host.waitForDeferredTasks();
		expect((await record(id))?.status).toBe("approved");
		await runScheduler(at);
		expect(broadcastRequests().length).toBe(1);
	});

	it("does not revive an approval if the entry changed while unscheduled", async () => {
		host = await createEnv();
		await respondBroadcast();
		const id = await createEntry();
		await approveScheduled(id);
		await host.actions.content.unschedule("posts", id);
		await host.actions.content.update("posts", id, { data: { content: [paragraph("Different")] } });
		const at = FUTURE();
		await host.actions.content.schedule("posts", id, at);
		await host.waitForDeferredTasks();
		await runScheduler(at);
		expect(broadcastRequests().length).toBe(0);
		expect((await record(id))?.status).not.toBe("sent");
	});

	it("removes an unsent approval when the entry is permanently deleted", async () => {
		host = await createEnv();
		const id = await createEntry();
		await approveScheduled(id);
		await host.actions.content.trash("posts", id);
		await host.actions.content.delete("posts", id);
		await host.waitForDeferredTasks();
		expect(await record(id)).toBeNull();
	});

	it("sends immediately for a published entry via the confirmed button, only once", async () => {
		host = await createEnv();
		await respondBroadcast();
		const id = await createEntry();
		await host.actions.content.publish("posts", id);
		await host.waitForDeferredTasks();
		expect(broadcastRequests().length).toBe(0);

		await savePanel(id);
		await host.admin.actEditorPanel(PANEL, "posts", id, "send_now");
		await host.admin.actEditorPanel(PANEL, "posts", id, "send_now");
		expect(broadcastRequests().length).toBe(1);
		expect((await record(id))?.status).toBe("sent");
	});

	it("records a failure, never retries automatically, and allows a manual retry", async () => {
		host = await createEnv();
		await respondBroadcast(json({ name: "validation_error", message: "bad from" }, 422));
		const id = await createEntry();
		const at = await approveScheduled(id);
		await runScheduler(at);

		const failed = await record(id);
		expect(failed?.status).toBe("failed");
		expect(failed?.error).toContain("bad from");
		expect(broadcastRequests().length).toBe(1);

		await respondBroadcast();
		await host.admin.actEditorPanel(PANEL, "posts", id, "retry");
		expect((await record(id))?.status).toBe("sent");
		expect(broadcastRequests().length).toBe(2);
	});

	it("refuses to approve when settings are incomplete", async () => {
		host = await createEnv({ settings: { fromAddress: "" } });
		const id = await createEntry();
		await host.actions.content.schedule("posts", id, FUTURE());
		await savePanel(id);
		const response = await host.admin.actEditorPanel(PANEL, "posts", id, "approve");
		expect(response.toast?.type).toBe("error");
		expect(await record(id)).toBeNull();
	});

	it("offers Schedule broadcast on a scheduled entry, or says what is missing", async () => {
		host = await createEnv();
		const id = await createEntry();
		await host.actions.content.schedule("posts", id, FUTURE());

		const missing = JSON.stringify(await host.admin.loadEditorPanel(PANEL, "posts", id));
		expect(missing).toContain("choose a segment above");
		expect(missing).not.toContain("Schedule broadcast\",\"style");

		await savePanel(id);
		const ready = JSON.stringify(await host.admin.loadEditorPanel(PANEL, "posts", id));
		expect(ready).toContain('"action_id":"approve"');
		expect(ready).toContain("Schedule broadcast");
	});

	it("links to EmDash's default /{collection}/{slug} when the collection has no URL pattern", async () => {
		host = await createEnv({ urlPattern: null });
		const id = await createEntry();
		await host.actions.content.schedule("posts", id, FUTURE());
		await savePanel(id);
		const panel = JSON.stringify(await host.admin.loadEditorPanel(PANEL, "posts", id));
		expect(panel).toContain('"action_id":"approve"');

		await host.http.respond("https://api.resend.com/emails", json({ id: "em_1" }));
		await host.admin.submitEditorPanel(PANEL, "posts", id, "test_email", { test_to: "someone@example.com" });
		const sent = host.http.requests().filter((r) => r.url === "https://api.resend.com/emails");
		expect(JSON.parse(new TextDecoder().decode(sent[0].body)).html).toContain("https://example.com/posts/");
	});

	it("sends a test email for a draft with no segment chosen", async () => {
		host = await createEnv();
		await host.http.respond("https://api.resend.com/emails", json({ id: "em_1" }));
		const id = await createEntry();
		const panel = await host.admin.loadEditorPanel(PANEL, "posts", id);
		expect(JSON.stringify(panel)).toContain("test_email");

		const response = await host.admin.submitEditorPanel(PANEL, "posts", id, "test_email", {
			test_to: "someone@example.com",
		});
		expect(response.toast?.type).toBe("success");
		const sent = host.http.requests().filter((r) => r.url === "https://api.resend.com/emails");
		expect(JSON.parse(new TextDecoder().decode(sent[0].body))).toMatchObject({ to: ["someone@example.com"] });
		expect(broadcastRequests().length).toBe(0);
	});

	it("adds the subject and preview text to the email body only when the toggle is on", async () => {
		host = await createEnv();
		const id = await createEntry();
		const sentHtml = async () => {
			await host.http.respond("https://api.resend.com/emails", json({ id: "em_1" }));
			await host.admin.submitEditorPanel(PANEL, "posts", id, "test_email", { test_to: "someone@example.com" });
			const sent = host.http.requests().filter((r) => r.url === "https://api.resend.com/emails");
			return JSON.parse(new TextDecoder().decode(sent[sent.length - 1].body)).html as string;
		};

		expect(await sentHtml()).not.toContain("<h1");

		await host.admin.submitEditorPanel(PANEL, "posts", id, "save", { subject: "Custom subject", preheader: "" });
		await host.admin.actEditorPanel(PANEL, "posts", id, "show_subject", { value: true });
		expect(JSON.stringify(await host.admin.loadEditorPanel(PANEL, "posts", id))).toContain("show_subject");
		expect(await sentHtml()).toMatch(/<h1[^>]*>Custom subject<\/h1>/);

		await host.admin.submitEditorPanel(PANEL, "posts", id, "save", { subject: "Custom subject", preheader: "" });
		expect(await sentHtml()).toMatch(/<h1[^>]*>Custom subject<\/h1>/);

		await host.admin.actEditorPanel(PANEL, "posts", id, "show_subject", { value: false });
		expect(await sentHtml()).not.toContain("<h1");
	});
});

describe("settings and gating", () => {
	it("stores the API key encrypted", async () => {
		host = await createEnv();
		const raw = await host.inspect.settings.raw("apiKey");
		expect(JSON.stringify(raw)).not.toContain(API_KEY);
	});

	it("does nothing for collections that are not enabled", async () => {
		host = await createEnv({ settings: { enabledCollections: [] } });
		await respondBroadcast();
		const id = await createEntry();
		const panel = await host.admin.loadEditorPanel(PANEL, "posts", id);
		expect(JSON.stringify(panel)).toContain("not enabled");
		await host.actions.content.publish("posts", id);
		await host.waitForDeferredTasks();
		expect(broadcastRequests().length).toBe(0);
	});

	it("asks for an API key when none is set", async () => {
		host = await createEnv();
		await host.actions.plugin.updateSettings({ apiKey: "" });
		const id = await createEntry();
		const panel = await host.admin.loadEditorPanel(PANEL, "posts", id);
		expect(JSON.stringify(panel)).toContain("API key");
	});
});

describe("admin pages", () => {
	it("renders the overview with approved entries", async () => {
		host = await createEnv();
		await respondBroadcast();
		const id = await createEntry();
		await approveScheduled(id);
		const page = await host.admin.loadPage("/overview");
		expect(page.blocks.length).toBeGreaterThan(0);
		expect(JSON.stringify(page)).toContain("Hello");
	});

	it("renders settings with a non-empty option list for every select", async () => {
		host = await createEnv();
		const page = await host.admin.loadPage("/settings");
		const text = JSON.stringify(page);
		expect(text).toContain("posts");
		const selects = [...text.matchAll(/"type":"select"[^}]*?"options":(\[.*?\])/g)];
		for (const match of selects) expect(JSON.parse(match[1]).length).toBeGreaterThan(0);
	});

	it("shows a mapping card per enabled collection and saves it", async () => {
		host = await createEnv();
		const page = await host.admin.loadPage("/settings");
		const card = page.blocks.find((b) => b.type === "accordion");
		expect(card).toMatchObject({ type: "accordion", label: "Posts" });
		const text = JSON.stringify(card);
		for (const label of ["Subject", "Preview text", "Body"]) expect(text).toContain(`"label":"${label}"`);
		expect(text).not.toContain("Image");

		const saved = await host.admin.submit("/settings", "save_mapping:posts", {
			title: "title",
			excerpt: "excerpt",
			body: "content",
		});
		expect(saved.toast?.type).toBe("success");
		expect(await host.inspect.setting("fieldMaps")).toEqual({
			posts: { title: "title", excerpt: "excerpt", body: "content" },
		});
	});

	it("saves the email appearance settings and rejects an unknown colour", async () => {
		host = await createEnv();
		const saved = await host.admin.submit("/settings", "save_appearance", {
			base_color: "stone",
			accent_color: "emerald",
			footer_text: "Custom footer",
			show_read_online: false,
		});
		expect(saved.toast?.type).toBe("success");
		expect(await host.inspect.setting("baseColor")).toBe("stone");
		expect(await host.inspect.setting("accentColor")).toBe("emerald");
		expect(await host.inspect.setting("footerText")).toBe("Custom footer");
		expect(await host.inspect.setting("showReadOnline")).toBe(false);

		const bad = await host.admin.submit("/settings", "save_appearance", { accent_color: "#fff" });
		expect(bad.toast?.type).toBe("error");
		expect(await host.inspect.setting("accentColor")).toBe("emerald");
	});

	it("groups the appearance fields under their own heading and form", async () => {
		host = await createEnv();
		const page = await host.admin.loadPage("/settings");
		const forms = page.blocks.filter((b) => b.type === "form");
		const appearance = JSON.stringify(forms.find((b) => b.block_id === "appearance"));
		for (const id of ["base_color", "accent_color", "logo_url", "sender_address", "footer_text", "show_read_online"]) {
			expect(appearance).toContain(`"action_id":"${id}"`);
		}
		expect(JSON.stringify(forms.find((b) => b.block_id === "settings"))).not.toContain("base_color");
		expect(JSON.stringify(page.blocks)).toContain("Email appearance");
	});

	it("sends a preview email rendered from the saved appearance settings", async () => {
		host = await createEnv();
		await host.http.respond("https://api.resend.com/emails", json({ id: "em_1" }));
		await host.admin.submit("/settings", "save_appearance", {
			base_color: "olive",
			accent_color: "fuchsia",
			footer_text: "Preview footer",
		});

		const sent = await host.admin.submit("/settings", "send_preview", { preview_to: "me@example.com" });
		expect(sent.toast?.type).toBe("success");
		const requests = host.http.requests().filter((r) => r.url === "https://api.resend.com/emails");
		expect(requests.length).toBe(1);
		const body = JSON.parse(new TextDecoder().decode(requests[0].body));
		expect(body.to).toEqual(["me@example.com"]);
		expect(body.subject).toContain("[Preview]");
		expect(body.html).toContain("Preview footer");
		expect(body.html).toContain("#c800de");

		const bad = await host.admin.submit("/settings", "send_preview", { preview_to: "nope" });
		expect(bad.toast?.type).toBe("error");
		expect(host.http.requests().filter((r) => r.url === "https://api.resend.com/emails").length).toBe(1);
	});

	it("resets broadcast history and saved choices but keeps settings", async () => {
		host = await createEnv();
		await respondBroadcast();
		const id = await createEntry();
		await approveScheduled(id);
		expect(await record(id)).not.toBeNull();

		await host.http.respond(
			"https://api.resend.com/segments?limit=100",
			json({ data: [{ id: SEGMENT_ID, name: "Subscribers" }], has_more: false }),
		);
		await host.http.respond(
			"https://api.resend.com/topics?limit=100",
			json({ data: [{ id: TOPIC_ID, name: "Weekly" }], has_more: false }),
		);
		const response = await host.admin.act("/settings", "reset_data");
		expect(response.toast?.type).toBe("success");
		expect(await record(id)).toBeNull();
		expect(await host.inspect.setting("fromAddress")).toBe("News <news@example.com>");
	});

	it("unlinks a sent entry so it can be scheduled again", async () => {
		host = await createEnv();
		await respondBroadcast();
		const id = await createEntry();
		await runScheduler(await approveScheduled(id));
		expect((await record(id))?.status).toBe("sent");

		const response = await host.admin.act("/overview", "unlink", { value: `posts:${id}` });
		expect(response.toast?.type).toBe("success");
		expect(await record(id)).toBeNull();
		expect(JSON.stringify(response.blocks)).toContain("No broadcasts have been sent yet.");
	});
});
