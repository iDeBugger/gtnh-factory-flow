/**
 * One HTTP exchange with the request target sent byte for byte.
 *
 * `fetch` and `new URL` normalize a path (dot segments, backslashes, repeated
 * slashes), so a case that tests how a server answers an odd spelling has to
 * go out through `node:http` with the target as the raw `path`. `setHost:
 * false` adds no Host header the case did not name, and `agent: false` opens a
 * socket per exchange, so no answer depends on an earlier one's connection.
 *
 * Over TLS the name in `base` is the SNI and the certificate name. An IP
 * literal gets no SNI: TLS cannot carry one, and Node warns (DEP0123) when
 * asked to. Certificates are checked against the system store or `ca`; there
 * is no switch that turns the check off.
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";

const WRITE_CHUNK = 64 * 1024;

/** Errors a server's early close causes on the request side; once its answer has begun they are not a failure. */
const CLOSED_BY_PEER = new Set(["EPIPE", "ECONNRESET", "ERR_STREAM_DESTROYED"]);

function headerPairs(headers) {
  if (!headers) return [];
  if (Array.isArray(headers)) return headers.map(([name, value]) => [String(name), String(value)]);
  return Object.entries(headers).map(([name, value]) => [name, String(value)]);
}

function hasHeader(pairs, name) {
  return pairs.some(([key]) => key.toLowerCase() === name);
}

/**
 * @param {import("./requests.d.mts").RawRequest} options
 * @returns {Promise<import("./requests.d.mts").RawAnswer>}
 */
export function rawRequest(options) {
  const {
    base,
    method = "GET",
    target,
    headers,
    body,
    chunks,
    chunkDelayMs = 0,
    timeoutMs = 30_000,
    strict = false,
    ca,
    lookup,
  } = options;
  const url = new URL(base);
  const secure = url.protocol === "https:";
  if (!secure && url.protocol !== "http:") {
    return Promise.reject(new Error(`rawRequest: unsupported base ${base}`));
  }
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  const port = url.port ? Number(url.port) : secure ? 443 : 80;

  const pairs = headerPairs(headers);
  const parts = chunks
    ? chunks.map((chunk) => Buffer.from(chunk))
    : body === undefined
      ? []
      : [Buffer.from(body)];
  // A plain body goes out with its length; chunks go out with Transfer-Encoding: chunked unless the case says otherwise.
  if (
    !chunks &&
    body !== undefined &&
    !hasHeader(pairs, "content-length") &&
    !hasHeader(pairs, "transfer-encoding")
  ) {
    pairs.push(["Content-Length", String(parts[0].length)]);
  }
  if (chunks && !hasHeader(pairs, "content-length") && !hasHeader(pairs, "transfer-encoding")) {
    pairs.push(["Transfer-Encoding", "chunked"]);
  }

  const requestOptions = {
    host,
    port,
    method,
    path: target,
    headers: pairs.flat(),
    setHost: false,
    agent: false,
  };
  if (lookup) requestOptions.lookup = lookup;
  if (secure) {
    if (!net.isIP(host)) requestOptions.servername = host;
    if (ca) requestOptions.ca = ca;
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let answer;
    let bytesSent = 0;
    let finishedWriting = parts.length === 0;
    let socketClosedEarly = false;
    const bodyParts = [];

    const timer = setTimeout(() => {
      fail(new Error(`rawRequest: no whole answer within ${timeoutMs} ms (${method} ${target})`));
      request.destroy();
    }, timeoutMs);

    function done() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // An answer that arrived before the body was all sent ends the exchange: the rest is never sent.
      if (!finishedWriting) socketClosedEarly = true;
      resolve(result());
      request.destroy();
    }
    function fail(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    }
    function result() {
      return {
        status: answer.statusCode,
        headers: pairsOf(answer.rawHeaders),
        body: Buffer.concat(bodyParts),
        bytesSent,
        socketClosedEarly,
      };
    }
    function cutShort(error) {
      if (!answer) {
        fail(error);
        return;
      }
      if (strict) {
        fail(
          new Error(
            `rawRequest: the answer was cut short (${error?.code ?? error?.message ?? "closed"})`,
          ),
        );
        return;
      }
      done();
    }

    const request = (secure ? https : http).request(requestOptions, (response) => {
      answer = response;
      response.on("data", (chunk) => bodyParts.push(chunk));
      response.on("end", () => done());
      response.on("aborted", () => cutShort(new Error("aborted")));
      response.on("error", (error) => cutShort(error));
      response.on("close", () => {
        if (!response.complete) cutShort(new Error("closed"));
      });
    });

    request.on("error", (error) => {
      if (!finishedWriting) socketClosedEarly = true;
      if (!answer) {
        fail(error);
        return;
      }
      if (!CLOSED_BY_PEER.has(error.code)) {
        cutShort(error);
        return;
      }
      // The server closed while the body was still going out: the status and whatever arrived still count, and
      // the answer's own end or close decides the rest.
      if (answer.complete) done();
    });
    request.on("close", () => {
      if (!finishedWriting) socketClosedEarly = true;
      if (!answer)
        fail(new Error(`rawRequest: the socket closed before an answer (${method} ${target})`));
    });

    writeBody(
      request,
      parts,
      chunks ? chunkDelayMs : 0,
      (count) => {
        bytesSent += count;
      },
      () => {
        finishedWriting = true;
      },
    ).catch(() => {
      if (!settled) socketClosedEarly = true;
    });
  });
}

async function writeBody(request, parts, delayMs, sent, finished) {
  for (let index = 0; index < parts.length; index += 1) {
    if (index > 0 && delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    const part = parts[index];
    for (let offset = 0; offset < part.length; offset += WRITE_CHUNK) {
      if (request.destroyed) throw new Error("destroyed");
      const slice = part.subarray(offset, offset + WRITE_CHUNK);
      await new Promise((resolve, reject) => {
        request.write(slice, (error) => (error ? reject(error) : resolve()));
      });
      sent(slice.length);
    }
  }
  if (request.destroyed) throw new Error("destroyed");
  await new Promise((resolve) =>
    request.end(() => {
      finished();
      resolve();
    }),
  );
}

function pairsOf(raw) {
  const out = [];
  for (let index = 0; index < raw.length; index += 2)
    out.push([raw[index].toLowerCase(), raw[index + 1]]);
  return out;
}
