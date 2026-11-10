import type { PluginContext } from "emdash/plugin";
import { http } from "./ctx.js";
import { DEFAULT_ACCENT, DEFAULT_BASE, isAccentColor, isBaseColor } from "./palette.js";
import { createResendClient, type ResendClient } from "./resend.js";
import type {
    AudienceLists,
    FieldMap,
    Selection,
    Settings,
} from "./types.js";

const AUDIENCE_TTL_MS = 10 * 60 * 1000;

export async function loadSettings(ctx: PluginContext): Promise<Settings> {
    const [
        apiKey,
        enabledCollections,
        fieldMaps,
        defaultSegmentId,
        defaultTopicId,
        fromAddress,
        replyTo,
        siteUrl,
        logoUrl,
        senderAddress,
        accentColor,
        baseColor,
        footerText,
        showReadOnline,
    ] = await Promise.all([
        ctx.settings.get<string>("apiKey"),
        ctx.settings.get<string[]>("enabledCollections"),
        ctx.settings.get<Record<string, FieldMap>>("fieldMaps"),
        ctx.settings.get<string>("defaultSegmentId"),
        ctx.settings.get<string>("defaultTopicId"),
        ctx.settings.get<string>("fromAddress"),
        ctx.settings.get<string>("replyTo"),
        ctx.settings.get<string>("siteUrl"),
        ctx.settings.get<string>("logoUrl"),
        ctx.settings.get<string>("senderAddress"),
        ctx.settings.get<string>("accentColor"),
        ctx.settings.get<string>("baseColor"),
        ctx.settings.get<string>("footerText"),
        ctx.settings.get<boolean>("showReadOnline"),
    ]);
    return {
        apiKey: typeof apiKey === "string" && apiKey !== "" ? apiKey : null,
        enabledCollections: Array.isArray(enabledCollections) ? enabledCollections : [],
        fieldMaps: fieldMaps && typeof fieldMaps === "object" ? fieldMaps : {},
        defaultSegmentId: defaultSegmentId || null,
        defaultTopicId: defaultTopicId || null,
        fromAddress: fromAddress ?? "",
        replyTo: replyTo ?? "",
        siteUrl: siteUrl ?? "",
        logoUrl: logoUrl ?? "",
        senderAddress: senderAddress ?? "",
        accentColor: isAccentColor(accentColor) ? accentColor : DEFAULT_ACCENT,
        baseColor: isBaseColor(baseColor) ? baseColor : DEFAULT_BASE,
        footerText: footerText ?? "",
        showReadOnline: showReadOnline !== false,
    };
}

/** The base URL used for links and images: the configured one, else the site's own. */
export function effectiveSiteUrl(ctx: PluginContext, settings: Settings): string {
    return (settings.siteUrl || ctx.site.url || "").replace(/\/+$/, "");
}

export function clientFor(ctx: PluginContext, settings: Settings): ResendClient | null {
    return settings.apiKey ? createResendClient(http(ctx), settings.apiKey) : null;
}

/** Segments and topics, cached briefly so the panel does not hit Resend's 2 req/s limit on every load. */
export async function loadAudience(
    ctx: PluginContext,
    client: ResendClient,
    force = false,
): Promise<AudienceLists> {
    if (!force) {
        const cached = await ctx.kv.get<AudienceLists>("cache:audience");
        if (cached && Date.now() - cached.fetchedAt < AUDIENCE_TTL_MS) return cached;
    }
    const segments = await client.listSegments();
    const topics = await client.listTopics();
    const lists: AudienceLists = { segments, topics, fetchedAt: Date.now() };
    await ctx.kv.set("cache:audience", lists);
    return lists;
}

const selectionKey = (collection: string, id: string) => `state:selection:${collection}:${id}`;

export async function getSelection(
    ctx: PluginContext,
    collection: string,
    id: string,
): Promise<Selection> {
    return (await ctx.kv.get<Selection>(selectionKey(collection, id))) ?? {};
}

export async function saveSelection(
    ctx: PluginContext,
    collection: string,
    id: string,
    selection: Selection,
): Promise<void> {
    await ctx.kv.set(selectionKey(collection, id), selection);
}
