import { boot, loadPlan } from "../lib/app.mjs";
import { nbOne } from "../lib/plans.mjs";
const { browser, page } = await boot();
const ids = await loadPlan(page, nbOne);
await page.waitForTimeout(1500);
const r = await page.evaluate((id) => {
  const st = window.__ccStore.getState();
  const n = st.lastResult?.nodes?.[id];
  const card = document.querySelector(`.react-flow__node[data-id="${id}"]`);
  return {
    util: n?.utilization, need: n?.theoreticalMachinesRequired,
    ins: n && Object.values(n.inputs).map((f) => f.amountPerSecond), plan: st.lastResult?.plan,
    text: card?.innerText, rail: document.querySelector(".rail, [class*=rail]")?.innerText?.slice(0, 1500),
  };
}, ids.nb);
console.log(JSON.stringify(r, null, 1));
await page.screenshot({ path: "tools/parity/s1/single.png" });
await browser.close();
