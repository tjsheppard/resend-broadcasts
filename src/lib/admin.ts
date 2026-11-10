import type { Block, BlockResponse } from "@emdash-cms/blocks";
import type { CollectionSchemaInfo, StorageCollection } from "emdash";
import type { PluginContext, SandboxedRouteContext } from "emdash/plugin";
import { content, schema } from "./ctx.js";
import { toEntry, FIELD_ROLES, resolveFieldMap, ROLE_LABELS, typesForRole } from "./fields.js";
import { ACCENT_OPTIONS, BASE_OPTIONS, isAccentColor, isBaseColor } from "./palette.js";
import { describeResendError } from "./resend.js";
import { renderSample } from "./sample.js";
import { clientFor, loadAudience, loadSettings } from "./settings.js";
import { getCollectionInfo, recordId, sendRecord } from "./state.js";
import type { AudienceLists, BroadcastRecord, FieldMap } from "./types.js";
import {
    banner,
    fmtTime,
    NONE_VALUE,
    OVERVIEW_PAGE,
    resendBroadcastUrl,
    SETTINGS_PAGE,
} from "./ui.js";

/** `Role.ADMIN` from @emdash-cms/auth. */
const ADMIN_ROLE = 50;

type Toast = NonNullable<BlockResponse["toast"]>;

interface AdminInput {
    type?: string;
    page?: string;
    action_id?: string;
    value?: unknown;
    values?: Record<string, unknown>;
}

const ok = (message: string): Toast => ({ message, type: "success" });
const fail = (message: string): Toast => ({ message, type: "error" });

function normalizePage(page: unknown): string | null {
    if (typeof page !== "string") return null;
    return page.startsWith("/") ? page : `/${page}`;
}

const MAPPING_ACTION = "save_mapping:";

export async function handleAdmin(
    routeCtx: SandboxedRouteContext,
    ctx: PluginContext,
): Promise<BlockResponse> {
    const input: AdminInput =
        routeCtx.input && typeof routeCtx.input === "object" ? (routeCtx.input as AdminInput) : {};
    const isAdmin = (routeCtx.user?.role ?? 0) >= ADMIN_ROLE;

    let page = normalizePage(input.page);
    if (!page) {
        const onSettings =
            input.action_id === "save_settings" ||
            input.action_id === "save_appearance" ||
            input.action_id === "send_preview" ||
            input.action_id === "reload" ||
            input.action_id === "reset_data" ||
            input.action_id?.startsWith(MAPPING_ACTION);
        page = onSettings ? SETTINGS_PAGE : OVERVIEW_PAGE;
    }

    let toast: Toast | undefined;
    let forceReload = false;
    let sentCursor: string | undefined;

    if (input.type === "form_submit" && input.action_id === "save_settings") {
        toast = isAdmin
            ? await saveSettings(ctx, input.values ?? {})
            : fail("Only administrators can change these settings.");
    } else if (input.type === "form_submit" && input.action_id === "save_appearance") {
        toast = isAdmin
            ? await saveAppearance(ctx, input.values ?? {})
            : fail("Only administrators can change these settings.");
    } else if (input.type === "form_submit" && input.action_id === "send_preview") {
        toast = isAdmin
            ? await sendPreview(ctx, routeCtx.user?.email, input.values ?? {})
            : fail("Only administrators can send a preview email.");
    } else if (input.type === "form_submit" && input.action_id?.startsWith(MAPPING_ACTION)) {
        toast = isAdmin
            ? await saveMapping(ctx, input.action_id.slice(MAPPING_ACTION.length), input.values ?? {})
            : fail("Only administrators can change these settings.");
    } else if (input.type === "block_action") {
        if (input.action_id === "reload") forceReload = true;
        else if (input.action_id === "reset_data") {
            toast = isAdmin ? await resetData(ctx) : fail("Only administrators can reset the plugin data.");
        } else if (input.action_id === "retry" && typeof input.value === "string") {
            toast = await retry(ctx, input.value);
        } else if (input.action_id === "unlink" && typeof input.value === "string") {
            toast = isAdmin ? await unlink(ctx, input.value) : fail("Only administrators can unlink broadcasts.");
        } else if (input.action_id === "sent_page" && typeof input.value === "string") {
            sentCursor = input.value;
        }
    }

    const blocks =
        page === SETTINGS_PAGE
            ? await settingsPage(ctx, isAdmin, forceReload, routeCtx.user?.email)
            : await overviewPage(ctx, sentCursor);
    return toast ? { blocks, toast } : { blocks };
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^<>@\s]+@[^<>@\s]+$|^[^<>]+<[^<>@\s]+@[^<>@\s]+>$/;

function str(value: unknown, max = 300): string {
    return typeof value === "string" ? value.trim().slice(0, max) : "";
}

async function saveSettings(ctx: PluginContext, values: Record<string, unknown>): Promise<Toast> {
    const current = await loadSettings(ctx);
    const collections = (await schema(ctx).listCollections()).filter((c) => !c.hidden);
    const bySlug = new Map(collections.map((c) => [c.slug, c]));

    const from = str(values.from_address);
    const replyTo = str(values.reply_to);
    if (from && !EMAIL_RE.test(from)) return fail("The From address must be an email, or Name <email>.");
    if (replyTo && !EMAIL_RE.test(replyTo)) return fail("The reply-to address must be an email, or Name <email>.");

    let siteUrl = str(values.site_url, 500);
    if (siteUrl) {
        try {
            const parsed = new URL(siteUrl);
            if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("protocol");
            siteUrl = siteUrl.replace(/\/+$/, "");
        } catch {
            return fail("The site URL must be a full http(s) URL.");
        }
    }

    const enabled = Array.isArray(values.collections)
        ? values.collections.filter((v): v is string => typeof v === "string" && bySlug.has(v))
        : current.enabledCollections;

    // Segment and topic selects only exist once the API key works.
    let lists: AudienceLists | null = null;
    const typedKey = str(values.api_key, 500);
    const apiKey = typedKey || current.apiKey;
    if (values.segment !== undefined || values.topic !== undefined) {
        const client = apiKey ? clientFor(ctx, { ...current, apiKey }) : null;
        if (client) {
            try {
                lists = await loadAudience(ctx, client);
            } catch (error) {
                return fail(describeResendError(error));
            }
        }
    }

    let segmentId: string | null | undefined;
    if (lists && values.segment !== undefined) {
        const v = str(values.segment, 100);
        if (v === NONE_VALUE) segmentId = null;
        else if (lists.segments.some((s) => s.id === v)) segmentId = v;
        else return fail("That segment no longer exists.");
    }
    let topicId: string | null | undefined;
    if (lists && values.topic !== undefined) {
        const v = str(values.topic, 100);
        if (v === NONE_VALUE) topicId = null;
        else if (lists.topics.some((t) => t.id === v)) topicId = v;
        else return fail("That topic no longer exists.");
    }

    if (typedKey && typedKey !== current.apiKey) {
        await ctx.settings.set("apiKey", typedKey);
        await ctx.kv.delete("cache:audience");
    }
    await ctx.settings.set("enabledCollections", enabled);
    await ctx.settings.set("fromAddress", from);
    await ctx.settings.set("replyTo", replyTo);
    await ctx.settings.set("siteUrl", siteUrl);
    if (segmentId === null) await ctx.settings.delete("defaultSegmentId");
    else if (segmentId) await ctx.settings.set("defaultSegmentId", segmentId);
    if (topicId === null) await ctx.settings.delete("defaultTopicId");
    else if (topicId) await ctx.settings.set("defaultTopicId", topicId);

    return ok("Settings saved.");
}

async function saveAppearance(ctx: PluginContext, values: Record<string, unknown>): Promise<Toast> {
    const logoUrl = str(values.logo_url, 500);
    if (logoUrl && !/^https:\/\//i.test(logoUrl) && !/^\/(?!\/)/.test(logoUrl)) {
        return fail("The logo must be an https URL, or a path starting with a single /.");
    }

    const accentColor = str(values.accent_color, 20);
    const baseColor = str(values.base_color, 20);
    if (accentColor && !isAccentColor(accentColor)) return fail("Choose an accent colour from the list.");
    if (baseColor && !isBaseColor(baseColor)) return fail("Choose a base colour from the list.");

    await ctx.settings.set("logoUrl", logoUrl);
    await ctx.settings.set("senderAddress", str(values.sender_address, 500));
    if (accentColor) await ctx.settings.set("accentColor", accentColor);
    if (baseColor) await ctx.settings.set("baseColor", baseColor);
    await ctx.settings.set("footerText", str(values.footer_text, 500));
    if (typeof values.show_read_online === "boolean") {
        await ctx.settings.set("showReadOnline", values.show_read_online);
    }
    return ok("Appearance saved.");
}

const RECIPIENT_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

async function sendPreview(
    ctx: PluginContext,
    userEmail: string | undefined,
    values: Record<string, unknown>,
): Promise<Toast> {
    const settings = await loadSettings(ctx);
    const client = clientFor(ctx, settings);
    if (!client) return fail("Save a Resend API key first.");
    if (!settings.fromAddress) return fail("Set the From address and save first.");
    const to = str(values.preview_to, 254) || userEmail;
    if (!to) return fail("Your account has no email address. Enter one to send the preview to.");
    if (!RECIPIENT_RE.test(to)) return fail("Enter a valid email address.");

    const sample = renderSample(ctx, settings);
    try {
        await client.sendEmail({
            from: settings.fromAddress,
            to,
            subject: "[Preview] A sample email",
            html: sample.html,
            text: sample.text,
        });
        return ok(`Preview email sent to ${to}.`);
    } catch (error) {
        return fail(describeResendError(error));
    }
}

async function saveMapping(ctx: PluginContext, slug: string, values: Record<string, unknown>): Promise<Toast> {
    const collection = (await schema(ctx).listCollections()).find((c) => c.slug === slug && !c.hidden);
    if (!collection) return fail("That collection no longer exists.");

    const map: FieldMap = {};
    for (const role of FIELD_ROLES) {
        const raw = values[role];
        if (typeof raw !== "string") continue;
        if (raw === NONE_VALUE) map[role] = null;
        else if (collection.fields.some((f) => f.slug === raw)) map[role] = raw;
        else return fail(`"${raw}" is not a field of ${collection.label}.`);
    }

    const current = await loadSettings(ctx);
    await ctx.settings.set("fieldMaps", { ...current.fieldMaps, [slug]: map });
    return ok(`${collection.label} mapping saved.`);
}

function mappingCard(collection: CollectionSchemaInfo, map: FieldMap): Block {
    const fields = FIELD_ROLES.map((role) => {
        const allowed = typesForRole(role);
        const options = collection.fields
            .filter((f) => allowed.has(f.type) || f.slug === map[role])
            .map((f) => ({ label: `${f.label} (${f.slug})`, value: f.slug }));
        return {
            type: "select" as const,
            action_id: role,
            label: ROLE_LABELS[role],
            options: [{ label: "None", value: NONE_VALUE }, ...options],
            initial_value: map[role] ?? NONE_VALUE,
        };
    });
    return {
        type: "accordion",
        block_id: `mapping-card:${collection.slug}`,
        label: collection.label,
        default_open: true,
        blocks: [
            { type: "context", text: "Choose which field fills each part of the email." },
            {
                type: "form",
                block_id: `mapping:${collection.slug}`,
                fields,
                submit: { label: `Save ${collection.label} mapping`, action_id: `${MAPPING_ACTION}${collection.slug}` },
            },
        ],
    };
}

async function settingsPage(
    ctx: PluginContext,
    isAdmin: boolean,
    forceReload: boolean,
    userEmail: string | undefined,
): Promise<Block[]> {
    const blocks: Block[] = [{ type: "header", text: "Broadcast settings" }];
    if (!isAdmin) {
        blocks.push(banner("Only administrators can change these settings.", "default"));
        return blocks;
    }

    const settings = await loadSettings(ctx);
    const collections = (await schema(ctx).listCollections()).filter((c) => !c.hidden);
    const client = clientFor(ctx, settings);

    let lists: AudienceLists | null = null;
    if (client) {
        try {
            lists = await loadAudience(ctx, client, forceReload);
        } catch (error) {
            blocks.push(banner(describeResendError(error), "error", "Could not load segments and topics"));
        }
    }

    const fields: unknown[] = [
        {
            type: "secret_input",
            action_id: "api_key",
            label: "Resend API key",
            placeholder: "re_...",
            has_value: settings.apiKey !== null,
        },
    ];

    if (collections.length > 0) {
        fields.push({
            type: "checkbox",
            action_id: "collections",
            label: "Collections that can send broadcasts",
            options: collections.map((c) => ({ label: c.label, value: c.slug })),
            initial_value: settings.enabledCollections.filter((slug) => collections.some((c) => c.slug === slug)),
        });
    }

    if (lists) {
        const segmentOptions = [
            { label: "No default", value: NONE_VALUE },
            ...lists.segments.map((s) => ({ label: s.name, value: s.id })),
        ];
        const topicOptions = [
            { label: "No default", value: NONE_VALUE },
            ...lists.topics.map((t) => ({ label: t.name, value: t.id })),
        ];
        fields.push(
            {
                type: "select",
                action_id: "segment",
                label: "Default segment",
                options: segmentOptions,
                initial_value: segmentOptions.some((o) => o.value === settings.defaultSegmentId)
                    ? (settings.defaultSegmentId as string)
                    : NONE_VALUE,
            },
            {
                type: "select",
                action_id: "topic",
                label: "Default topic",
                options: topicOptions,
                initial_value: topicOptions.some((o) => o.value === settings.defaultTopicId)
                    ? (settings.defaultTopicId as string)
                    : NONE_VALUE,
            },
        );
    }

    fields.push(
        {
            type: "text_input",
            action_id: "from_address",
            label: "From address",
            placeholder: "Site Name <news@example.com>",
            initial_value: settings.fromAddress,
        },
        {
            type: "text_input",
            action_id: "reply_to",
            label: "Reply-to address (optional)",
            initial_value: settings.replyTo,
        },
        {
            type: "text_input",
            action_id: "site_url",
            label: "Site URL",
            placeholder: ctx.site.url || "https://example.com",
            initial_value: settings.siteUrl,
        },
    );

    const appearanceFields: Extract<Block, { type: "form" }>["fields"] = [
        {
            type: "text_input",
            action_id: "logo_url",
            label: "Logo (optional, PNG or JPG)",
            placeholder: "https://example.com/logo.png or /_emdash/api/media/file/…",
            initial_value: settings.logoUrl,
        },
        {
            type: "select",
            action_id: "base_color",
            label: "Base colour (backgrounds, text and borders)",
            options: BASE_OPTIONS,
            initial_value: settings.baseColor,
        },
        {
            type: "select",
            action_id: "accent_color",
            label: "Accent colour (links and button)",
            options: ACCENT_OPTIONS,
            initial_value: settings.accentColor,
        },
        {
            type: "text_input",
            action_id: "sender_address",
            label: "Sender postal address (shown in every email footer)",
            placeholder: "Company name\nStreet, City, Postcode, Country",
            multiline: true,
            initial_value: settings.senderAddress,
        },
        {
            type: "text_input",
            action_id: "footer_text",
            label: "Footer message (optional, replaces \"You are receiving this email because you subscribed\")",
            placeholder: "You are receiving this because you signed up at example.com.",
            multiline: true,
            initial_value: settings.footerText,
        },
        {
            type: "toggle",
            action_id: "show_read_online",
            label: "Show a \"Read this on the web\" link",
            initial_value: settings.showReadOnline,
        },
    ];

    const mappingCards: Block[] = [];
    for (const slug of settings.enabledCollections) {
        const collection = collections.find((c) => c.slug === slug);
        if (!collection) continue;
        mappingCards.push(mappingCard(collection, resolveFieldMap(collection, settings.fieldMaps[slug])));
    }

    if (!lists && !client) {
        blocks.push(banner("Save an API key first. Segments, topics and the default choices appear after that.", "default"));
    }
    if (settings.enabledCollections.length === 0 && collections.length > 0) {
        blocks.push(banner("Tick a collection and save to see its field mapping.", "default"));
    }

    blocks.push({
        type: "form",
        block_id: "settings",
        fields: fields as Extract<Block, { type: "form" }>["fields"],
        submit: { label: "Save settings", action_id: "save_settings" },
    });
    if (client) {
        blocks.push({
            type: "actions",
            elements: [
                { type: "button", action_id: "reload", label: "↻ Reload segments and topics", style: "secondary" },
            ],
        });
    }
    blocks.push(
        { type: "header", text: "Email appearance" },
        {
            type: "form",
            block_id: "appearance",
            fields: appearanceFields,
            submit: { label: "Save appearance", action_id: "save_appearance" },
        },
        {
            type: "context",
            text: "To see the result, save, then send yourself a preview. It uses a sample post and your saved settings.",
        },
        {
            type: "form",
            block_id: "preview",
            fields: [
                {
                    type: "text_input",
                    action_id: "preview_to",
                    label: "Send a preview email to",
                    placeholder: userEmail ?? "name@example.com",
                },
            ],
            submit: { label: "✉ Send preview email", action_id: "send_preview" },
        },
    );
    if (mappingCards.length > 0) {
        blocks.push({ type: "header", text: "Field mapping" }, ...mappingCards);
    }
    blocks.push(
        { type: "header", text: "Reset" },
        {
            type: "section",
            text: "Deletes the plugin's own data: the sent, scheduled and failed broadcast history, the saved segment, topic, subject and preview text choices, and cached lists. Your settings above and your entries are not touched.",
        },
        {
            type: "actions",
            elements: [
                {
                    type: "button",
                    action_id: "reset_data",
                    label: "Reset plugin data",
                    style: "danger",
                    confirm: {
                        title: "Reset all plugin data?",
                        text: "This forgets which entries have already been emailed, so an entry that was sent could be sent again. Scheduled broadcasts are cancelled. Broadcasts already in Resend are not affected.",
                        confirm: "Reset data",
                        deny: "Cancel",
                        style: "danger",
                    },
                },
            ],
        },
    );
    return blocks;
}

async function resetData(ctx: PluginContext): Promise<Toast> {
    const store = ctx.storage.broadcasts as StorageCollection<BroadcastRecord>;
    let removed = 0;
    for (; ;) {
        const page = await store.query({ limit: 100 });
        if (page.items.length === 0) break;
        removed += await store.deleteMany(page.items.map((item) => item.id));
    }
    for (const prefix of ["cache:", "state:"]) {
        for (const { key } of await ctx.kv.list(prefix)) await ctx.kv.delete(key);
    }
    return ok(`Plugin data reset. ${removed} broadcast ${removed === 1 ? "record" : "records"} removed.`);
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

async function retry(ctx: PluginContext, value: string): Promise<Toast> {
    const index = value.indexOf(":");
    if (index <= 0) return fail("Unknown entry.");
    const collectionSlug = value.slice(0, index);
    const entryId = value.slice(index + 1);

    const settings = await loadSettings(ctx);
    if (!settings.enabledCollections.includes(collectionSlug)) return fail("Broadcasts are not enabled for that collection.");
    const collection = await getCollectionInfo(ctx, collectionSlug);
    const entry = toEntry(await content(ctx).get(collectionSlug, entryId));
    if (!collection || !entry) return fail("The entry no longer exists.");
    if (entry.status !== "published") return fail("The entry is not published.");

    const result = await sendRecord(ctx, settings, collection, entry, { retry: true });
    return result.ok ? ok("Broadcast sent.") : fail(result.message);
}

async function unlink(ctx: PluginContext, id: string): Promise<Toast> {
    const store = ctx.storage.broadcasts as StorageCollection<BroadcastRecord>;
    const data = await store.get(id);
    if (!data || data.status !== "sent") return fail("That broadcast is no longer recorded as sent.");
    await store.delete(id);
    return ok(`Unlinked "${data.title || data.entryId}". It can be scheduled again.`);
}

function entryLink(collection: string, id: string, title: string) {
    return { type: "link", label: title || id, target: { kind: "content", collection, id } };
}

function statusRows(records: Array<{ id: string; data: BroadcastRecord }>, label: string) {
    return records.map(({ data }) => ({
        entry: entryLink(data.collection, data.entryId, data.title),
        status: label,
        segment: data.segmentName,
        topic: data.topicName ?? "",
        detail: data.status === "failed" || data.status === "lapsed" ? (data.error ?? "") : "",
        when: fmtTime(data.sendAfter ?? data.updatedAt),
        ...(data.status === "failed"
            ? {
                action: {
                    type: "button",
                    action_id: "retry",
                    label: "Retry",
                    style: "secondary",
                    value: recordId(data.collection, data.entryId),
                    confirm: {
                        title: "Retry sending?",
                        text: "Check the Resend dashboard first to be sure the earlier attempt did not go out.",
                        confirm: "Retry",
                        deny: "Cancel",
                        style: "danger",
                    },
                },
            }
            : {}),
    }));
}

const ATTENTION_COLUMNS = [
    { key: "entry", label: "Broadcast name", format: "element" as const },
    { key: "status", label: "Status", format: "badge" as const },
    { key: "segment", label: "Segment" },
    { key: "topic", label: "Topic" },
    { key: "detail", label: "Detail" },
    { key: "when", label: "When" },
    { key: "action", label: "", format: "element" as const },
];

async function overviewPage(ctx: PluginContext, sentCursor?: string): Promise<Block[]> {
    const settings = await loadSettings(ctx);
    const store = ctx.storage.broadcasts as StorageCollection<BroadcastRecord>;
    const blocks: Block[] = [{ type: "header", text: "Broadcasts" }];

    if (!settings.apiKey) {
        blocks.push(banner("Add a Resend API key on the Broadcast settings page to get started.", "alert"));
    }
    if (settings.enabledCollections.length === 0) {
        blocks.push(banner("No collections are enabled yet.", "default"));
    }

    const [lapsed, failed, approved, sent] = await Promise.all([
        store.query({ where: { status: "lapsed" }, orderBy: { updatedAt: "desc" }, limit: 100 }),
        store.query({ where: { status: "failed" }, orderBy: { updatedAt: "desc" }, limit: 100 }),
        store.query({ where: { status: "approved" }, orderBy: { updatedAt: "desc" }, limit: 100 }),
        store.query({ where: { status: "sent" }, orderBy: { updatedAt: "desc" }, limit: 25, cursor: sentCursor }),
    ]);

    // Scheduled entries that have no approval yet.
    const approvedIds = new Set(approved.items.map((r) => recordId(r.data.collection, r.data.entryId)));
    const unapproved: Array<Record<string, unknown>> = [];
    for (const slug of settings.enabledCollections) {
        const result = await content(ctx).list(slug, { where: { status: "scheduled" }, limit: 100 });
        for (const item of result.items) {
            if (approvedIds.has(recordId(slug, item.id))) continue;
            const title = settings.fieldMaps[slug]?.title;
            const raw = item.data[title ?? "title"];
            unapproved.push({
                entry: entryLink(slug, item.id, typeof raw === "string" ? raw : item.slug ?? item.id),
                status: "Not scheduled",
                detail: "Scheduled entries send nothing until a broadcast is scheduled for them.",
                when: fmtTime(item.scheduledAt),
            });
        }
    }

    const attention = [
        ...unapproved,
        ...statusRows(lapsed.items, "Lapsed"),
        ...statusRows(failed.items, "Failed"),
    ];
    blocks.push({ type: "header", text: "Needs attention" });
    blocks.push({
        type: "table",
        columns: ATTENTION_COLUMNS,
        rows: attention,
        page_action_id: "attention_page",
        empty_text: "Nothing needs attention.",
    });

    blocks.push({ type: "header", text: "Scheduled broadcasts" });
    blocks.push({
        type: "table",
        columns: ATTENTION_COLUMNS,
        rows: statusRows(approved.items, "Scheduled"),
        page_action_id: "approved_page",
        empty_text: "No approved emails are waiting.",
    });

    blocks.push({ type: "header", text: "Sent" });
    blocks.push({
        type: "table",
        columns: [
            { key: "entry", label: "Broadcast name", format: "element" },
            { key: "audience", label: "Segment" },
            { key: "topic", label: "Topic" },
            { key: "sent", label: "Sent" },
            { key: "broadcast", label: "Resend", format: "element" },
            { key: "unlink", label: "", format: "element" },
        ],
        rows: sent.items.map(({ data }) => ({
            entry: entryLink(data.collection, data.entryId, data.title),
            audience: data.segmentName,
            topic: data.topicName ?? "",
            sent: fmtTime(data.sentAt ?? data.updatedAt),
            ...(data.broadcastId
                ? {
                    broadcast: {
                        type: "link",
                        label: "Open",
                        target: { kind: "external", url: resendBroadcastUrl(data.broadcastId) },
                    },
                }
                : {}),
            unlink: {
                type: "button",
                action_id: "unlink",
                label: "Unlink",
                style: "secondary",
                value: recordId(data.collection, data.entryId),
                confirm: {
                    title: "Unlink this entry from its broadcast?",
                    text: "The entry will forget it was ever sent and can be scheduled and emailed again, so subscribers may receive it twice. The broadcast in Resend is not deleted or changed.",
                    confirm: "Unlink",
                    deny: "Cancel",
                    style: "danger",
                },
            },
        })),
        ...(sent.hasMore && sent.cursor ? { next_cursor: sent.cursor } : {}),
        page_action_id: "sent_page",
        empty_text: "No broadcasts have been sent yet.",
    });
    return blocks;
}
