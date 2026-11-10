import type { CollectionSchemaInfo } from "emdash";
import type { PluginContext } from "emdash/plugin";
import { contentHash, readEntry, resolveFieldMap, type EntryFields } from "./fields.js";
import { firstSentence, renderEmail, safeUrl, type RenderResult } from "./render.js";
import { effectiveSiteUrl, getSelection } from "./settings.js";
import type {
    AudienceLists,
    EntryLike,
    FieldMap,
    Selection,
    Settings,
} from "./types.js";

export interface ResolvedAudience {
    segmentId: string;
    segmentName: string;
    topicId?: string;
    topicName?: string;
}

export interface Prepared {
    collection: CollectionSchemaInfo;
    fieldMap: FieldMap;
    fields: EntryFields;
    hash: string;
    entryUrl: string | null;
    selection: Selection;
    subject: string;
    preheader: string;
    /** What is used when the editor leaves the field empty. */
    defaultSubject: string;
    defaultPreheader: string;
    audience: ResolvedAudience | null;
    render: RenderResult;
}

export async function resolveEntryUrl(
    ctx: PluginContext,
    collection: CollectionSchemaInfo,
    entry: EntryLike,
    siteUrl: string,
): Promise<string | null> {
    if (!siteUrl) return null;
    if (collection.routable && entry.slug) {
        // EmDash uses this pattern when the collection has none.
        const path = (collection.urlPattern || `/${encodeURIComponent(collection.slug)}/{slug}`)
            .replace(/\{slug\}/g, encodeURIComponent(entry.slug))
            .replace(/\{id\}/g, encodeURIComponent(entry.id))
            .replace(/\{locale\}/g, encodeURIComponent(entry.locale ?? ""));
        // Patterns with other tokens (dates) are left to EmDash, which only resolves published entries.
        if (!path.includes("{")) return safeUrl(path, siteUrl);
    }
    const contentApi = ctx.content;
    if (entry.status === "published" && contentApi?.getPublicUrl) {
        const url = await contentApi.getPublicUrl(collection.slug, entry.id);
        if (url) {
            try {
                const parsed = new URL(url, siteUrl);
                return safeUrl(`${parsed.pathname}${parsed.search}`, siteUrl);
            } catch {
                return null;
            }
        }
    }
    return null;
}

export function resolveAudience(
    settings: Settings,
    selection: Selection,
    lists: AudienceLists | null,
): ResolvedAudience | null {
    const segmentId = selection.segmentId ?? settings.defaultSegmentId;
    if (!segmentId) return null;
    const topicId =
        selection.topicId === undefined ? settings.defaultTopicId : selection.topicId || null;
    return {
        segmentId,
        segmentName: lists?.segments.find((s) => s.id === segmentId)?.name ?? segmentId,
        ...(topicId
            ? { topicId, topicName: lists?.topics.find((t) => t.id === topicId)?.name ?? topicId }
            : {}),
    };
}

/** Everything needed to preview, approve or send an entry, derived from its saved fields. */
export async function prepare(
    ctx: PluginContext,
    settings: Settings,
    collection: CollectionSchemaInfo,
    entry: EntryLike,
    lists: AudienceLists | null,
): Promise<Prepared> {
    const fieldMap = resolveFieldMap(collection, settings.fieldMaps[collection.slug]);
    const fields = readEntry(entry, fieldMap);
    const hash = await contentHash(entry, fieldMap);
    const siteUrl = effectiveSiteUrl(ctx, settings);
    const entryUrl = await resolveEntryUrl(ctx, collection, entry, siteUrl);
    const selection = await getSelection(ctx, collection.slug, entry.id);

    const defaultSubject = fields.title.trim();
    const defaultPreheader = firstSentence(fields.excerpt, 150).trim();
    const subject = selection.subject?.trim() || defaultSubject;
    const preheader = selection.preheader?.trim() || defaultPreheader;

    const render = renderEmail({
        subject,
        preheader,
        fields,
        entryUrl,
        siteUrl,
        siteName: ctx.site.name || "this site",
        logoUrl: safeUrl(settings.logoUrl, siteUrl),
        senderAddress: settings.senderAddress,
        accentColor: settings.accentColor,
        baseColor: settings.baseColor,
        footerText: settings.footerText,
        showReadOnline: settings.showReadOnline,
        showSubject: selection.showSubject === true,
    });

    return {
        collection,
        fieldMap,
        fields,
        hash,
        entryUrl,
        selection,
        subject,
        preheader,
        defaultSubject,
        defaultPreheader,
        audience: resolveAudience(settings, selection, lists),
        render,
    };
}
