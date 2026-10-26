import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { CONTROL_HEADER, CONTROL_HEADER_VALUE, controlHandler } from "./control.mjs";

let server;
let shutdowns = 0;

async function listen() {
  shutdowns = 0;
  server = createServer(controlHandler({ onShutdown: () => (shutdowns += 1) }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}/__local-db`;
}

afterEach(async () => {
  await new Promise((resolve) => server?.close(resolve));
  server = undefined;
});

describe("the local database's control listener", () => {
  it("answers ready", async () => {
    const base = await listen();
    const response = await fetch(`${base}/ready`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ready");
  });

  it("stops only for a shutdown that carries the control header", async () => {
    const base = await listen();
    // What any web page can send without a preflight.
    const plain = await fetch(`${base}/shutdown`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "",
    });
    expect(plain.status).toBe(403);
    const wrong = await fetch(`${base}/shutdown`, {
      method: "POST",
      headers: { [CONTROL_HEADER]: "0" },
    });
    expect(wrong.status).toBe(403);
    expect(shutdowns).toBe(0);
    const devLocal = await fetch(`${base}/shutdown`, {
      method: "POST",
      headers: { [CONTROL_HEADER]: CONTROL_HEADER_VALUE },
    });
    expect(devLocal.status).toBe(200);
    expect(shutdowns).toBe(1);
  });

  it("answers no preflight, so a browser never sends the header", async () => {
    const base = await listen();
    const preflight = await fetch(`${base}/shutdown`, {
      method: "OPTIONS",
      headers: {
        origin: "https://example.test",
        "access-control-request-method": "POST",
        "access-control-request-headers": CONTROL_HEADER,
      },
    });
    expect(preflight.status).toBe(404);
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
    expect(preflight.headers.get("access-control-allow-headers")).toBeNull();
    expect(shutdowns).toBe(0);
  });
});
