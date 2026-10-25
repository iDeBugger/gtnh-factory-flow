import { afterEach, describe, expect, it, vi } from "vitest";
import { DatasetNotFoundError, getDatasetCatalog } from "@/lib/server/dataset-query";
import { GET } from "./route";

vi.mock("@/lib/server/dataset-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/dataset-query")>();
  return {
    DatasetNotFoundError: actual.DatasetNotFoundError,
    prewarmDatasetVersion: vi.fn(async () => {
      throw new actual.DatasetNotFoundError();
    }),
    getDatasetCatalog: vi.fn(async () => {
      throw new actual.DatasetNotFoundError();
    }),
  };
});

const call = (versionId: string) =>
  GET(new Request(`http://localhost/api/datasets/${encodeURIComponent(versionId)}/catalog`), {
    params: Promise.resolve({ versionId }),
  });

describe("the dataset catalog route", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("answers an unknown dataset id with 404 and a fixed sentence that never repeats the id", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const versionId of ["does-not-exist", "<b>x</b>"]) {
      const response = await call(versionId);
      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body).toEqual({ error: "Dataset not found." });
      expect(JSON.stringify(body)).not.toContain(versionId);
    }
    expect(new DatasetNotFoundError().name).toBe("DatasetNotFoundError");
    // The background prewarm of an unserved id logs nothing: the id is request text.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(log).not.toHaveBeenCalled();
  });

  it("answers any other failure with its fallback sentence, and the error goes to the log only", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(getDatasetCatalog).mockRejectedValueOnce(new Error("ENOENT: /opt/releases/x"));
    const response = await call("local-2.9.0-rc-2");
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Dataset catalog failed." });
    expect(log).toHaveBeenCalled();
  });
});
