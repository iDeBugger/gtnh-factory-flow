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
