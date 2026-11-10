import type { ResendSegment, ResendTopic } from "./types.js";

const API = "https://api.resend.com";

export interface HttpLike {
    fetch(url: string, init?: RequestInit): Promise<Response>;
}

export type ResendErrorCode =
    | "missing_api_key"
    | "restricted_api_key"
    | "invalid_api_key"
    | "rate_limited"
    | "validation_error"
    | "not_found"
    | "server_error"
    | "network_error"
    | "unknown";

export class ResendError extends Error {
    readonly code: ResendErrorCode;
    readonly status: number;
    /** True when the request may have reached Resend and succeeded (network failure or 5xx). */
    readonly uncertain: boolean;

    constructor(code: ResendErrorCode, status: number, message: string, uncertain = false) {
        super(message);
        this.name = "ResendError";
        this.code = code;
        this.status = status;
        this.uncertain = uncertain;
    }
}

interface ListResponse<T> {
    data?: T[];
    has_more?: boolean;
}

export interface CreateBroadcastInput {
    segmentId: string;
    topicId?: string;
    from: string;
    replyTo?: string;
    subject: string;
    html: string;
    text: string;
    name: string;
}

export interface FoundBroadcast {
    id: string;
    status?: string;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function classify(status: number, name: string | undefined): ResendErrorCode {
    if (name === "restricted_api_key") return "restricted_api_key";
    if (name === "missing_api_key") return "missing_api_key";
    if (name === "invalid_api_key") return "invalid_api_key";
    if (status === 401) return "invalid_api_key";
    if (status === 404) return "not_found";
    if (status === 429) return "rate_limited";
    if (status === 400 || status === 422) return "validation_error";
    if (status >= 500) return "server_error";
    return "unknown";
}

/** Short, user-facing description of an error. Never includes the API key. */
export function describeResendError(error: unknown): string {
    if (error instanceof ResendError) {
        switch (error.code) {
            case "restricted_api_key":
                return "The Resend API key is restricted. Use a key with Full access, or one that can read segments and topics and send broadcasts.";
            case "missing_api_key":
            case "invalid_api_key":
                return "Resend rejected the API key. Check it on the Broadcast settings page.";
            case "rate_limited":
                return "Resend is rate limiting requests. Try again in a moment.";
            case "network_error":
                return "Could not reach Resend.";
            default:
                return error.message;
        }
    }
    return error instanceof Error ? error.message : "Unknown error";
}

export function createResendClient(http: HttpLike, apiKey: string, sleep = defaultSleep) {
    async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
        const init: RequestInit = {
            method,
            headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        };

        let response: Response;
        try {
            response = await http.fetch(`${API}${path}`, init);
            if (response.status === 429) {
                const retryAfter = Number(response.headers.get("retry-after"));
                const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 600;
                await sleep(Math.min(wait, 2000));
                response = await http.fetch(`${API}${path}`, init);
            }
        } catch (error) {
            throw new ResendError(
                "network_error",
                0,
                error instanceof Error ? error.message : "Network error",
                method !== "GET",
            );
        }

        let payload: unknown = null;
        try {
            payload = await response.json();
        } catch {
            payload = null;
        }

        if (!response.ok) {
            const record = (payload ?? {}) as { name?: string; message?: string };
            const code = classify(response.status, record.name);
            throw new ResendError(
                code,
                response.status,
                record.message ?? `Resend returned HTTP ${response.status}`,
                response.status >= 500 && method !== "GET",
            );
        }
        return payload as T;
    }

    async function listAll<T extends { id: string }>(path: string, maxPages = 10): Promise<T[]> {
        const items: T[] = [];
        let after: string | undefined;
        for (let page = 0; page < maxPages; page++) {
            const query = `limit=100${after ? `&after=${encodeURIComponent(after)}` : ""}`;
            const response = await request<ListResponse<T>>("GET", `${path}?${query}`);
            const batch = response.data ?? [];
            items.push(...batch);
            const last = batch[batch.length - 1];
            if (!response.has_more || !last) break;
            after = last.id;
        }
        return items;
    }

    return {
        async listSegments(): Promise<ResendSegment[]> {
            const segments = await listAll<{ id: string; name: string }>("/segments");
            return segments.map((s) => ({ id: s.id, name: s.name }));
        },

        async listTopics(): Promise<ResendTopic[]> {
            const topics = await listAll<{ id: string; name: string }>("/topics");
            return topics.map((t) => ({ id: t.id, name: t.name }));
        },

        async createBroadcast(input: CreateBroadcastInput): Promise<{ id: string }> {
            const response = await request<{ id?: string }>("POST", "/broadcasts", {
                segment_id: input.segmentId,
                ...(input.topicId ? { topic_id: input.topicId } : {}),
                from: input.from,
                ...(input.replyTo ? { reply_to: input.replyTo } : {}),
                subject: input.subject,
                html: input.html,
                text: input.text,
                name: input.name,
                send: true,
            });
            if (!response || typeof response.id !== "string" || response.id.length === 0) {
                throw new ResendError(
                    "unknown",
                    200,
                    "Resend did not return a broadcast id",
                    true,
                );
            }
            return { id: response.id };
        },

        /** Look for a broadcast created by an earlier attempt, matched on its unique name. */
        async findBroadcastByName(name: string): Promise<FoundBroadcast | null> {
            const broadcasts = await listAll<{ id: string; name?: string; status?: string }>(
                "/broadcasts",
                3,
            );
            const match = broadcasts.find((b) => b.name === name);
            return match ? { id: match.id, status: match.status } : null;
        },

        async sendEmail(input: {
            from: string;
            to: string;
            subject: string;
            html: string;
            text: string;
        }): Promise<{ id: string }> {
            const response = await request<{ id?: string }>("POST", "/emails", {
                from: input.from,
                to: [input.to],
                subject: input.subject,
                html: input.html,
                text: input.text,
            });
            return { id: response?.id ?? "" };
        },
    };
}

export type ResendClient = ReturnType<typeof createResendClient>;
