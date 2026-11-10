import type { EntryFields } from "./fields.js";
import { resolveTheme, type Theme } from "./palette.js";

/** Resend replaces this per recipient. It must appear literally in every broadcast. */
export const UNSUBSCRIBE_PLACEHOLDER = "{{{RESEND_UNSUBSCRIBE_URL}}}";

const MEDIA_FILE_PATH = "/_emdash/api/media/file/";
const GMAIL_CLIP_BYTES = 100_000;

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";
const F = `font-family:${FONT};`;

export interface RenderInput {
    subject: string;
    preheader: string;
    fields: EntryFields;
    /** Absolute public URL of the entry, when it can be determined. */
    entryUrl: string | null;
    siteUrl: string;
    siteName: string;
    /** Absolute logo image URL for the email header; the site name is shown as text when absent. */
    logoUrl?: string | null;
    /** Postal address of the sender, shown in the footer. May span several lines. */
    senderAddress?: string;
    /** Tailwind colour name for the greys (see palette.ts); unknown or absent means the default. */
    baseColor?: string;
    /** Tailwind colour name for links and the button; unknown or absent means the default. */
    accentColor?: string;
    /** Replaces the default footer reason line when non-empty. */
    footerText?: string;
    /** Show the "Read this on the web" link. Defaults to true. */
    showReadOnline?: boolean;
    /** Put the subject as a heading, and the preview text under it, at the top of the body. Defaults to false. */
    showSubject?: boolean;
}

export interface RenderResult {
    html: string;
    text: string;
    /** Problems that block any email, including a test. */
    errors: string[];
    /** Extra problems that only block a real broadcast. */
    sendErrors: string[];
    /** Things the editor should know about but that do not block approval. */
    warnings: string[];
}

interface Span {
    _type?: string;
    text?: string;
    marks?: string[];
}

interface PtBlock {
    _type?: string;
    _key?: string;
    style?: string;
    listItem?: string;
    level?: number;
    children?: Span[];
    markDefs?: Array<{ _key?: string; _type?: string; href?: string }>;
    asset?: { url?: string; src?: string; _ref?: string; id?: string };
    url?: string;
    alt?: string;
    caption?: string;
    width?: number;
    height?: number;
}

export function escapeHtml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

/** Resolve to an absolute http(s) or mailto URL, or null. Relative URLs use the site base. */
export function safeUrl(href: unknown, base: string): string | null {
    if (typeof href !== "string" || href.trim() === "") return null;
    try {
        const url = new URL(href.trim(), base);
        if (url.protocol === "https:" || url.protocol === "http:" || url.protocol === "mailto:") {
            return url.toString();
        }
    } catch {
        // fall through
    }
    return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Public URL for an image field value or Portable Text image asset. */
export function mediaUrl(value: unknown, siteUrl: string): string | null {
    if (typeof value === "string") return safeUrl(value, siteUrl);
    if (!isRecord(value)) return null;
    const asset = isRecord(value.asset) ? value.asset : {};
    for (const candidate of [value.src, value.url, asset.url, asset.src]) {
        const resolved = safeUrl(candidate, siteUrl);
        if (resolved) return resolved;
    }
    const id = [value.id, asset._ref, asset.id].find((v) => typeof v === "string" && v !== "");
    return typeof id === "string" ? safeUrl(`${MEDIA_FILE_PATH}${encodeURIComponent(id)}`, siteUrl) : null;
}

const pStyle = (t: Theme) => `margin:0 0 16px;${F}font-size:16px;line-height:1.6;color:${t.text};`;

interface Inline {
    html: string;
    text: string;
}

function renderInline(block: PtBlock, siteUrl: string, theme: Theme): Inline {
    const defs = block.markDefs ?? [];
    let html = "";
    let text = "";
    for (const span of block.children ?? []) {
        if (span._type !== "span" || typeof span.text !== "string") continue;
        let piece = escapeHtml(span.text).replace(/\n/g, "<br>");
        let linkHref: string | null = null;
        for (const mark of span.marks ?? []) {
            const def = defs.find((d) => d._key === mark);
            if (def) {
                if (def._type === "link") linkHref = safeUrl(def.href, siteUrl);
                continue;
            }
            if (mark === "strong") piece = `<strong>${piece}</strong>`;
            else if (mark === "em") piece = `<em>${piece}</em>`;
            else if (mark === "underline") piece = `<u>${piece}</u>`;
            else if (mark === "code") piece = `<code>${piece}</code>`;
            else if (mark === "strike-through" || mark === "strikethrough") piece = `<s>${piece}</s>`;
        }
        if (linkHref) {
            html += `<a href="${escapeHtml(linkHref)}" class="em-link" style="color:${theme.accent};text-decoration:underline;">${piece}</a>`;
            text += linkHref.replace(/^mailto:/, "") === span.text ? span.text : `${span.text} (${linkHref})`;
        } else {
            html += piece;
            text += span.text;
        }
    }
    return { html, text };
}

interface ListItem {
    level: number;
    ordered: boolean;
    inline: Inline;
}

function renderListHtml(items: ListItem[], start: number, theme: Theme): [string, number] {
    const level = items[start]?.level ?? 1;
    const tag = items[start]?.ordered ? "ol" : "ul";
    let out = `<${tag} class="em-text" style="margin:0 0 16px;padding-left:24px;${F}font-size:16px;line-height:1.6;color:${theme.text};">`;
    let index = start;
    while (index < items.length && items[index].level >= level) {
        out += `<li style="margin:0 0 6px;">${items[index].inline.html}`;
        index++;
        if (index < items.length && items[index].level > level) {
            const [nested, next] = renderListHtml(items, index, theme);
            out += nested;
            index = next;
        }
        out += "</li>";
    }
    return [`${out}</${tag}>`, index];
}

function renderListText(items: ListItem[]): string {
    const counters: number[] = [];
    return items
        .map((item) => {
            const depth = Math.max(0, item.level - 1);
            counters.length = depth + 1;
            counters[depth] = (counters[depth] ?? 0) + 1;
            const marker = item.ordered ? `${counters[depth]}.` : "-";
            return `${"  ".repeat(depth)}${marker} ${item.inline.text}`;
        })
        .join("\n");
}

function headingStyles(t: Theme): Record<string, { tag: string; style: string }> {
    const h2 = { tag: "h2", style: `margin:24px 0 12px;${F}font-size:22px;line-height:1.3;color:${t.head};` };
    const h3 = { tag: "h3", style: `margin:20px 0 10px;${F}font-size:18px;line-height:1.35;color:${t.head};` };
    const h4 = { tag: "h4", style: `margin:16px 0 8px;${F}font-size:16px;line-height:1.4;color:${t.head};` };
    return { h1: h2, h2, h3, h4, h5: h4, h6: h4 };
}

interface Body {
    html: string;
    text: string;
    errors: string[];
    skipped: string[];
    /** The body was cut at the first unsupported block. */
    truncated: boolean;
    hasContent: boolean;
}

function renderBody(value: unknown, siteUrl: string, theme: Theme, stopAtUnsupported: boolean): Body {
    const result: Body = { html: "", text: "", errors: [], skipped: [], truncated: false, hasContent: false };
    if (!Array.isArray(value)) return result;

    const htmlParts: string[] = [];
    const textParts: string[] = [];
    const blocks = value.filter(isRecord) as PtBlock[];
    const headings = headingStyles(theme);

    for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        if (block._type === "block" && block.listItem) {
            const items: ListItem[] = [];
            while (i < blocks.length && blocks[i]._type === "block" && blocks[i].listItem) {
                const item = blocks[i];
                items.push({
                    level: Math.max(1, item.level ?? 1),
                    ordered: item.listItem === "number",
                    inline: renderInline(item, siteUrl, theme),
                });
                i++;
            }
            i--;
            htmlParts.push(renderListHtml(items, 0, theme)[0]);
            textParts.push(renderListText(items));
            result.hasContent = true;
        } else if (block._type === "block") {
            const inline = renderInline(block, siteUrl, theme);
            if (inline.text.trim() === "") continue;
            const heading = block.style ? headings[block.style] : undefined;
            if (heading) {
                htmlParts.push(`<${heading.tag} class="em-head" style="${heading.style}">${inline.html}</${heading.tag}>`);
                textParts.push(inline.text);
            } else if (block.style === "blockquote") {
                htmlParts.push(
                    `<blockquote class="em-text em-rule" style="margin:0 0 16px;padding:4px 0 4px 16px;border-left:3px solid ${theme.quoteBorder};${F}font-size:16px;line-height:1.6;color:${theme.quote};">${inline.html}</blockquote>`,
                );
                textParts.push(
                    inline.text
                        .split("\n")
                        .map((line) => `> ${line}`)
                        .join("\n"),
                );
            } else {
                htmlParts.push(`<p class="em-text" style="${pStyle(theme)}">${inline.html}</p>`);
                textParts.push(inline.text);
            }
            result.hasContent = true;
        } else if (block._type === "image") {
            const src = mediaUrl(block, siteUrl);
            if (!src) {
                result.errors.push("An image in the body has no public URL.");
                continue;
            }
            const alt = typeof block.alt === "string" ? block.alt : "";
            const caption = typeof block.caption === "string" ? block.caption : "";
            htmlParts.push(
                `<p style="margin:0 0 16px;"><img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" style="display:block;max-width:100%;height:auto;border:0;border-radius:4px;">${caption
                    ? `<span class="em-muted" style="display:block;margin-top:6px;${F}font-size:13px;color:${theme.muted};">${escapeHtml(caption)}</span>`
                    : ""
                }</p>`,
            );
            textParts.push(alt ? `[Image: ${alt}]` : "[Image]");
            result.hasContent = true;
        } else if (block._type === "break") {
            htmlParts.push(`<hr class="em-rule" style="border:0;border-top:1px solid ${theme.rule};margin:24px 0;">`);
            textParts.push("---");
        } else {
            result.skipped.push(String(block._type ?? "unknown"));
            if (stopAtUnsupported) {
                result.truncated = true;
                break;
            }
        }
    }

    result.html = htmlParts.join("\n");
    result.text = textParts.join("\n\n");
    return result;
}

function truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    const slice = text.slice(0, maxLength);
    const sentenceEnd = Math.max(
        slice.lastIndexOf(". "),
        slice.lastIndexOf("! "),
        slice.lastIndexOf("? "),
    );
    if (sentenceEnd > maxLength * 0.5) return slice.slice(0, sentenceEnd + 1);
    const space = slice.lastIndexOf(" ");
    return `${(space > 0 ? slice.slice(0, space) : slice).trimEnd()}…`;
}

export function firstSentence(text: string, maxLength = 110): string {
    const trimmed = text.trim();
    const match = /^.*?[.!?](\s|$)/s.exec(trimmed);
    return truncate(match ? match[0].trim() : trimmed, maxLength);
}

function button(label: string, href: string, theme: Theme): string {
    // The MSO spacers and mso-* properties give Outlook (Word renderer) the padding it ignores on links.
    return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 16px;"><tr><td bgcolor="${theme.accent}" style="background:${theme.accent};border-radius:6px;"><a href="${escapeHtml(href)}" style="display:inline-block;line-height:100%;padding:12px 22px;mso-padding-alt:0;${F}font-size:16px;font-weight:600;color:${theme.onAccent};text-decoration:none;"><!--[if mso]><i style="letter-spacing:22px;mso-font-width:-100%;mso-text-raise:18pt" hidden>&nbsp;</i><![endif]--><span style="display:inline-block;line-height:120%;mso-text-raise:9pt;">${escapeHtml(label)}</span><!--[if mso]><i style="letter-spacing:22px;mso-font-width:-100%" hidden>&nbsp;</i><![endif]--></a></td></tr></table>`;
}

function darkModeCss(t: Theme): string {
    return `:root{color-scheme:light dark;supported-color-schemes:light dark;}
@media (prefers-color-scheme:dark){
.em-bg{background:${t.dark.page}!important}
.em-card{background:${t.dark.card}!important}
.em-text{color:${t.dark.text}!important}
.em-head{color:${t.dark.head}!important}
.em-muted,.em-muted a{color:${t.dark.muted}!important}
.em-link{color:${t.dark.accent}!important}
.em-rule{border-color:${t.dark.rule}!important}
}`;
}

export function renderEmail(input: RenderInput): RenderResult {
    const { fields, entryUrl, siteUrl } = input;
    const theme = resolveTheme(input.baseColor, input.accentColor);
    const showReadOnline = input.showReadOnline !== false;
    const showSubject = input.showSubject === true;
    const errors: string[] = [];
    const sendErrors: string[] = [];
    const warnings: string[] = [];

    if (!input.subject.trim()) errors.push("The subject is empty.");
    if (!fields.title) errors.push("The entry has no title.");
    if (!entryUrl && showReadOnline) {
        sendErrors.push(
            "The entry has no public URL, so the email would have no “read on the web” link. Set the site URL in settings, and give the entry a slug in a collection with a URL pattern.",
        );
    }

    let bodyHtml = "";
    let bodyText = "";

    const body = renderBody(fields.body, siteUrl, theme, entryUrl !== null);
    errors.push(...new Set(body.errors));
    if (!body.hasContent) errors.push("The entry has no body content to send.");
    if (body.truncated) {
        warnings.push(
            `The email stops at the first unsupported block (${body.skipped[0]}) and links to the entry for the rest.`,
        );
    } else if (body.skipped.length > 0) {
        const kinds = [...new Set(body.skipped)].join(", ");
        warnings.push(
            `${body.skipped.length} unsupported block${body.skipped.length === 1 ? "" : "s"} will be left out of the email (${kinds}).`,
        );
    }
    bodyHtml = body.html;
    bodyText = body.text;

    const cta = entryUrl && body.truncated ? button("Continue reading on the web", entryUrl, theme) : "";
    const readOnline =
        entryUrl && showReadOnline && !body.truncated
            ? `<p class="em-muted" style="margin:0 0 8px;${F}font-size:13px;color:${theme.muted};"><a href="${escapeHtml(entryUrl)}" style="color:${theme.muted};">Read this on the web</a></p>`
            : "";

    const hiddenPreheader = input.preheader
        ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${escapeHtml(input.preheader)}${"&zwnj;&nbsp;".repeat(30)}</div>`
        : "";

    const siteLink = safeUrl(siteUrl, siteUrl);
    const brand = input.logoUrl
        ? `<img src="${escapeHtml(input.logoUrl)}" alt="${escapeHtml(input.siteName)}" style="display:block;border:0;height:auto;max-height:48px;max-width:200px;">`
        : `<span class="em-head" style="${F}font-size:18px;font-weight:700;color:${theme.head};">${escapeHtml(input.siteName)}</span>`;
    const header = siteLink
        ? `<a href="${escapeHtml(siteLink)}" style="text-decoration:none;">${brand}</a>`
        : brand;

    const subjectRow = showSubject
        ? `<tr><td style="padding:20px 32px 8px;">
<h1 class="em-head" style="margin:0 0 8px;${F}font-size:28px;line-height:1.25;color:${theme.head};">${escapeHtml(input.subject)}</h1>${input.preheader
            ? `\n<p class="em-muted" style="margin:0;${F}font-size:18px;line-height:1.5;color:${theme.muted};">${escapeHtml(input.preheader)}</p>`
            : ""
        }
</td></tr>
`
        : "";

    const addressLines = (input.senderAddress ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const addressHtml = addressLines.length
        ? `${addressLines.map(escapeHtml).join("<br>")}<br><br>`
        : "";

    const footerReason = input.footerText?.trim() || `You are receiving this email because you subscribed to ${input.siteName}.`;
    const footerReasonHtml = footerReason
        .split(/\r?\n/)
        .map((line) => escapeHtml(line.trim()))
        .join("<br>");

    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<meta name="x-apple-disable-message-reformatting">
<title>${escapeHtml(input.subject)}</title>
<!--[if mso]><style>td,th,p,h1,h2,h3,h4,li,a,span{font-family:Arial,sans-serif!important}</style><![endif]-->
<style>
${darkModeCss(theme)}
</style>
</head>
<body class="em-bg" style="margin:0;padding:0;background:${theme.page};${F}">
${hiddenPreheader}
<table role="presentation" class="em-bg" width="100%" cellpadding="0" cellspacing="0" style="background:${theme.page};">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" class="em-card" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:${theme.card};border-radius:8px;overflow:hidden;">
<tr><td style="padding:24px 32px 0;">
${header}
</td></tr>
${subjectRow}<tr><td style="padding:${showSubject ? "8px" : "20px"} 32px 16px;">
${bodyHtml}
${cta}
${readOnline}
</td></tr>
<tr><td class="em-muted em-rule" style="padding:16px 32px 28px;border-top:1px solid ${theme.rule};${F}font-size:12px;line-height:1.5;color:${theme.muted};">
${addressHtml}${footerReasonHtml}<br>
<a href="${UNSUBSCRIBE_PLACEHOLDER}" style="color:${theme.muted};">Unsubscribe</a>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

    const textParts = [
        input.siteName,
        ...(showSubject ? [input.subject, input.preheader] : []),
        bodyText,
    ].filter(Boolean);
    if (entryUrl && (showReadOnline || body.truncated)) {
        textParts.push(`${body.truncated ? "Continue reading on the web" : "Read this on the web"}: ${entryUrl}`);
    }
    textParts.push(`--\n${addressLines.length ? `${addressLines.join("\n")}\n\n` : ""}${footerReason}\nUnsubscribe: ${UNSUBSCRIBE_PLACEHOLDER}`);
    const text = textParts.join("\n\n");

    if (!html.includes(UNSUBSCRIBE_PLACEHOLDER)) {
        errors.push("The email has no unsubscribe link.");
    }
    const bytes = new TextEncoder().encode(html).byteLength;
    if (bytes > GMAIL_CLIP_BYTES) {
        warnings.push(
            `The email is ${Math.round(bytes / 1000)} KB. Gmail clips messages over about 100 KB, which hides the unsubscribe link. Consider excerpt mode.`,
        );
    }

    return { html, text, errors, sendErrors, warnings };
}
