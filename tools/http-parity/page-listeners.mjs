/**
 * The page checks browser-check.mjs and the deploy's smoke test share: what broke the document policy, and what
 * React or the browser said about hydration or the policy.
 */

/**
 * An init script, installed before any page script: every `securitypolicyviolation` is recorded in
 * `window.__pagePolicy` as `<directive> blocked <uri or "inline"> <sample>`.
 */
export function policyListener() {
  const violations = [];
  Object.defineProperty(window, "__pagePolicy", { value: violations });
  document.addEventListener("securitypolicyviolation", (event) => {
    violations.push(
      `${event.violatedDirective} blocked ${event.blockedURI || "inline"} ${event.sample || ""}`.trim(),
    );
  });
}

/** React's production errors for a hydration mismatch, and any message that names hydration. */
export const HYDRATION = /hydrat|Minified React error #(418|419|421|422|423|425)\b/i;

/**
 * Reports each console message that names hydration and each console error about the policy.
 *
 * @param {import("playwright-core").Page} page
 * @param {(finding: string) => void} report
 */
export function watchConsole(page, report) {
  page.on("console", (message) => {
    const text = message.text();
    if (HYDRATION.test(text)) report(`hydration: ${text}`);
    if (message.type() === "error" && /Content.Security.Policy|CSP/i.test(text)) {
      report(`policy console error: ${text}`);
    }
  });
}

/**
 * The violations recorded so far on the page.
 *
 * @param {import("playwright-core").Page} page
 * @returns {Promise<string[]>}
 */
export function policyViolations(page) {
  return page.evaluate(() => [...(window.__pagePolicy ?? [])]);
}

/**
 * Takes the violations recorded so far on the page out of its record, so a later read reports only newer ones.
 * Read before every navigation and before the context closes: a navigation drops the record with the document.
 *
 * @param {import("playwright-core").Page} page
 * @returns {Promise<string[]>}
 */
export function drainPolicyViolations(page) {
  return page.evaluate(() => (window.__pagePolicy ?? []).splice(0));
}

/**
 * Records a worker's own policy violations, which fire on the worker's global scope, not on the document. Attached
 * when Playwright reports the worker, so it sees what the worker does from then on (its fetches, the wasm, later
 * imports); a worker that has closed takes its record with it.
 *
 * @param {import("playwright-core").Worker} worker
 */
export async function watchWorkerPolicy(worker) {
  await worker.evaluate(() => {
    if (self.__workerPolicy) return;
    const violations = [];
    Object.defineProperty(self, "__workerPolicy", { value: violations });
    self.addEventListener("securitypolicyviolation", (event) => {
      violations.push(
        `${event.violatedDirective} blocked ${event.blockedURI || "inline"} ${event.sample || ""}`.trim(),
      );
    });
  });
}

/**
 * Takes the violations a watched worker recorded so far out of its record. A worker that has closed reads as none.
 *
 * @param {import("playwright-core").Worker} worker
 * @returns {Promise<string[]>}
 */
export async function drainWorkerPolicy(worker) {
  try {
    return await worker.evaluate(() => (self.__workerPolicy ?? []).splice(0));
  } catch {
    return [];
  }
}
