// Normal Render production startup. Migration jobs are no longer startup paths.
await import("../src/index.ts");
if (process.env.STARTUP_SELF_CHECK === "true") {
  const { verifyWebsite } = await import("./startup-check.mjs");
  await verifyWebsite();
}
