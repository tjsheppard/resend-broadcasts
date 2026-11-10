import type { Block } from "@emdash-cms/blocks";
import type { BroadcastRecord } from "./types.js";

export const NONE_VALUE = "__none__";

export const SETTINGS_PAGE = "/settings";
export const OVERVIEW_PAGE = "/overview";

export function fmtTime(iso: string | null | undefined): string {
    if (!iso) return "";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function audienceLabel(record: Pick<BroadcastRecord, "segmentName" | "topicName">): string {
    return record.topicName
        ? `${record.segmentName} (topic: ${record.topicName})`
        : record.segmentName;
}

export function banner(
    description: string,
    variant: "default" | "alert" | "error" = "default",
    title?: string,
): Block {
    return { type: "banner", description, variant, ...(title ? { title } : {}) };
}

export function settingsLink(label = "Open broadcast settings"): Block {
    return {
        type: "actions",
        elements: [
            {
                type: "link",
                label,
                target: { kind: "plugin-page", path: SETTINGS_PAGE },
                appearance: "secondary",
            },
        ],
    };
}

export function resendBroadcastUrl(id: string): string {
    return `https://resend.com/broadcasts/${encodeURIComponent(id)}`;
}
