export type RecordStatus = "approved" | "sending" | "sent" | "failed" | "lapsed" | "inactive";

/** Which content field feeds which part of the email. `null` = explicitly none. */
export interface FieldMap {
    title?: string | null;
    excerpt?: string | null;
    body?: string | null;
}

export type FieldRole = keyof FieldMap;

export interface Settings {
    apiKey: string | null;
    enabledCollections: string[];
    fieldMaps: Record<string, FieldMap>;
    defaultSegmentId: string | null;
    defaultTopicId: string | null;
    fromAddress: string;
    replyTo: string;
    logoUrl: string;
    senderAddress: string;
    /** Tailwind colour name (see palette.ts) for backgrounds, text and borders. */
    baseColor: string;
    /** Tailwind colour name (see palette.ts) for links and the button. */
    accentColor: string;
    /** Replaces the default "you are receiving this because" footer line when set. */
    footerText: string;
    showReadOnline: boolean;
}

/** Per-entry choices saved from the editor panel (KV, not an approval). */
export interface Selection {
    segmentId?: string;
    topicId?: string;
    subject?: string;
    preheader?: string;
    /** Show the subject and preview text at the top of the email body. */
    showSubject?: boolean;
}

export interface ResendSegment {
    id: string;
    name: string;
}

export interface ResendTopic {
    id: string;
    name: string;
}

export interface AudienceLists {
    segments: ResendSegment[];
    topics: ResendTopic[];
    fetchedAt: number;
}

/** The approval snapshot, plus send bookkeeping. One per entry. */
export interface BroadcastRecord {
    collection: string;
    entryId: string;
    slug: string | null;
    title: string;
    status: RecordStatus;
    /** Status before the approval was deactivated, so a re-schedule can revive an approval. */
    prevStatus?: RecordStatus;
    segmentId: string;
    segmentName: string;
    topicId?: string;
    topicName?: string;
    subject: string;
    preheader: string;
    html: string;
    text: string;
    contentHash: string;
    approvedBy: string;
    approvedAt: string;
    /** ISO time the entry is scheduled to publish; null when approved for an already-published entry. */
    sendAfter: string | null;
    /** Unique per send attempt; also embedded in the broadcast name for later lookup. */
    attemptId?: string;
    broadcastName?: string;
    broadcastId?: string;
    sentAt?: string;
    error?: string;
    updatedAt: string;
}

/** The fields of an entry the plugin cares about, independent of the hook shape. */
export interface EntryLike {
    id: string;
    slug: string | null;
    status?: string;
    locale?: string | null;
    scheduledAt?: string | null;
    data: Record<string, unknown>;
}
