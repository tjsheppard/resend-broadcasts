import type { PluginContext } from "emdash/plugin";

/**
 * `content`, `schema` and `http` only exist when the matching capability was
 * granted. The manifest declares all three, so a missing one is a host/config
 * error that should fail loudly.
 */
export function content(ctx: PluginContext): NonNullable<PluginContext["content"]> {
    if (!ctx.content) throw new Error("The content:read capability is not granted.");
    return ctx.content;
}

export function schema(ctx: PluginContext): NonNullable<PluginContext["schema"]> {
    if (!ctx.schema) throw new Error("The schema:read capability is not granted.");
    return ctx.schema;
}

export function http(ctx: PluginContext): NonNullable<PluginContext["http"]> {
    if (!ctx.http) throw new Error("The network:request capability is not granted.");
    return ctx.http;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Every settings, KV and schema call counts toward the sandbox's 30 bridge calls
 * per invocation. Within one invocation this serves repeated reads from memory
 * and skips writes that would not change anything.
 */
export function frugal(ctx: PluginContext): PluginContext {
    const single = new Map<string, unknown>();
    const fetching = new Map<string, Promise<unknown>>();
    let all: Map<string, unknown> | undefined;
    let listing: Promise<unknown> | undefined;
    const kvCache = new Map<string, unknown>();
    let collections: ReturnType<NonNullable<PluginContext["schema"]>["listCollections"]> | undefined;

    const settings: PluginContext["settings"] = {
        ...ctx.settings,
        async get(key: string) {
            if (single.has(key)) return single.get(key) as never;
            let pending = fetching.get(key);
            if (!pending) {
                pending = ctx.settings.get(key).then((value) => (single.set(key, value), value));
                fetching.set(key, pending);
            }
            return (await pending) as never;
        },
        async list(prefix?: string) {
            if (prefix !== undefined) return ctx.settings.list(prefix);
            listing ??= ctx.settings
                .list()
                .then((items) => (all = new Map(items.map((item) => [item.key, item.value]))));
            await listing;
            return [...(all as Map<string, unknown>)].map(([key, value]) => ({ key, value }));
        },
        async set(key: string, value: unknown) {
            const known = single.has(key) ? single.get(key) : all?.get(key);
            const absent = single.has(key) ? single.get(key) == null : all ? !all.has(key) : false;
            // An empty string reads back the same as a missing key in this plugin.
            if (absent ? value === "" : same(known, value)) return;
            await ctx.settings.set(key, value);
            single.set(key, value);
            all?.set(key, value);
        },
        async delete(key: string) {
            const present = single.has(key) ? single.get(key) != null : all ? all.has(key) : true;
            if (!present) return false;
            const result = await ctx.settings.delete(key);
            single.set(key, null);
            all?.delete(key);
            return result;
        },
    };

    const kv: PluginContext["kv"] = {
        ...ctx.kv,
        async get(key: string) {
            if (kvCache.has(key)) return kvCache.get(key) as never;
            const value = await ctx.kv.get(key);
            kvCache.set(key, value);
            return value as never;
        },
        async set(key: string, value: unknown) {
            await ctx.kv.set(key, value);
            kvCache.set(key, value);
        },
        async delete(key: string) {
            const result = await ctx.kv.delete(key);
            kvCache.set(key, null);
            return result;
        },
    };

    const result: PluginContext = { ...ctx, settings, kv };
    if (ctx.schema) {
        const original = ctx.schema;
        result.schema = { ...original, listCollections: () => (collections ??= original.listCollections()) };
    }
    return result;
}
