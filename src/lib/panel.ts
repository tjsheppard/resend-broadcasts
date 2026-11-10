import type { Block, BlockResponse } from "@emdash-cms/blocks";
import type { PluginContext, SandboxedRouteContext } from "emdash/plugin";
import { content, frugal } from "./ctx.js";
import { toEntry } from "./fields.js";
import { prepare, resolveAudience, type Prepared } from "./prepare.js";
import { describeResendError, type ResendClient } from "./resend.js";
import { clientFor, effectiveSiteUrl, getSelection, loadAudience, loadSettings, saveSelection } from "./settings.js";
import {
    approveEntry,
    getCollectionInfo,
    getRecord,
    reconcileStale,
    revokeApproval,
    sendRecord,
} from "./state.js";
import type { AudienceLists, BroadcastRecord, EntryLike, Selection, Settings } from "./types.js";
import {
    audienceLabel,
    banner,
    fmtTime,
    NONE_VALUE,
    resendBroadcastUrl,
    settingsLink,
} from "./ui.js";
import type { CollectionSchemaInfo } from "emdash";

type Toast = NonNullable<BlockResponse["toast"]>;

interface PanelEnv {
    ctx: PluginContext;
    settings: Settings;
    client: ResendClient | null;
    collection: CollectionSchemaInfo;
    entry: EntryLike;
    user: SandboxedRouteContext["user"];
    lists: AudienceLists | null;
    listError: string | null;
}

interface PanelInput {
    type?: string;
    action_id?: string;
    value?: unknown;
    values?: Record<string, unknown>;
}

const ok = (message: string): Toast => ({ message, type: "success" });
const fail = (message: string): Toast => ({ message, type: "error" });

function asInput(value: unknown): PanelInput {
    return value && typeof value === "object" ? (value as PanelInput) : {};
}

async function fetchLists(
    ctx: PluginContext,
    client: ResendClient | null,
    force: boolean,
): Promise<{ lists: AudienceLists | null; error: string | null }> {
    if (!client) return { lists: null, error: null };
    try {
        return { lists: await loadAudience(ctx, client, force), error: null };
    } catch (error) {
        return { lists: null, error: describeResendError(error) };
    }
}

export async function handlePanel(
    routeCtx: SandboxedRouteContext,
    rawCtx: PluginContext,
): Promise<BlockResponse> {
    const ctx = frugal(rawCtx);
    const ref = routeCtx.ui?.entry;
    if (!ref) return { blocks: [banner("Open this panel from a saved entry.", "alert")] };

    const settings = await loadSettings(ctx);
    if (!settings.enabledCollections.includes(ref.collection)) {
        return {
            blocks: [
                banner("Broadcasts are not enabled for this collection.", "default"),
                settingsLink("Enable it in settings"),
            ],
        };
    }

    const [collection, item] = await Promise.all([
        getCollectionInfo(ctx, ref.collection),
        content(ctx).get(ref.collection, ref.id),
    ]);
    const entry = toEntry(item);
    if (!collection || !entry) {
        return { blocks: [banner("This entry could not be loaded.", "error")] };
    }

    const client = clientFor(ctx, settings);
    const input = asInput(routeCtx.input);
    const isAction = input.type === "block_action" || input.type === "form_submit";

    const { lists, error: listError } = await fetchLists(ctx, client, input.action_id === "reload");
    const env: PanelEnv = { ctx, settings, client, collection, entry, user: routeCtx.user, lists, listError };

    let toast: Toast | undefined;
    if (isAction && input.action_id) {
        toast = await runAction(env, input.action_id, input.values ?? {}, input.value);
    }

    // Re-read after an action so the view reflects the new state.
    const fresh = isAction ? toEntry(await content(ctx).get(ref.collection, ref.id)) : entry;
    env.entry = fresh ?? entry;

    const blocks = await renderPanel(env);
    return toast ? { blocks, toast } : { blocks };
}

async function runAction(
    env: PanelEnv,
    action: string,
    values: Record<string, unknown>,
    value: unknown,
): Promise<Toast> {
    const { ctx, settings, collection, entry } = env;
    const status = entry.status;

    switch (action) {
        case "reload":
            return env.listError ? fail(env.listError) : ok("Segments and topics reloaded.");

        case "save":
            return saveChoices(env, values);

        case "segment":
        case "topic":
            return saveAudience(env, action, value);

        case "revoke":
        case "change":
            await revokeApproval(ctx, collection.slug, entry.id);
            return ok(action === "revoke" ? "Scheduled broadcast cancelled." : "Unscheduled. Make your changes and schedule the broadcast again.");

        case "approve":
        case "send_now": {
            if (!env.client) return fail("Add a Resend API key in settings.");
            if (env.listError) return fail(env.listError);
            const now = action === "send_now";
            if (now && status !== "published") return fail("The entry is not published.");
            if (!now && status !== "scheduled") return fail("The entry is not scheduled.");

            const prep = await prepare(ctx, settings, collection, entry, env.lists);
            const approved = await approveEntry(
                ctx,
                settings,
                prep,
                entry,
                env.user,
                now ? null : (entry.scheduledAt ?? null),
            );
            if (!approved.ok) return fail(approved.errors.join(" "));
            if (!now) return ok("Broadcast scheduled. It sends when the entry publishes.");

            const result = await sendRecord(ctx, settings, collection, entry);
            return result.ok ? ok("Broadcast sent.") : fail(result.message);
        }

        case "retry": {
            if (status !== "published") return fail("The entry is not published.");
            const result = await sendRecord(ctx, settings, collection, entry, { retry: true });
            return result.ok ? ok("Broadcast sent.") : fail(result.message);
        }

        case "test_email": {
            if (!env.client) return fail("Add a Resend API key in settings.");
            if (!settings.fromAddress) return fail("Set the From address in settings.");
            const typed = str(values.test_to, 254);
            const to = typed || env.user?.email;
            if (!to) return fail("Your account has no email address. Enter one to send the test to.");
            if (!EMAIL_PATTERN.test(to)) return fail("Enter a valid email address.");
            const prep = await prepare(ctx, settings, collection, entry, env.lists);
            if (prep.render.errors.length > 0) return fail(prep.render.errors.join(" "));
            try {
                await env.client.sendEmail({
                    from: settings.fromAddress,
                    to,
                    subject: `[Test] ${prep.subject}`,
                    html: prep.render.html,
                    text: prep.render.text,
                });
                return ok(`Test email sent to ${to}.`);
            } catch (error) {
                return fail(describeResendError(error));
            }
        }

        default:
            return fail("Unknown action.");
    }
}

function str(value: unknown, max: number): string {
    return typeof value === "string" ? value.trim().slice(0, max) : "";
}

const EMAIL_PATTERN = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

async function saveChoices(env: PanelEnv, values: Record<string, unknown>): Promise<Toast> {
    const { ctx, collection, entry, lists } = env;
    const prep = await prepare(ctx, env.settings, collection, entry, lists);
    const subject = str(values.subject, 200);
    if (!subject && !prep.defaultSubject) return fail("Enter a subject.");
    const preheader = str(values.preheader, 200);

    const { segmentId, topicId } = prep.selection;
    const selection: Selection = {
        ...(segmentId !== undefined ? { segmentId } : {}),
        ...(topicId !== undefined ? { topicId } : {}),
        ...(subject && subject !== prep.defaultSubject ? { subject } : {}),
        ...(preheader && preheader !== prep.defaultPreheader ? { preheader } : {}),
        ...(values.show_subject === true ? { showSubject: true } : {}),
    };
    await saveSelection(ctx, collection.slug, entry.id, selection);
    // Changing the choices invalidates any earlier approval.
    await revokeApproval(ctx, collection.slug, entry.id);
    return ok("Saved. Review the email, then schedule or send it.");
}

async function saveAudience(env: PanelEnv, field: "segment" | "topic", value: unknown): Promise<Toast> {
    const { ctx, collection, entry, lists } = env;
    if (!lists) return fail(env.listError ?? "Segments could not be loaded.");
    const chosen = str(value, 100);
    const known = field === "segment" ? lists.segments : lists.topics;
    if (chosen !== NONE_VALUE && !known.some((item) => item.id === chosen)) {
        return fail(`That ${field} no longer exists.`);
    }
    const current = await getSelection(ctx, collection.slug, entry.id);
    const stored = chosen === NONE_VALUE ? "" : chosen;
    await saveSelection(ctx, collection.slug, entry.id, {
        ...current,
        ...(field === "segment" ? { segmentId: stored } : { topicId: stored }),
    });
    await revokeApproval(ctx, collection.slug, entry.id);
    return ok(field === "segment" ? "Segment saved." : "Topic saved.");
}

function summary(record: BroadcastRecord): Block {
    const fields = [
        { label: "Segment", value: record.segmentName },
        ...(record.topicName ? [{ label: "Topic", value: record.topicName }] : []),
        { label: "Subject", value: record.subject },
    ];
    if (record.status === "approved") {
        fields.push({ label: "Scheduled by", value: `${record.approvedBy}, ${fmtTime(record.approvedAt)}` });
        fields.push({
            label: "Sends",
            value: record.sendAfter ? `When the entry publishes (${fmtTime(record.sendAfter)})` : "Now",
        });
    }
    if (record.status === "sent") {
        fields.push({ label: "Sent", value: fmtTime(record.sentAt) });
        fields.push({ label: "Sent by", value: record.approvedBy });
    }
    return { type: "fields", fields };
}

async function renderPanel(env: PanelEnv): Promise<Block[]> {
    const { ctx, settings, collection, entry } = env;
    const blocks: Block[] = [];

    if (!env.client) {
        return [banner("Add a Resend API key to send broadcasts.", "alert"), settingsLink()];
    }

    let record = await getRecord(ctx, collection.slug, entry.id);
    if (record?.status === "sending") record = await reconcileStale(ctx, settings, record);
    if (record?.status === "inactive") record = null;

    if (record?.status === "sent") {
        blocks.push(banner("A broadcast has been sent for this entry.", "default", "Sent"));
        blocks.push(summary(record));
        if (record.broadcastId) {
            blocks.push({
                type: "actions",
                elements: [
                    {
                        type: "link",
                        label: "View in Resend",
                        target: { kind: "external", url: resendBroadcastUrl(record.broadcastId) },
                        appearance: "secondary",
                    },
                ],
            });
        }
        return blocks;
    }

    if (record?.status === "sending") {
        return [
            banner("The broadcast is being sent. Reopen this panel in a moment.", "default", "Sending"),
            summary(record),
        ];
    }

    if (record?.status === "approved") {
        blocks.push(
            banner(
                record.sendAfter
                    ? "This broadcast is scheduled and sends automatically when the entry publishes. Editing the entry cancels it."
                    : "This broadcast is queued to send.",
                "default",
                "Scheduled",
            ),
        );
        blocks.push(summary(record));
        blocks.push({
            type: "actions",
            elements: [
                { type: "button", action_id: "change", label: "Edit", style: "secondary" },
                {
                    type: "button",
                    action_id: "revoke",
                    label: "Cancel scheduled broadcast",
                    style: "danger",
                    confirm: {
                        title: "Cancel scheduled broadcast?",
                        text: "The email will not be sent when the entry publishes.",
                        confirm: "Cancel broadcast",
                        deny: "Keep scheduled",
                        style: "danger",
                    },
                },
            ],
        });
        return blocks;
    }

    if (record?.status === "lapsed") {
        blocks.push(
            banner(
                "The entry changed after the broadcast was scheduled, so it was cancelled. Review the email and schedule it again.",
                "alert",
                "Scheduled broadcast cancelled",
            ),
        );
    } else if (record?.status === "failed") {
        blocks.push(
            banner(record.error ?? "The send failed.", "error", "Sending failed"),
        );
    }

    if (env.listError) {
        blocks.push(banner(env.listError, "error", "Could not load segments"));
        blocks.push({
            type: "actions",
            elements: [{ type: "button", action_id: "reload", label: "Try again", style: "secondary" }],
        });
        return blocks;
    }
    const lists = env.lists;
    if (!lists) return blocks;

    const prep = await prepare(ctx, settings, collection, entry, lists);
    blocks.push(...audienceBlocks(env, prep, lists));
    blocks.push({ type: "divider" });
    if (prep.render.errors.length === 0) {
        blocks.push(testForm(env));
        blocks.push({ type: "divider" });
    }
    blocks.push(contentForm(prep));
    blocks.push(...emailBlocks(prep, env.entry.status));
    blocks.push(...actionButtons(env, prep, record));
    return blocks;
}

function audienceBlocks(env: PanelEnv, prep: Prepared, lists: AudienceLists): Block[] {
    const { settings } = env;
    const segmentOptions = [
        { label: "Choose a segment", value: NONE_VALUE },
        ...lists.segments.map((s) => ({ label: s.name, value: s.id })),
    ];
    const topicOptions = [
        { label: "No topic", value: NONE_VALUE },
        ...lists.topics.map((t) => ({ label: t.name, value: t.id })),
    ];
    const audience = resolveAudience(settings, prep.selection, lists);
    const segmentValue = segmentOptions.some((o) => o.value === audience?.segmentId)
        ? (audience?.segmentId as string)
        : NONE_VALUE;
    const topicValue = topicOptions.some((o) => o.value === audience?.topicId)
        ? (audience?.topicId as string)
        : NONE_VALUE;

    // Standalone selects save as soon as they change; selects inside a form wait for its submit.
    return [
        {
            type: "actions",
            block_id: "audience",
            elements: [
                {
                    type: "select",
                    action_id: "segment",
                    label: "Segment",
                    options: segmentOptions,
                    initial_value: segmentValue,
                },
                {
                    type: "select",
                    action_id: "topic",
                    label: "Topic (optional)",
                    options: topicOptions,
                    initial_value: topicValue,
                },
                { type: "button", action_id: "reload", label: "↻ Reload segments and topics", style: "secondary" },
            ],
        },
    ];
}

function testForm(env: PanelEnv): Block {
    return {
        type: "form",
        block_id: "test",
        fields: [
            {
                type: "text_input",
                action_id: "test_to",
                label: "Send a test email to",
                placeholder: env.user?.email ?? "name@example.com",
            },
        ],
        submit: { label: "✉ Send test email", action_id: "test_email" },
    };
}

function contentForm(prep: Prepared): Block {
    return {
        type: "form",
        block_id: "choices",
        fields: [
            {
                type: "text_input",
                action_id: "subject",
                label: "Subject",
                placeholder: prep.defaultSubject,
                initial_value: prep.selection.subject ?? "",
            },
            {
                type: "text_input",
                action_id: "preheader",
                label: "Preview text",
                placeholder: prep.defaultPreheader,
                initial_value: prep.selection.preheader ?? "",
            },
            {
                type: "toggle",
                action_id: "show_subject",
                label: "Show subject and preview text at the top of the email",
                description: "Off: they only appear in the inbox list. On: they also head the email body.",
                initial_value: prep.selection.showSubject === true,
            },
        ],
        submit: { label: "✓ Save subject and preview text", action_id: "save" },
    };
}

// Block Kit rejects strings over 64 KB, so long sources are cut.
const CODE_LIMIT = 20_000;

function clip(value: string, max: number): string {
    return value.length > max ? `${value.slice(0, max)}\n…` : value;
}

function emailBlocks(prep: Prepared, status: string | undefined): Block[] {
    const blocks: Block[] = [];
    const isLive = status === "published" || status === "scheduled";
    // Send-only blockers (no public URL) are expected on drafts, so the next-step banner covers them.
    const blockers = isLive ? [...prep.render.errors, ...prep.render.sendErrors] : prep.render.errors;
    if (blockers.length > 0) {
        blocks.push(banner(blockers.join(" "), "alert", "This email cannot be sent yet"));
    }
    for (const warning of prep.render.warnings) blocks.push(banner(warning, "default"));
    blocks.push({ type: "context", text: "To see how the email looks, send yourself a test email." });
    blocks.push({
        type: "tab",
        block_id: "email_source",
        panels: [
            { label: "Plain text", blocks: [{ type: "code", code: clip(prep.render.text, CODE_LIMIT) }] },
            { label: "HTML", blocks: [{ type: "code", code: clip(prep.render.html, CODE_LIMIT) }] },
        ],
    });
    return blocks;
}

function actionButtons(env: PanelEnv, prep: Prepared, record: BroadcastRecord | null): Block[] {
    const status = env.entry.status;
    const elements: Extract<Block, { type: "actions" }>["elements"] = [];
    const audience = prep.audience;
    const ready =
        prep.render.errors.length === 0 &&
        prep.render.sendErrors.length === 0 &&
        audience !== null &&
        Boolean(env.settings.fromAddress);
    const target = audience ? audienceLabel(audience) : "";

    if (ready && status === "published") {
        if (record?.status === "failed") {
            elements.push({
                type: "button",
                action_id: "retry",
                label: "Retry broadcast",
                style: "primary",
                confirm: {
                    title: "Retry sending?",
                    text: `This sends the approved email to ${record.segmentName}${record.topicName ? ` (topic: ${record.topicName})` : ""}. Check the Resend dashboard first to be sure the earlier attempt did not go out.`,
                    confirm: "Retry",
                    deny: "Cancel",
                    style: "danger",
                },
            });
        } else {
            elements.push({
                type: "button",
                action_id: "send_now",
                label: "Send broadcast now",
                style: "primary",
                confirm: {
                    title: "Send broadcast now?",
                    text: `This sends “${prep.subject}” to ${target}. It cannot be undone.`,
                    confirm: "Send broadcast",
                    deny: "Cancel",
                    style: "danger",
                },
            });
        }
    } else if (ready && status === "scheduled") {
        elements.push({
            type: "button",
            action_id: "approve",
            label: "Schedule broadcast",
            style: "primary",
            confirm: {
                title: "Schedule this broadcast?",
                text: `“${prep.subject}” will be sent to ${target} when the entry publishes${env.entry.scheduledAt ? ` (${fmtTime(env.entry.scheduledAt)})` : ""}. Editing the entry afterwards cancels it.`,
                confirm: "Schedule broadcast",
                deny: "Cancel",
            },
        });
    }

    const blocks: Block[] = [];
    if (status !== "published" && status !== "scheduled") {
        blocks.push(
            banner(
                "Broadcasts can only be sent or scheduled once the entry is published or scheduled. Until then you can choose the audience, set the subject and preview text, and send test emails.",
                "default",
                "Next step: publish or schedule this entry",
            ),
        );
    } else {
        blocks.push({
            type: "context",
            text: `This entry is ${status === "scheduled" ? `scheduled${env.entry.scheduledAt ? ` for ${fmtTime(env.entry.scheduledAt)}` : ""}` : "published"}. Segment and topic save when you change them. Press “Save subject and preview text” after editing either.`,
        });
    }
    if (elements.length > 0) blocks.push({ type: "actions", elements });
    if ((status === "published" || status === "scheduled") && elements.length === 0) {
        const missing: string[] = [];
        if (!audience) missing.push("choose a segment above");
        if (!env.settings.fromAddress) missing.push("set the From address in settings");
        if (missing.length > 0) {
            blocks.push(
                banner(
                    `To ${status === "scheduled" ? "schedule" : "send"} this broadcast, ${missing.join(" and ")}.`,
                    "default",
                    status === "scheduled" ? "Schedule broadcast" : "Send broadcast",
                ),
            );
        }
    }
    if (!effectiveSiteUrl(env.ctx, env.settings)) {
        blocks.push(banner("No site URL is set, so links and images cannot be resolved. Set one in settings.", "alert"));
    }
    return blocks;
}
