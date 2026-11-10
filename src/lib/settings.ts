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
    // One list() call instead of a get per key keeps a page load well under the sandbox's 30 bridge calls.
    const [apiKey, all] = await Promise.all([ctx.settings.get<string>("apiKey"), ctx.settings.list()]);
    const stored = new Map(all.map((item) => [item.key, item.value]));
    const enabledCollections = stored.get("enabledCollections");
    const fieldMaps = stored.get("fieldMaps") as Record<string, FieldMap> | undefined;
    const defaultSegmentId = stored.get("defaultSegmentId") as string | undefined;
    const defaultTopicId = stored.get("defaultTopicId") as string | undefined;
    const fromAddress = stored.get("fromAddress") as string | undefined;
    const replyTo = stored.get("replyTo") as string | undefined;
    const logoUrl = stored.get("logoUrl") as string | undefined;
    const senderAddress = stored.get("senderAddress") as string | undefined;
    const accentColor = stored.get("accentColor");
    const baseColor = stored.get("baseColor");
    const footerText = stored.get("footerText") as string | undefined;
    const showReadOnline = stored.get("showReadOnline");
    return {
        apiKey: typeof apiKey === "string" && apiKey !== "" ? apiKey : null,
        enabledCollections: Array.isArray(enabledCollections) ? enabledCollections : [],
        fieldMaps: fieldMaps && typeof fieldMaps === "object" ? fieldMaps : {},
        defaultSegmentId: defaultSegmentId || null,
        defaultTopicId: defaultTopicId || null,
        fromAddress: fromAddress ?? "",
        replyTo: replyTo ?? "",
        logoUrl: logoUrl ?? "",
        senderAddress: senderAddress ?? "",
        accentColor: isAccentColor(accentColor) ? accentColor : DEFAULT_ACCENT,
        baseColor: isBaseColor(baseColor) ? baseColor : DEFAULT_BASE,
        footerText: footerText ?? "",
        showReadOnline: showReadOnline !== false,
    };
}

/** The base URL used for links and images: the site URL from EmDash's general settings. */
export function effectiveSiteUrl(ctx: PluginContext): string {
    return (ctx.site.url || "").replace(/\/+$/, "");
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
