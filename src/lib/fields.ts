import type { CollectionSchemaInfo } from "emdash";
import type { EntryLike, FieldMap, FieldRole } from "./types.js";

export const FIELD_ROLES: FieldRole[] = ["title", "excerpt", "body"];

/** Shown in settings: title feeds the subject, excerpt feeds the inbox preview text and excerpt mode. */
export const ROLE_LABELS: Record<FieldRole, string> = {
    title: "Subject",
    excerpt: "Preview text",
    body: "Body",
};

type FieldInfo = CollectionSchemaInfo["fields"][number];

const TEXT_TYPES = new Set(["string", "text"]);

function firstMatch(fields: FieldInfo[], names: string[], types: Set<string>): string | null {
    for (const name of names) {
        const found = fields.find((f) => f.slug === name && types.has(f.type));
        if (found) return found.slug;
    }
    return null;
}

/** Field types that can fill each role. */
export function typesForRole(role: FieldRole): Set<string> {
    if (role === "body") return new Set(["portableText"]);
    return TEXT_TYPES;
}

/** Best-guess mapping from the collection's schema. Editors can override it in settings. */
export function detectFieldMap(collection: CollectionSchemaInfo): FieldMap {
    const fields = collection.fields;
    const titleField =
        collection.titleField && fields.some((f) => f.slug === collection.titleField)
            ? collection.titleField
            : firstMatch(fields, ["subject", "title", "name", "headline"], TEXT_TYPES);
    const body =
        firstMatch(fields, ["content", "body"], typesForRole("body")) ??
        fields.find((f) => f.type === "portableText")?.slug ??
        null;
    return {
        title: titleField,
        excerpt: firstMatch(
            fields,
            ["preview", "preview_text", "preheader", "excerpt", "summary", "description", "subtitle", "standfirst", "deck"],
            TEXT_TYPES,
        ),
        body,
    };
}

/** Stored overrides win; a stored `null` means "none". */
export function resolveFieldMap(collection: CollectionSchemaInfo, stored?: FieldMap): FieldMap {
    const detected = detectFieldMap(collection);
    const result: FieldMap = { ...detected };
    for (const role of FIELD_ROLES) {
        if (stored && role in stored && stored[role] !== undefined) result[role] = stored[role];
    }
    return result;
}

export interface EntryFields {
    title: string;
    excerpt: string;
    body: unknown;
}

function text(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

export function readEntry(entry: EntryLike, map: FieldMap): EntryFields {
    const get = (role: FieldRole) => (map[role] ? entry.data[map[role] as string] : undefined);
    return {
        title: text(get("title")),
        excerpt: text(get("excerpt")),
        body: get("body") ?? null,
    };
}

function stable(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (value && typeof value === "object") {
        const record = value as Record<string, unknown>;
        return `{${Object.keys(record)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${stable(record[key])}`)
            .join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
}

/** SHA-256 of everything that ends up in the email (except the editor's panel choices). */
export async function contentHash(entry: EntryLike, map: FieldMap): Promise<string> {
    const fields = readEntry(entry, map);
    const source = stable({ slug: entry.slug, ...fields });
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Accepts either `{id, slug, data: {...}}` or a flat hook payload. */
export function toEntry(content: unknown): EntryLike | null {
    if (!content || typeof content !== "object") return null;
    const record = content as Record<string, unknown>;
    if (typeof record.id !== "string") return null;
    const data =
        record.data && typeof record.data === "object" && !Array.isArray(record.data)
            ? (record.data as Record<string, unknown>)
            : record;
    const scheduled = record.scheduledAt ?? record.scheduled_at;
    return {
        id: record.id,
        slug: typeof record.slug === "string" ? record.slug : null,
        status: typeof record.status === "string" ? record.status : undefined,
        locale: typeof record.locale === "string" ? record.locale : null,
        scheduledAt: typeof scheduled === "string" ? scheduled : null,
        data,
    };
}
