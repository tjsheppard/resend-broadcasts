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
