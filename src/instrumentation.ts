export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }

  // A failed check ends the process (startup-checks.ts explains why).
  const { checkServerSetupOrExit } = await import("@/lib/server/startup-checks");
  checkServerSetupOrExit();

  if (process.env.GTNH_PREWARM_ON_STARTUP !== "1") {
    return;
  }

  const { prewarmDatasetVersions } = await import("@/lib/server/dataset-query");
  try {
    // Resolves once the default version is warm; the others follow in the background.
    await prewarmDatasetVersions();
    console.info("GTNH default dataset prewarmed; other versions load in the background.");
  } catch (error) {
    console.error("GTNH dataset cache prewarm failed.", error);
  }

  // The static answers the browser fetches instead of the API, in the
  // background: requests are not held for them (the client asks the API for
  // a file not written yet). It logs its own failures.
  const { writeServedDatasetClientFiles } = await import("@/lib/server/dataset-client-files");
  void writeServedDatasetClientFiles();
}
