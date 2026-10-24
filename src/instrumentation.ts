export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }

  const { checkServerSetup } = await import("@/lib/server/startup-checks");
  try {
    checkServerSetup();
  } catch (error) {
    // A throw left here keeps the port bound and answers 500 to every request,
    // and systemd sees a healthy unit. Exit instead: nothing serves
    // half-configured, and the unit's restart policy or its failed state
    // tells the operator.
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }

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
}
