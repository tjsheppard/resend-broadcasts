import type { CollectionSchemaInfo, StorageCollection } from "emdash";
import type { PluginContext } from "emdash/plugin";
import { schema } from "./ctx.js";
import { contentHash, resolveFieldMap } from "./fields.js";
import type { Prepared } from "./prepare.js";
import { describeResendError, ResendError } from "./resend.js";
import { clientFor } from "./settings.js";
import type { BroadcastRecord, EntryLike, Settings } from "./types.js";

/** A send stuck in `sending` for longer than this is reconciled against Resend. */
export const STALE_SENDING_MS = 5 * 60 * 1000;

export const recordId = (collection: string, entryId: string) => `${collection}:${entryId}`;

function store(ctx: PluginContext): StorageCollection<BroadcastRecord> {
    return ctx.storage.broadcasts as StorageCollection<BroadcastRecord>;
}

export async function getRecord(
    ctx: PluginContext,
    collection: string,
    entryId: string,
): Promise<BroadcastRecord | null> {
    return store(ctx).get(recordId(collection, entryId));
}

/** An approval that may still send when the entry goes live. */
export function isSendable(record: BroadcastRecord): boolean {
    return (
        record.status === "approved" ||
        (record.status === "inactive" && record.prevStatus === "approved")
    );
}

export async function getCollectionInfo(
    ctx: PluginContext,
    slug: string,
): Promise<CollectionSchemaInfo | null> {
    return schema(ctx).getCollection(slug);
}

/** Read-modify-write with compare-and-set. `fn` returns null to leave the record alone. */
async function mutate(
    ctx: PluginContext,
    id: string,
    fn: (record: BroadcastRecord) => BroadcastRecord | null,
): Promise<BroadcastRecord | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
        const current = await store(ctx).getVersioned(id);
        if (!current) return null;
        const next = fn(current.value);
        if (!next) return null;
        const updated = { ...next, updatedAt: new Date().toISOString() };
        const result = await store(ctx).compareAndSet(id, current.revision, updated);
        if (result.applied) return updated;
    }
    return null;
}

export type ApproveResult =
    | { ok: true; record: BroadcastRecord }
    | { ok: false; errors: string[] };

export async function approveEntry(
    ctx: PluginContext,
    settings: Settings,
    prep: Prepared,
    entry: EntryLike,
    user: { id: string; email?: string } | undefined,
    sendAfter: string | null,
): Promise<ApproveResult> {
    const errors = [...prep.render.errors, ...prep.render.sendErrors];
    if (!settings.apiKey) errors.push("Add a Resend API key in settings.");
    if (!settings.fromAddress) errors.push("Set the From address in settings.");
    if (!prep.audience) errors.push("Choose a segment.");
    if (errors.length > 0 || !prep.audience) return { ok: false, errors };

    const id = recordId(prep.collection.slug, entry.id);
    const existing = await store(ctx).getVersioned(id);
    if (existing?.value.status === "sending") {
        return { ok: false, errors: ["This entry is being sent right now."] };
    }
    if (existing?.value.status === "sent") {
        return { ok: false, errors: ["A broadcast has already been sent for this entry."] };
    }

    const now = new Date().toISOString();
    const record: BroadcastRecord = {
        collection: prep.collection.slug,
        entryId: entry.id,
        slug: entry.slug,
        title: prep.fields.title,
        status: "approved",
        segmentId: prep.audience.segmentId,
        segmentName: prep.audience.segmentName,
        ...(prep.audience.topicId
            ? { topicId: prep.audience.topicId, topicName: prep.audience.topicName }
            : {}),
        subject: prep.subject,
        preheader: prep.preheader,
        html: prep.render.html,
        text: prep.render.text,
        contentHash: prep.hash,
        approvedBy: user?.email || user?.id || "unknown",
        approvedAt: now,
        sendAfter,
        updatedAt: now,
    };
    const result = await store(ctx).compareAndSet(id, existing?.revision ?? null, record);
    if (!result.applied) {
        return { ok: false, errors: ["The approval changed while saving. Try again."] };
    }
    return { ok: true, record };
}

/** Remove an approval (or a lapsed/failed/inactive record). Sent and sending records stay. */
export async function revokeApproval(
    ctx: PluginContext,
    collection: string,
    entryId: string,
): Promise<boolean> {
    const id = recordId(collection, entryId);
    const current = await store(ctx).getVersioned(id);
    if (!current) return false;
    if (current.value.status === "sent" || current.value.status === "sending") return false;
    return (await store(ctx).compareAndDelete(id, current.revision)).applied;
}

/** Approval whose entry content no longer matches the snapshot becomes `lapsed`. */
export async function lapseIfChanged(
    ctx: PluginContext,
    settings: Settings,
    collection: CollectionSchemaInfo,
    entry: EntryLike,
): Promise<boolean> {
    const id = recordId(collection.slug, entry.id);
    const record = await store(ctx).get(id);
    if (!record || !isSendable(record)) return false;
    const hash = await contentHash(entry, resolveFieldMap(collection, settings.fieldMaps[collection.slug]));
    if (hash === record.contentHash) return false;
    const updated = await mutate(ctx, id, (r) =>
        isSendable(r) && r.contentHash !== hash
            ? { ...r, status: "lapsed", prevStatus: undefined, error: "The entry changed after it was approved." }
            : null,
    );
    return updated !== null;
}

/** Unschedule, unpublish or delete: nothing pending may fire. */
export async function deactivate(
    ctx: PluginContext,
    collection: string,
    entryId: string,
    permanent = false,
): Promise<void> {
    const id = recordId(collection, entryId);
    await mutate(ctx, id, (r) => {
        if (r.status === "sent" || r.status === "sending" || r.status === "inactive") return null;
        return { ...r, status: "inactive", prevStatus: r.status };
    });
    if (permanent) {
        const record = await store(ctx).get(id);
        if (record && record.status !== "sent") await revokeApproval(ctx, collection, entryId);
    }
}

/** An entry was (re)scheduled: refresh the send time and revive a deactivated approval if nothing changed. */
export async function onScheduled(
    ctx: PluginContext,
    settings: Settings,
    collection: CollectionSchemaInfo,
    entry: EntryLike,
    scheduledAt: string | null,
): Promise<void> {
    const id = recordId(collection.slug, entry.id);
    const hash = await contentHash(entry, resolveFieldMap(collection, settings.fieldMaps[collection.slug]));
    await mutate(ctx, id, (r) => {
        if (r.status === "inactive" && r.prevStatus === "approved") {
            if (r.contentHash !== hash) return { ...r, status: "lapsed", prevStatus: undefined };
            return { ...r, status: "approved", prevStatus: undefined, sendAfter: scheduledAt };
        }
        if (r.status === "approved") return { ...r, sendAfter: scheduledAt };
        return null;
    });
}

export type SendOutcome =
    | { ok: true; broadcastId: string; record: BroadcastRecord }
    | {
        ok: false;
        reason: "no-record" | "not-sendable" | "lapsed" | "claimed" | "error";
        message: string;
    };

function broadcastName(record: BroadcastRecord, attemptId: string): string {
    const date = new Date().toISOString().slice(0, 10);
    return `${record.title.slice(0, 100)} (${date}) #${attemptId}`;
}

/**
 * Send the approved snapshot as a Resend broadcast, exactly once.
 *
 * The approval is claimed with compare-and-set before any request is made, so a
 * double-fired hook, a retry click and a concurrent publish cannot both send.
 * Only the approved snapshot is sent, never the live fields.
 */
export async function sendRecord(
    ctx: PluginContext,
    settings: Settings,
    collection: CollectionSchemaInfo,
    entry: EntryLike,
    options: { retry?: boolean } = {},
): Promise<SendOutcome> {
    const id = recordId(collection.slug, entry.id);
    const existing = await store(ctx).get(id);
    if (!existing) return { ok: false, reason: "no-record", message: "No approval exists for this entry." };

    const canSend = isSendable(existing) || (options.retry === true && existing.status === "failed");
    if (!canSend) {
        return { ok: false, reason: "not-sendable", message: `Nothing to send (status: ${existing.status}).` };
    }

    const hash = await contentHash(entry, resolveFieldMap(collection, settings.fieldMaps[collection.slug]));
    if (hash !== existing.contentHash) {
        await mutate(ctx, id, (r) =>
            r.status === "sending" || r.status === "sent"
                ? null
                : { ...r, status: "lapsed", prevStatus: undefined, error: "The entry changed after it was approved." },
        );
        return {
            ok: false,
            reason: "lapsed",
            message: "The entry changed after it was approved, so nothing was sent.",
        };
    }

    const attemptId = crypto.randomUUID().slice(0, 8);
    const claimed = await mutate(ctx, id, (r) => {
        const ok = isSendable(r) || (options.retry === true && r.status === "failed");
        if (!ok) return null;
        return {
            ...r,
            status: "sending",
            prevStatus: undefined,
            attemptId,
            broadcastName: broadcastName(r, attemptId),
            error: undefined,
        };
    });
    if (!claimed) {
        return { ok: false, reason: "claimed", message: "This entry is already being sent or has been sent." };
    }

    const fail = async (message: string): Promise<SendOutcome> => {
        await mutate(ctx, id, (r) => (r.attemptId === attemptId ? { ...r, status: "failed", error: message } : null));
        ctx.log.error("Broadcast failed", { collection: collection.slug, entryId: entry.id, message });
        return { ok: false, reason: "error", message };
    };
    const succeed = async (broadcastId: string): Promise<SendOutcome> => {
        const sent = await mutate(ctx, id, (r) =>
            r.attemptId === attemptId
                ? {
                    ...r,
                    status: "sent",
                    broadcastId,
                    sentAt: new Date().toISOString(),
                    error: undefined,
                    html: "",
                    text: "",
                }
                : null,
        );
        ctx.log.info("Broadcast sent", { collection: collection.slug, entryId: entry.id, broadcastId });
        return { ok: true, broadcastId, record: sent ?? claimed };
    };

    const client = clientFor(ctx, settings);
    if (!client) return fail("No Resend API key is configured.");
    if (!settings.fromAddress) return fail("No From address is configured.");

    try {
        const created = await client.createBroadcast({
            segmentId: claimed.segmentId,
            topicId: claimed.topicId,
            from: settings.fromAddress,
            replyTo: settings.replyTo || undefined,
            subject: claimed.subject,
            html: claimed.html,
            text: claimed.text,
            name: claimed.broadcastName ?? broadcastName(claimed, attemptId),
        });
        return await succeed(created.id);
    } catch (error) {
        if (error instanceof ResendError && error.uncertain && claimed.broadcastName) {
            try {
                const found = await client.findBroadcastByName(claimed.broadcastName);
                if (found) return await succeed(found.id);
            } catch {
                // fall through to the uncertain failure below
            }
            return fail(
                `${describeResendError(error)} Resend may or may not have created the broadcast. Check the Resend dashboard before retrying.`,
            );
        }
        return fail(describeResendError(error));
    }
}

/** Resolve a send that was interrupted (e.g. the worker was evicted mid-request). */
export async function reconcileStale(
    ctx: PluginContext,
    settings: Settings,
    record: BroadcastRecord,
): Promise<BroadcastRecord> {
    if (record.status !== "sending") return record;
    if (Date.now() - Date.parse(record.updatedAt) < STALE_SENDING_MS) return record;
    const client = clientFor(ctx, settings);
    const id = recordId(record.collection, record.entryId);
    const outcome = async (resolve: (r: BroadcastRecord) => BroadcastRecord) =>
        (await mutate(ctx, id, (r) => (r.attemptId === record.attemptId && r.status === "sending" ? resolve(r) : null))) ??
        record;

    if (client && record.broadcastName) {
        try {
            const found = await client.findBroadcastByName(record.broadcastName);
            if (found) {
                return outcome((r) => ({
                    ...r,
                    status: "sent",
                    broadcastId: found.id,
                    sentAt: new Date().toISOString(),
                    html: "",
                    text: "",
                }));
            }
        } catch {
            // leave as failed-uncertain below
        }
    }
    return outcome((r) => ({
        ...r,
        status: "failed",
        error: "The send was interrupted and Resend has no matching broadcast. Check the Resend dashboard before retrying.",
    }));
}
