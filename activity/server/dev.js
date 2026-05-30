import { loadEnvFile } from "./env.js";

loadEnvFile();
process.env.ACTIVITY_ALLOW_INSECURE_DEV ??= "1";
await import("./index.js");
