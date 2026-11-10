// Tailwind CSS v4 colours as hex, since email clients do not support oklch().

/** Shades 50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950. */
type Scale = readonly [string, string, string, string, string, string, string, string, string, string, string];

const BASES: Record<string, { label: string; scale: Scale }> = {
    neutral: { label: "Neutral", scale: ["#fafafa", "#f5f5f5", "#e5e5e5", "#d4d4d4", "#a1a1a1", "#737373", "#525252", "#404040", "#262626", "#171717", "#0a0a0a"] },
    stone: { label: "Stone", scale: ["#fafaf9", "#f5f5f4", "#e7e5e4", "#d6d3d1", "#a6a09b", "#79716b", "#57534d", "#44403b", "#292524", "#1c1917", "#0c0a09"] },
    zinc: { label: "Zinc", scale: ["#fafafa", "#f4f4f5", "#e4e4e7", "#d4d4d8", "#9f9fa9", "#71717b", "#52525c", "#3f3f46", "#27272a", "#18181b", "#09090b"] },
    mauve: { label: "Mauve", scale: ["#fafafa", "#f3f1f3", "#e7e4e7", "#d7d0d7", "#a89ea9", "#79697b", "#594c5b", "#463947", "#2a212c", "#1d161e", "#0c090c"] },
    olive: { label: "Olive", scale: ["#fbfbf9", "#f4f4f0", "#e8e8e3", "#d8d8d0", "#abab9c", "#7c7c67", "#5b5b4b", "#474739", "#2b2b22", "#1d1d16", "#0c0c09"] },
    mist: { label: "Mist", scale: ["#f9fbfb", "#f1f3f3", "#e3e7e8", "#d0d6d8", "#9ca8ab", "#67787c", "#4b585b", "#394447", "#22292b", "#161b1d", "#090b0c"] },
    taupe: { label: "Taupe", scale: ["#fbfaf9", "#f3f1f1", "#e8e4e3", "#d8d2d0", "#aba09c", "#7c6d67", "#5b4f4b", "#473c39", "#2b2422", "#1d1816", "#0c0a09"] },
};

/** `light` is shade 600 (links and buttons on white); `dark` is shade 400 (links on a dark background). */
const ACCENTS: Record<string, { label: string; light: string; dark: string }> = {
    red: { label: "Red", light: "#e7000b", dark: "#ff6467" },
    orange: { label: "Orange", light: "#f54900", dark: "#ff8904" },
    amber: { label: "Amber", light: "#e17100", dark: "#ffb900" },
    yellow: { label: "Yellow", light: "#d08700", dark: "#fdc700" },
    lime: { label: "Lime", light: "#5ea500", dark: "#9ae600" },
    green: { label: "Green", light: "#00a63e", dark: "#05df72" },
    emerald: { label: "Emerald", light: "#009966", dark: "#00d492" },
    teal: { label: "Teal", light: "#009689", dark: "#00d5be" },
    cyan: { label: "Cyan", light: "#0092b8", dark: "#00d3f2" },
    sky: { label: "Sky", light: "#0084d1", dark: "#00bcff" },
    blue: { label: "Blue", light: "#155dfc", dark: "#51a2ff" },
    indigo: { label: "Indigo", light: "#4f39f6", dark: "#7c86ff" },
    violet: { label: "Violet", light: "#7f22fe", dark: "#a684ff" },
    purple: { label: "Purple", light: "#9810fa", dark: "#c27aff" },
    fuchsia: { label: "Fuchsia", light: "#c800de", dark: "#ed6aff" },
    pink: { label: "Pink", light: "#e60076", dark: "#fb64b6" },
    rose: { label: "Rose", light: "#ec003f", dark: "#ff637e" },
    slate: { label: "Slate", light: "#45556c", dark: "#90a1b9" },
};

export const DEFAULT_BASE = "zinc";
export const DEFAULT_ACCENT = "blue";

export const BASE_OPTIONS = Object.entries(BASES).map(([value, { label }]) => ({ label, value }));
export const ACCENT_OPTIONS = Object.entries(ACCENTS).map(([value, { label }]) => ({ label, value }));

export const isBaseColor = (value: unknown): value is string => typeof value === "string" && value in BASES;
export const isAccentColor = (value: unknown): value is string => typeof value === "string" && value in ACCENTS;

export interface Theme {
    page: string;
    card: string;
    text: string;
    head: string;
    muted: string;
    quote: string;
    quoteBorder: string;
    rule: string;
    accent: string;
    /** Text colour for content placed on the accent colour. */
    onAccent: string;
    dark: { page: string; card: string; text: string; head: string; muted: string; rule: string; accent: string };
}

function luminance(hex: string): number {
    const [r, g, b] = [1, 3, 5].map((i) => {
        const s = parseInt(hex.slice(i, i + 2), 16) / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Unknown names (for example a value from an older version) fall back to the defaults. */
export function resolveTheme(base: string | undefined, accent: string | undefined): Theme {
    const s = BASES[isBaseColor(base) ? base : DEFAULT_BASE].scale;
    const a = ACCENTS[isAccentColor(accent) ? accent : DEFAULT_ACCENT];
    return {
        page: s[1],
        card: "#ffffff",
        text: s[8],
        head: s[9],
        muted: s[5],
        quote: s[6],
        quoteBorder: s[3],
        rule: s[2],
        accent: a.light,
        onAccent: luminance(a.light) > 0.179 ? s[9] : "#ffffff",
        dark: { page: s[10], card: s[9], text: s[2], head: s[0], muted: s[4], rule: s[7], accent: a.dark },
    };
}
