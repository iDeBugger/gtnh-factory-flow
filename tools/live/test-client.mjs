#!/usr/bin/env node
/**
 * A headless client for cloud plans and the live service, for integration
 * tests (the game's among them) and poking at a running site by hand.
 *
 *   node tools/live/test-client.mjs [options] <command> [args]
 *
 * Options (or environment):
 *   --base <url>       the website (GTNH_BASE, default http://localhost:3000)
 *   --live <url>       the live socket (GTNH_LIVE; default ws://localhost:3001/live
 *                      for a localhost base, else wss://<host>/live)
 *   --user <name>      account (GTNH_USER)
 *   --password <pw>    password (GTNH_PASSWORD)
 *   --game <hash>      say hello as the game, from this server hash (web otherwise:
 *                      the socket then carries the base's Origin, as a browser's does)
 *   --for <seconds>    how long `join` listens (default: until Ctrl+C)
 *
 * Commands:
 *   register                       create the account (local development), then sign in
 *   login                          sign in and print who you are
 *   list                           your designs and the plans shared with you
 *   create <name>                  a new design with an empty plan; prints its doc key
 *   share <designId> <username>    share your design with an account (found by search)
 *   unshare <designId> <username>  stop sharing it
 *   search <prefix>                accounts whose name starts with the prefix
 *   read <doc>                     the stored plan (REST, as owner or member)
 *   join <doc>                     connect, join, print every frame as a JSON line;
 *                                  stdin lines are sent: a JSON frame (doc filled in),
 *                                  `ops <json ops array>`, `presence <x> <y> [ids...]`,
 *                                  `leave`, `quit`
 *   send <doc> <json ops array>    join, send one batch, print its echo (or the error)
 *   presence <doc> <x> <y>         join and send one presence frame
 *   nearby <mc names...>           signed-in players in the same game (with --game, after a
 *                                  moment connected) whose Minecraft name is one given, as
 *                                  the game asks with the names on its tab list (here each
 *                                  account plays under its own username)
 *
 * The session is cached per base and user in the system temp folder, so
 * repeated runs do not hit the sign-in rate limit.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import WebSocket from "ws";

function parseArgs(argv) {
  const options = {};
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      options[arg.slice(2)] = argv[i + 1];
      i += 1;
    } else {
      rest.push(arg);
    }
  }
  return { options, rest };
}

const { options, rest } = parseArgs(process.argv.slice(2));
const base = (options.base ?? process.env.GTNH_BASE ?? "http://localhost:3000").replace(/\/+$/, "");
const user = options.user ?? process.env.GTNH_USER;
const password = options.password ?? process.env.GTNH_PASSWORD;
const gameServer = options.game;

function liveUrl() {
  if (options.live ?? process.env.GTNH_LIVE) {
    return options.live ?? process.env.GTNH_LIVE;
  }
  const url = new URL(base);
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
    return `ws://${url.hostname}:3001/live`;
  }
  return `${url.protocol === "https:" ? "wss" : "ws"}://${url.host}/live`;
}

function out(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function die(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Session

const cacheFile = path.join(
  tmpdir(),
  `gtnh-live-client-${createHash("sha256").update(`${base}|${user}`).digest("hex").slice(0, 16)}.json`,
);

function cachedToken() {
  try {
    const cached = JSON.parse(readFileSync(cacheFile, "utf8"));
    const expires = Number(String(cached.token).split(".")[1]);
    return expires > Date.now() + 60_000 ? cached.token : undefined;
  } catch {
    return undefined;
  }
}

async function signIn(route = "login") {
  if (!user || !password) {
    die("Give --user and --password (or GTNH_USER and GTNH_PASSWORD).");
  }
  const response = await fetch(`${base}/api/community/auth/${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: user, password }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    die(`Sign-in failed (${response.status}): ${body.error ?? "no reason given"}`);
  }
  const cookie =
    response.headers.getSetCookie?.().find((line) => line.startsWith("gtnh_session=")) ??
    response.headers.get("set-cookie");
  const token = /gtnh_session=([^;]+)/.exec(cookie ?? "")?.[1];
  if (!token) {
    die("Signed in, but no session cookie came back.");
  }
  writeFileSync(cacheFile, JSON.stringify({ token }));
  return token;
}

let token;
async function session() {
  token ??= cachedToken() ?? (await signIn());
  return token;
}

async function api(method, route, body) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: {
      cookie: `gtnh_session=${await session()}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}

async function me() {
  const whoami = await api("GET", "/api/community/auth/me");
  return { id: String(token).split(".")[0], username: whoami.body?.user?.username };
}

function splitDoc(doc) {
  const colon = String(doc ?? "").indexOf(":");
  if (colon < 0) {
    die(`Not a doc key (<ownerId>:<designId>): ${doc}`);
  }
  return { ownerId: doc.slice(0, colon), designId: doc.slice(colon + 1) };
}

async function findAccount(username) {
  const { body } = await api("GET", `/api/accounts/search?q=${encodeURIComponent(username)}`);
  const account = body.accounts?.find(
    (item) => item.username.toLowerCase() === username.toLowerCase(),
  );
  if (!account) {
    die(`No account named ${username}.`);
  }
  return account;
}

// ---------------------------------------------------------------------------
// Live

function connect() {
  return new Promise((resolve, reject) => {
    void session().then((value) => {
      // A web client sends the site's Origin, as a browser does; the game sends none.
      const origin = gameServer ? {} : { origin: new URL(base).origin };
      const ws = new WebSocket(liveUrl(), {
        headers: { cookie: `gtnh_session=${value}`, ...origin },
      });
      const frames = [];
      const waiters = [];
      ws.on("message", (data) => {
        const frame = JSON.parse(data.toString());
        const at = waiters.findIndex((waiter) => waiter.test(frame));
        if (at >= 0) {
          waiters.splice(at, 1)[0].resolve(frame);
        } else {
          frames.push(frame);
        }
        client.onFrame?.(frame);
      });
      const client = {
        ws,
        onFrame: undefined,
        send: (frame) => ws.send(JSON.stringify(frame)),
        next(test, timeoutMs = 10_000) {
          const found = frames.findIndex(test);
          if (found >= 0) {
            return Promise.resolve(frames.splice(found, 1)[0]);
          }
          return new Promise((done, fail) => {
            const timer = setTimeout(
              () => fail(new Error("timed out waiting for a frame")),
              timeoutMs,
            );
            waiters.push({
              test,
              resolve: (frame) => {
                clearTimeout(timer);
                done(frame);
              },
            });
          });
        },
      };
      ws.once("open", async () => {
        client.send({
          t: "hello",
          v: 1,
          client: gameServer ? "game" : "web",
          clientVersion: "test-client",
          ...(gameServer ? { game: { server: gameServer, mcName: user } } : {}),
        });
        const welcome = await client.next((frame) => frame.t === "welcome" || frame.t === "error");
        if (welcome.t === "error") {
          reject(new Error(`${welcome.code}: ${welcome.msg}`));
          return;
        }
        client.welcome = welcome;
        resolve(client);
      });
      ws.once("unexpected-response", (_req, res) =>
        reject(new Error(`HTTP ${res.statusCode} from ${liveUrl()}`)),
      );
      ws.once("error", reject);
      // Cloudflare drops a socket idle for 100 s.
      setInterval(
        () => ws.readyState === WebSocket.OPEN && client.send({ t: "ping" }),
        25_000,
      ).unref();
    }, reject);
  });
}

async function joined(doc) {
  const client = await connect();
  client.send({ t: "join", doc });
  const snapshot = await client.next(
    (frame) => (frame.t === "snapshot" || frame.t === "error") && frame.doc === doc,
  );
  if (snapshot.t === "error") {
    die(`${snapshot.code}: ${snapshot.msg}`);
  }
  return { client, snapshot };
}

function emptyPlan(name) {
  return {
    schemaVersion: 1,
    id: `plan-${randomUUID()}`,
    name,
    recipes: [],
    nodes: [],
    storages: [],
    edges: [],
    fuelProfiles: [],
  };
}

// ---------------------------------------------------------------------------
// Commands

const [command, ...args] = rest;

switch (command) {
  case "register":
    await signIn("register");
    out(await me());
    break;
  case "login":
    token = await signIn();
    out(await me());
    break;
  case "list": {
    const { body } = await api("GET", "/api/library");
    const id = String(token).split(".")[0];
    out({
      designs: (body.designs ?? [])
        .filter((design) => !design.deletedAt)
        .map((design) => ({
          doc: `${id}:${design.id}`,
          name: design.name,
          members: design.members,
        })),
      shared: (body.shared ?? []).map((design) => ({
        doc: `${design.ownerId}:${design.id}`,
        name: design.name,
        owner: design.ownerName,
        members: design.members,
      })),
    });
    break;
  }
  case "create": {
    const name = args.join(" ") || "Test plan";
    const designId = `design-${randomUUID()}`;
    const stamp = new Date().toISOString();
    const { status, body } = await api("PUT", `/api/library/designs/${designId}`, {
      name,
      icon: null,
      folderId: null,
      closed: false,
      favorite: false,
      order: null,
      communityPlanId: null,
      createdAt: stamp,
      updatedAt: stamp,
      planUpdatedAt: stamp,
      plan: emptyPlan(name),
    });
    if (status !== 200) {
      die(`Create failed (${status}): ${JSON.stringify(body)}`);
    }
    out({ doc: `${String(token).split(".")[0]}:${designId}`, designId, name });
    break;
  }
  case "share":
  case "unshare": {
    const [designId, username] = args;
    const account = await findAccount(username);
    const { status, body } = await api(
      command === "share" ? "PUT" : "DELETE",
      `/api/library/designs/${designId}/members/${account.id}`,
    );
    out({ status, ...body });
    break;
  }
  case "search": {
    const { body } = await api(
      "GET",
      `/api/accounts/search?q=${encodeURIComponent(args[0] ?? "")}`,
    );
    out(body);
    break;
  }
  case "read": {
    const { ownerId, designId } = splitDoc(args[0]);
    const { status, body } = await api("GET", `/api/library/designs/${designId}?owner=${ownerId}`);
    out({ status, ...body });
    break;
  }
  case "join": {
    const doc = args[0];
    const { client, snapshot } = await joined(doc);
    out(snapshot);
    let seq = snapshot.seq;
    client.onFrame = (frame) => {
      if (frame.t === "ops" && frame.seq > seq) {
        seq = frame.seq;
      }
      out(frame);
    };
    client.ws.on("close", (code) => {
      out({ t: "closed", code });
      process.exit(0);
    });
    const lines = readline.createInterface({ input: process.stdin });
    lines.on("line", (line) => {
      const text = line.trim();
      if (!text) {
        return;
      }
      if (text === "quit") {
        client.ws.close();
        return;
      }
      if (text === "leave") {
        client.send({ t: "leave", doc });
        return;
      }
      try {
        if (text.startsWith("ops ")) {
          client.send({
            t: "ops",
            doc,
            base: seq,
            cid: randomUUID().slice(0, 12),
            ops: JSON.parse(text.slice(4)),
          });
        } else if (text.startsWith("presence ")) {
          const [x, y, ...sel] = text.slice(9).trim().split(/\s+/);
          client.send({ t: "presence", doc, cursor: { x: Number(x), y: Number(y) }, sel });
        } else {
          client.send({ doc, ...JSON.parse(text) });
        }
      } catch (error) {
        process.stderr.write(`Not sent: ${error.message}\n`);
      }
    });
    if (options.for) {
      setTimeout(() => client.ws.close(), Number(options.for) * 1000);
    }
    break;
  }
  case "send": {
    const doc = args[0];
    const ops = JSON.parse(args.slice(1).join(" "));
    const { client, snapshot } = await joined(doc);
    const cid = randomUUID().slice(0, 12);
    client.send({ t: "ops", doc, base: snapshot.seq, cid, ops });
    out(
      await client.next((frame) => (frame.t === "ops" || frame.t === "error") && frame.cid === cid),
    );
    client.ws.close();
    break;
  }
  case "presence": {
    const [doc, x, y] = args;
    const { client } = await joined(doc);
    client.send({ t: "presence", doc, cursor: { x: Number(x), y: Number(y) }, sel: [] });
    setTimeout(() => client.ws.close(), 200);
    out({ sent: true });
    break;
  }
  case "nearby": {
    let client;
    if (gameServer) {
      client = await connect();
    }
    const live = new URL(liveUrl());
    const httpBase = `${live.protocol === "wss:" ? "https" : "http"}://${live.host}`;
    const names = encodeURIComponent(args.join(","));
    const response = await fetch(`${httpBase}/live/nearby?names=${names}`, {
      headers: { cookie: `gtnh_session=${await session()}` },
    });
    out({ status: response.status, ...(await response.json()) });
    client?.ws.close();
    break;
  }
  default:
    die(readFileSync(new URL(import.meta.url), "utf8").split("*/")[0]);
}
