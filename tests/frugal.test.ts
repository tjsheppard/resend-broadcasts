import type { PluginContext } from "emdash/plugin";
import { describe, expect, it, vi } from "vitest";
import { frugal } from "../src/lib/ctx.js";

function fakeCtx(stored: Record<string, unknown> = {}) {
    const calls = { settings: vi.fn(), kv: vi.fn(), schema: vi.fn() };
    const kv = new Map<string, unknown>();
    const ctx = {
        settings: {
            get: async (key: string) => (calls.settings("get", key), stored[key] ?? null),
            list: async () => (calls.settings("list"), Object.entries(stored).map(([key, value]) => ({ key, value }))),
            set: async (key: string, value: unknown) => void (calls.settings("set", key), (stored[key] = value)),
            delete: async (key: string) => (calls.settings("delete", key), delete stored[key]),
        },
        kv: {
            get: async (key: string) => (calls.kv("get", key), kv.get(key) ?? null),
            set: async (key: string, value: unknown) => void (calls.kv("set", key), kv.set(key, value)),
            delete: async (key: string) => (calls.kv("delete", key), kv.delete(key)),
            list: async () => [],
        },
        schema: {
            listCollections: async () => (calls.schema("list"), []),
            getCollection: async () => null,
        },
    } as unknown as PluginContext;
    return { ctx: frugal(ctx), calls, stored };
}

describe("frugal", () => {
    it("reads each setting, kv key and the collection list once", async () => {
        const { ctx, calls } = fakeCtx({ fromAddress: "a@b.co" });
        await Promise.all([ctx.settings.list(), ctx.settings.list(), ctx.settings.get("apiKey"), ctx.settings.get("apiKey")]);
        await ctx.kv.get("cache:audience");
        await ctx.kv.get("cache:audience");
        await ctx.schema?.listCollections();
        await ctx.schema?.listCollections();
        expect(calls.settings).toHaveBeenCalledTimes(2);
        expect(calls.kv).toHaveBeenCalledTimes(1);
        expect(calls.schema).toHaveBeenCalledTimes(1);
    });

    it("skips writes that change nothing and keeps later reads current", async () => {
        const { ctx, calls, stored } = fakeCtx({ fromAddress: "a@b.co", siteUrl: "https://x.co" });
        await ctx.settings.list();
        calls.settings.mockClear();

        await ctx.settings.set("fromAddress", "a@b.co");
        await ctx.settings.set("replyTo", "");
        await ctx.settings.delete("defaultTopicId");
        expect(calls.settings).not.toHaveBeenCalled();

        await ctx.settings.set("siteUrl", "https://y.co");
        expect(stored.siteUrl).toBe("https://y.co");
        const items = await ctx.settings.list();
        expect(items.find((item) => item.key === "siteUrl")?.value).toBe("https://y.co");
        expect(calls.settings).toHaveBeenCalledTimes(1);
    });

    it("sees a kv delete on the next read without another call", async () => {
        const { ctx, calls } = fakeCtx();
        await ctx.kv.set("cache:audience", { a: 1 });
        await ctx.kv.delete("cache:audience");
        calls.kv.mockClear();
        expect(await ctx.kv.get("cache:audience")).toBeNull();
        expect(calls.kv).not.toHaveBeenCalled();
    });
});
