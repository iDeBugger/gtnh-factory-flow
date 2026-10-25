import { afterEach, describe, expect, it, vi } from "vitest";
import { answerVersionToken, DATASET_ANSWER_VERSION } from "@/lib/datasets/answer-version";
import { datasetCacheHeaders } from "./dataset-cache-headers";

const base = "http://localhost/api/datasets/local-2.9.0-rc-2/resources?query=steel";
const control = (url: string) => datasetCacheHeaders(new Request(url))["Cache-Control"];

describe("the cache policy of a dataset answer", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is immutable only with the dataset hash and this release's answer version", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(control(`${base}&datasetHash=abc&appVersion=${DATASET_ANSWER_VERSION}`)).toBe(
      "public, max-age=31536000, immutable",
    );
  });

  it("is never stored without the answer version, or with another release's", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(control(`${base}&datasetHash=abc`)).toBe("no-store");
    expect(control(`${base}&datasetHash=abc&appVersion=0.0.0-old`)).toBe("no-store");
    expect(control(`${base}&appVersion=${DATASET_ANSWER_VERSION}`)).toBe("no-store");
  });

  it("is never stored outside production", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(control(`${base}&datasetHash=abc&appVersion=${DATASET_ANSWER_VERSION}`)).toBe(
      "no-store",
    );
  });
});

describe("the answer version", () => {
  it("is the build, so two builds of one release never share a cached answer", () => {
    expect(answerVersionToken("4.4.1", "4.4.1-5efe0a3c")).toBe("4.4.1-5efe0a3c");
    expect(answerVersionToken("4.4.1", "4.4.1-720dec8b")).not.toBe(
      answerVersionToken("4.4.1", "4.4.1-5efe0a3c"),
    );
  });

  it("falls back to the release when a build names none", () => {
    expect(answerVersionToken("4.4.1", undefined)).toBe("4.4.1");
    expect(answerVersionToken("4.4.1", " ")).toBe("4.4.1");
  });
});
