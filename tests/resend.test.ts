import { describe, expect, it } from "vitest";
import { createResendClient, describeResendError, ResendError } from "../src/lib/resend";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function fakeHttp(...responses: Array<Response | Error>) {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const queue = [...responses];
    return {
        calls,
        http: {
            async fetch(url: string, init?: RequestInit) {
                calls.push({ url, init });
                const next = queue.shift();
                if (!next) throw new Error("unexpected request");
                if (next instanceof Error) throw next;
                return next;
            },
        },
    };
}

const noSleep = async () => { };

describe("resend client", () => {
    it("pages through segments", async () => {
        const { http, calls } = fakeHttp(
            json({ data: [{ id: "a", name: "A" }], has_more: true }),
            json({ data: [{ id: "b", name: "B" }], has_more: false }),
        );
        const segments = await createResendClient(http, "key", noSleep).listSegments();
        expect(segments.map((s) => s.id)).toEqual(["a", "b"]);
        expect(calls[1].url).toBe("https://api.resend.com/segments?limit=100&after=a");
    });

    it("sends the broadcast with send:true and snake_case fields", async () => {
        const { http, calls } = fakeHttp(json({ id: "bc_1" }));
        const result = await createResendClient(http, "key", noSleep).createBroadcast({
            segmentId: "seg",
            topicId: "top",
            from: "a@b.c",
            subject: "S",
            html: "<p>x</p>",
            text: "x",
            name: "N",
        });
        expect(result.id).toBe("bc_1");
        const body = JSON.parse(String(calls[0].init?.body));
        expect(body).toMatchObject({ segment_id: "seg", topic_id: "top", send: true, name: "N" });
        expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe("Bearer key");
    });

    it("retries once after a 429", async () => {
        const { http, calls } = fakeHttp(json({ message: "slow" }, 429, { "retry-after": "1" }), json({ data: [] }));
        await createResendClient(http, "key", noSleep).listTopics();
        expect(calls.length).toBe(2);
    });

    it("maps restricted keys to a helpful message without leaking the key", async () => {
        const { http } = fakeHttp(json({ name: "restricted_api_key", message: "nope" }, 401));
        const error = await createResendClient(http, "re_secret", noSleep)
            .listSegments()
            .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ResendError);
        expect(describeResendError(error)).toContain("restricted");
        expect(describeResendError(error)).not.toContain("re_secret");
    });

    it("flags 5xx and network failures on writes as uncertain", async () => {
        const input = { segmentId: "s", from: "a@b.c", subject: "S", html: "h", text: "t", name: "N" };
        const five = fakeHttp(json({ message: "boom" }, 500));
        const e1 = await createResendClient(five.http, "k", noSleep).createBroadcast(input).catch((e: unknown) => e);
        expect((e1 as ResendError).uncertain).toBe(true);

        const net = fakeHttp(new Error("socket closed"));
        const e2 = await createResendClient(net.http, "k", noSleep).createBroadcast(input).catch((e: unknown) => e);
        expect((e2 as ResendError).uncertain).toBe(true);

        const bad = fakeHttp(json({ message: "invalid" }, 422));
        const e3 = await createResendClient(bad.http, "k", noSleep).createBroadcast(input).catch((e: unknown) => e);
        expect((e3 as ResendError).uncertain).toBe(false);
    });

    it("finds a broadcast by its unique name", async () => {
        const { http } = fakeHttp(json({ data: [{ id: "x", name: "other" }, { id: "y", name: "mine" }], has_more: false }));
        const found = await createResendClient(http, "k", noSleep).findBroadcastByName("mine");
        expect(found?.id).toBe("y");
    });
});
