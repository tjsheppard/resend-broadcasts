import { describe, expect, it } from "vitest";
import type { EntryFields } from "../src/lib/fields";
import { renderEmail, safeUrl, UNSUBSCRIBE_PLACEHOLDER } from "../src/lib/render";

const span = (text: string, marks: string[] = []) => ({ _type: "span", text, marks });
const block = (children: unknown[], extra: Record<string, unknown> = {}) => ({
    _type: "block",
    style: "normal",
    children,
    markDefs: [],
    ...extra,
});

function render(body: unknown, overrides: Partial<EntryFields> = {}, entryUrl: string | null = "https://example.com/posts/hello") {
    return renderEmail({
        subject: "Hello",
        preheader: "",
        fields: { title: "Hello", excerpt: "", body, ...overrides },
        entryUrl,
        siteUrl: "https://example.com",
        siteName: "Example",
    });
}

describe("renderEmail", () => {
    it("renders paragraphs, headings, marks and the unsubscribe placeholder", () => {
        const result = render([
            block([span("Intro")], { style: "h2" }),
            block([span("Some "), span("bold", ["strong"]), span(" & <tags>")]),
        ]);
        expect(result.errors).toEqual([]);
        expect(result.html).toContain("<h2");
        expect(result.html).toContain("<strong>bold</strong>");
        expect(result.html).toContain("&amp; &lt;tags&gt;");
        expect(result.html).not.toContain("<tags>");
        expect(result.html).toContain(UNSUBSCRIBE_PLACEHOLDER);
        expect(result.text).toContain(UNSUBSCRIBE_PLACEHOLDER);
        expect(result.text).toContain("Some bold & <tags>");
    });

    it("renders nested lists", () => {
        const result = render([
            block([span("one")], { listItem: "bullet", level: 1 }),
            block([span("nested")], { listItem: "bullet", level: 2 }),
            block([span("two")], { listItem: "bullet", level: 1 }),
        ]);
        expect((result.html.match(/<ul/g) ?? []).length).toBe(2);
        expect(result.text).toContain("- one\n  - nested\n- two");
    });

    it("resolves links against the site URL and drops unsafe schemes", () => {
        const result = render([
            {
                ...block([span("safe", ["a"]), span(" bad", ["b"])]),
                markDefs: [
                    { _key: "a", _type: "link", href: "/about" },
                    { _key: "b", _type: "link", href: "javascript:alert(1)" },
                ],
            },
        ]);
        expect(result.html).toContain('href="https://example.com/about"');
        expect(result.html).not.toContain("javascript:");
        expect(safeUrl("javascript:alert(1)", "https://example.com")).toBeNull();
    });

    it("renders blockquotes, images and breaks, and warns about unknown blocks", () => {
        const result = render([
            block([span("quoted")], { style: "blockquote" }),
            { _type: "image", url: "/pic.png", alt: "A pic" },
            { _type: "break" },
            { _type: "embed" },
            block([span("after")]),
        ]);
        expect(result.html).toContain("<blockquote");
        expect(result.html).toContain('src="https://example.com/pic.png"');
        expect(result.html).toContain("<hr");
        expect(result.text).toContain("> quoted");
        expect(result.text).toContain("[Image: A pic]");
        expect(result.warnings.join(" ")).toContain("embed");
        expect(result.errors).toEqual([]);
    });

    it("floats left and right images so text wraps beside them, and lets mobile stack them", () => {
        const { html } = render([
            { _type: "image", url: "/a.png", alt: "A", alignment: "left", displayWidth: 200, caption: "Cap" },
            block([span("wraps")]),
            { _type: "image", url: "/b.png", alt: "B", alignment: "right", width: 900 },
        ]);
        expect(html).toContain('class="em-float" style="float:left;width:200px;max-width:50%;margin:4px 20px 12px 0;"');
        expect(html).toContain('class="em-float" style="float:right;width:268px;max-width:50%;margin:4px 0 12px 20px;"');
        expect(html).toContain("Cap");
        expect(html).toContain("@media (max-width:480px)");
        expect(html).toContain(".em-float{float:none!important");
    });

    it("centres and clears non-floated images", () => {
        const { html } = render([
            { _type: "image", url: "/c.png", alignment: "center", displayWidth: 300 },
            { _type: "image", url: "/d.png", alignment: "wide" },
        ]);
        expect(html).toContain("clear:both;width:300px;max-width:100%;margin:0 auto 16px;");
        expect(html).toContain('<div style="clear:both;margin:0 0 16px;"><img src="https://example.com/d.png"');
        expect(html).not.toContain('style="float:');
    });

    it("blocks approval for an empty body, empty subject or a missing title", () => {
        expect(render([]).errors.join(" ")).toContain("no body content");
        expect(render([block([span("x")])], { title: "" }).errors.join(" ")).toContain("no title");
    });

    it("cuts the email at the first unsupported block and links to the entry", () => {
        const result = render([
            block([span("before")]),
            { _type: "embed" },
            block([span("after")]),
        ]);
        expect(result.html).toContain("before");
        expect(result.html).not.toContain("after");
        expect(result.html).toContain("Continue reading on the web");
        expect(result.text).toContain("Continue reading on the web: https://example.com/posts/hello");
        expect(result.warnings.join(" ")).toContain("embed");
    });

    it("skips unsupported blocks when there is no entry URL to continue on", () => {
        const result = render([block([span("before")]), { _type: "embed" }, block([span("after")])], {}, null);
        expect(result.html).toContain("after");
        expect(result.html).not.toContain("Continue reading");
        expect(result.warnings.join(" ")).toContain("left out");
    });

    it("blocks approval when there is no entry URL for the read-on-the-web link", () => {
        const result = render([block([span("x")])], {}, null);
        expect(result.errors).toEqual([]);
        expect(result.sendErrors.join(" ")).toContain("no public URL");
    });

    it("adds a read-on-the-web link when the whole body fits", () => {
        const result = render([block([span("all of it")])]);
        expect(result.html).toContain("Read this on the web");
        expect(result.html).not.toContain("Continue reading");
    });
});

describe("email header", () => {
    const input = (logoUrl?: string | null) => ({
        subject: "Hello",
        preheader: "",
        fields: { title: "Hello", excerpt: "", body: [block([span("Hi")])] },
        entryUrl: "https://example.com/posts/hello",
        siteUrl: "https://example.com",
        siteName: "Example",
        logoUrl,
    });

    it("shows the logo, linked to the site, when one is set", () => {
        const { html } = renderEmail(input("https://example.com/logo.png"));
        expect(html).toContain('<img src="https://example.com/logo.png" alt="Example"');
        expect(html).toContain('<a href="https://example.com/"');
    });

    it("falls back to the site name as text without a logo", () => {
        const { html, text } = renderEmail(input());
        expect(html).not.toContain("<img");
        expect(html).toContain(">Example</span>");
        expect(text.startsWith("Example\n\nHi")).toBe(true);
    });

    it("puts the sender address in the footer, escaped, in both versions", () => {
        const { html, text } = renderEmail({ ...input(), senderAddress: "Acme & Co\n1 High St, <London>" });
        expect(html).toContain("Acme &amp; Co<br>1 High St, &lt;London&gt;");
        expect(text).toContain("--\nAcme & Co\n1 High St, <London>\n\nYou are receiving");
    });

    it("links the site name in the default footer line", () => {
        const { html, text } = renderEmail(input());
        expect(html).toMatch(/subscribed to <a href="https:\/\/example\.com\/"[^>]*>Example<\/a>\./);
        expect(text).toContain("subscribed to Example (https://example.com/).");
    });
});

describe("subject and preview text in the body", () => {
    const input = (extra: Record<string, unknown> = {}) => ({
        subject: "The subject",
        preheader: "The preview <text>",
        fields: { title: "Entry title", excerpt: "", body: [block([span("Hi")])] },
        entryUrl: "https://example.com/posts/hello",
        siteUrl: "https://example.com",
        siteName: "Example",
        ...extra,
    });

    it("keeps them out of the body by default, but still sends the preview text as the hidden preheader", () => {
        const { html, text } = renderEmail(input());
        expect(html).not.toContain("<h1");
        expect(html).not.toContain("The subject</h1");
        expect(html).toContain("display:none");
        expect(text).not.toContain("The subject");
    });

    it("puts the subject as a heading and the preview text under it when switched on", () => {
        const { html, text } = renderEmail(input({ showSubject: true }));
        expect(html).toMatch(/<h1[^>]*>The subject<\/h1>/);
        expect(html).toMatch(/<p[^>]*>The preview &lt;text&gt;<\/p>/);
        expect(text).toContain("Example\n\nThe subject\n\nThe preview <text>\n\nHi");
    });
});

describe("template options", () => {
    const input = (extra: Record<string, unknown> = {}) => ({
        subject: "Hello",
        preheader: "",
        fields: { title: "Hello", excerpt: "", body: [block([span("Hi", ["l"])], { markDefs: [{ _key: "l", _type: "link", href: "https://example.com/x" }] })] },
        entryUrl: "https://example.com/posts/hello",
        siteUrl: "https://example.com",
        siteName: "Example",
        ...extra,
    });

    const cut = { title: "Hello", excerpt: "", body: [{ _type: "embed" }] };

    it("uses the accent colour for links and the button, with readable button text", () => {
        const yellow = renderEmail(input({ accentColor: "yellow", fields: cut })).html;
        expect(yellow).toContain('bgcolor="#d08700"');
        expect(yellow).toMatch(/font-weight:600;color:#18181b;/);
        const blue = renderEmail(input({ accentColor: "blue", fields: cut })).html;
        expect(blue).toContain('bgcolor="#155dfc"');
        expect(blue).toMatch(/font-weight:600;color:#ffffff;/);
        expect(renderEmail(input({ accentColor: "rose" })).html).toContain("color:#ec003f;text-decoration:underline");
    });

    it("uses a lighter accent for links in dark mode", () => {
        expect(renderEmail(input({ accentColor: "rose" })).html).toContain(".em-link{color:#ff637e!important}");
    });

    it("applies the base colour to the page, text and dark-mode backgrounds", () => {
        const { html } = renderEmail(input({ baseColor: "stone" }));
        expect(html).toContain("background:#f5f5f4;");
        expect(html).toContain(".em-bg{background:#0c0a09!important}");
    });

    it("defaults to zinc and blue, and ignores unknown colour names", () => {
        const { html } = renderEmail(input({ baseColor: "red; x", accentColor: "#fff" }));
        expect(html).toContain("background:#f4f4f5;");
        expect(html).toContain("color:#155dfc;text-decoration:underline");
    });

    it("includes dark-mode styles, the colour-scheme meta tags and no Outlook-only markup", () => {
        const { html } = renderEmail(input({ fields: { title: "Hello", excerpt: "", body: [{ _type: "embed" }] } }));
        expect(html).toContain('<meta name="color-scheme" content="light dark">');
        expect(html).toContain("@media (prefers-color-scheme:dark)");
        expect(html).not.toContain("mso");
    });

    it("replaces the default footer line with the custom message, escaped", () => {
        const { html, text } = renderEmail(input({ footerText: "You joined <us>\nThanks" }));
        expect(html).toContain("You joined &lt;us&gt;<br>Thanks");
        expect(html).not.toContain("because you subscribed");
        expect(text).toContain("You joined <us>\nThanks\nUnsubscribe:");
    });

    it("hides the read-on-the-web link when turned off, but keeps the continue-reading button", () => {
        const off = renderEmail(input({ showReadOnline: false }));
        expect(off.html).not.toContain("Read this on the web");
        expect(off.text).not.toContain("Read this on the web");
        const cut = renderEmail(input({ showReadOnline: false, fields: { title: "Hello", excerpt: "", body: [block([span("a")]), { _type: "embed" }] } }));
        expect(cut.html).toContain("Continue reading on the web");
    });

    it("does not require an entry URL when the link is turned off", () => {
        const result = renderEmail(input({ showReadOnline: false, entryUrl: null }));
        expect(result.sendErrors).toEqual([]);
    });
});
