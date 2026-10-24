import { afterEach, describe, expect, it, vi } from "vitest";
import { DATASET_ANSWER_VERSION } from "@/lib/datasets/answer-version";
import { datasetClientFileListing } from "@/lib/server/dataset-client-files";
import { GET } from "./route";

vi.mock("@/lib/server/dataset-client-files", () => ({
  datasetClientFileListing: vi.fn(),
}));

const catalog = "/datasets/gtnh/local-2.9.0-rc-2/client/catalog.0123456789abcdef0123.json";

function get(versionId = "local-2.9.0-rc-2") {
  return GET(
    new Request(
      `http://localhost/api/datasets/${versionId}/client-files?datasetHash=abc&appVersion=${DATASET_ANSWER_VERSION}`,
    ),
    { params: Promise.resolve({ versionId }) },
  );
}

describe("the listing of a version's static answers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is cached like a dataset answer once complete, and never while being written", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.mocked(datasetClientFileListing).mockResolvedValueOnce({
      complete: false,
      files: { catalog },
    });
    const partial = await get();
    expect(partial.headers.get("Cache-Control")).toBe("no-store");
    await expect(partial.json()).resolves.toEqual({ complete: false, files: { catalog } });

    vi.mocked(datasetClientFileListing).mockResolvedValueOnce({
      complete: true,
      files: { catalog },
    });
    const complete = await get();
    expect(complete.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
  });

  it("answers 404 for a version the site does not serve", async () => {
    vi.mocked(datasetClientFileListing).mockResolvedValueOnce(undefined);
    const response = await get("made-up");
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});
