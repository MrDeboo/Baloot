# Vendored Discord Embedded App SDK

This directory vendors the browser ESM output from `@discord/embedded-app-sdk`
version `2.5.0`.

The Activity client is intentionally static and dependency-free at runtime, so
the SDK is served from this app instead of being imported from an external CDN.
That keeps Discord's sandboxed Activity iframe from depending on an extra URL
mapping for SDK code.
