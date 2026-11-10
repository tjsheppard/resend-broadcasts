import type { PluginContext } from "emdash/plugin";
import type { EntryFields } from "./fields.js";
import { renderEmail, safeUrl, type RenderResult } from "./render.js";
import { effectiveSiteUrl } from "./settings.js";
import type { Settings } from "./types.js";

const block = (key: string, text: string, style = "normal") => ({
    _type: "block",
    _key: key,
    style,
    children: [{ _type: "span", text }],
});

const item = (key: string, text: string) => ({
    _type: "block",
    _key: key,
    style: "normal",
    listItem: "bullet",
    level: 1,
    children: [{ _type: "span", text }],
});

const SAMPLE_BODY = [
    {
        _type: "block",
        _key: "intro",
        style: "normal",
        markDefs: [{ _key: "l1", _type: "link", href: "https://example.com" }],
        children: [
            { _type: "span", text: "This is a sample post, so you can see how your emails look. It has " },
            { _type: "span", text: "bold text", marks: ["strong"] },
            { _type: "span", text: " and " },
            { _type: "span", text: "a link", marks: ["l1"] },
            { _type: "span", text: "." },
        ],
    },
    block("h", "A section heading", "h2"),
    block("p2", "Body copy uses your base colour for text and your accent colour for links."),
    item("i1", "First point"),
    item("i2", "Second point"),
    block("q", "A quote looks like this.", "blockquote"),
];

const SAMPLE_FIELDS: EntryFields = {
    title: "A sample email",
    excerpt: "A preview of your email design.",
    body: SAMPLE_BODY,
};

/** Renders a fixed sample post with the saved appearance settings. */
export function renderSample(ctx: PluginContext, settings: Settings): RenderResult {
    const siteUrl = effectiveSiteUrl(ctx, settings);
    return renderEmail({
        subject: SAMPLE_FIELDS.title,
        preheader: SAMPLE_FIELDS.excerpt,
        fields: SAMPLE_FIELDS,
        entryUrl: siteUrl ? safeUrl("/", siteUrl) : null,
        siteUrl,
        siteName: ctx.site.name || "this site",
        logoUrl: safeUrl(settings.logoUrl, siteUrl),
        senderAddress: settings.senderAddress,
        accentColor: settings.accentColor,
        baseColor: settings.baseColor,
        footerText: settings.footerText,
        showReadOnline: settings.showReadOnline,
    });
}
