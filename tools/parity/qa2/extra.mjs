// Hover scope by pixels, machine lines, top bar tips, forced-row drag, panels that exist on the website.
export default function ({ page, wait, rec, check, shot, nodeSel, focus, idle, section, loadPlan, rectOf, plans, OUT, readPng, path }) {
  const { refChain, drawerPlan } = plans;
  const tipSel = ".tp, .rail-tip, [role=tooltip], .minecraft-tooltip";
  const tipUp = () => page.evaluate((s) => [...document.querySelectorAll(s)].some((e) => e.getBoundingClientRect().width > 0), tipSel);
  const fit = async () => {
    await page.locator('.mb-key:text-is("Fit")').click();
    await wait(900);
  };
  const diffCount = (a, b, x0, y0, x1, y1) => {
    let n = 0;
    for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) { const i = (a.width * y + x) * 4; if (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]) > 30) n++; }
    return n;
  };
  const grab = async (name) => { await page.screenshot({ path: path.join(OUT, name + ".png"), clip: { x: 275, y: 130, width: 1400, height: 940 } }); return readPng(path.join(OUT, name + ".png")); };

  section("hover-scope", async () => {
    await loadPlan(page, drawerPlan);
    await fit();
    await idle();
    await wait(400);
    const base = await grab("scope-base");
    const test = async (label, locate) => {
      const box = await locate();
      if (!box) return rec("hover-scope", label, "FAIL", "target not found");
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await wait(350);
      const hov = await grab("scope-" + label.replace(/\W+/g, "-"));
      const n = diffCount(base, hov, 0, 0, Math.floor(base.width / 2), base.height) + diffCount(base, hov, Math.floor(base.width / 2), 0, base.width, base.height);
      const tot = (base.width * base.height) / 4;
      rec("hover-scope", label, n > 400 ? "PASS" : "FAIL", `${n} of ${Math.round(tot)} sampled pixels change (mod: lights only it, its wires and what they reach)`);
      await idle();
      await wait(250);
    };
    await test("rail row Aniline lights the resource everywhere", () => page.locator(".rail-row", { hasText: "Aniline" }).first().boundingBox());
    await test("hover a card port", () => page.locator(".cc-row[data-port]").nth(2).boundingBox());
    await test("hover a wire", () => page.locator(".react-flow__edge-interaction, .react-flow__edge path").first().boundingBox());
    await test("hover a drawer", () => page.locator(".cd-body").first().boundingBox());
    // (a machine line lights nothing in the mod: its overview hover scope is resource rows only)
  });

  section("machine-lines", async () => {
    await loadPlan(page, refChain);
    await wait(500);
    const pins = () => page.evaluate(() => window.__ccStore.getState().project.nodes.map((n) => n.solvePin ?? null));
    const line = page.locator(".rail-machine .rail-row").first();
    const p0 = await pins();
    await line.locator(".rail-box").hover();
    await page.mouse.wheel(0, -100);
    await wait(500);
    const p1 = await pins();
    check("machine-lines", "wheel on a machine line's count pins it (mod: as the card's count does)", JSON.stringify(p0) !== JSON.stringify(p1), `${JSON.stringify(p0)} -> ${JSON.stringify(p1)}`);
    await line.locator(".rail-box").click();
    await wait(400);
    const edit = await page.evaluate(() => !!document.querySelector("input:focus, .rail-popup input, .rail-box-edit"));
    rec("machine-lines", "click on the count opens a number box (mod)", edit ? "PASS" : "FAIL", String(edit));
    await page.keyboard.press("Escape");
    const eu = await page.evaluate(() => [...document.querySelectorAll(".rail-eu")].map((e) => ({ t: e.textContent, clipped: e.scrollWidth > e.clientWidth + 1 })));
    check("machine-lines", "EU/t text is not clipped on any machine line", eu.every((e) => !e.clipped), JSON.stringify(eu));
    const names = await page.evaluate(() => [...document.querySelectorAll(".rail-name")].map((e) => ({ t: e.textContent, clipped: e.scrollWidth > e.clientWidth + 1, ell: getComputedStyle(e).textOverflow })));
    rec("machine-lines", "long names clip (mod ellipsises: 'Lightly Steam-C...')", names.some((n) => n.clipped && n.ell !== "ellipsis") ? "FAIL" : "PASS", JSON.stringify(names.filter((n) => n.clipped).slice(0, 4)));
    // (the mod's "trash leaves its outputs" is about trash drawers in the totals; the line itself has no trash key)
  });

  section("topbar-tips", async () => {
    await loadPlan(page, refChain);
    const targets = ["Share", "Settings", "Fit", "Library", "Undo", "Redo", "Arrange", "Help", "/s", "EU/t", "Avg"]; // QA3: the mod-style bar renamed its keys
    for (const t of targets) {
      await idle();
      await wait(300);
      const loc = page.locator(`[aria-label="${t}"], [title="${t}"], .mb-key:text-is("${t}")`).first();
      if (!(await loc.count())) { rec("topbar-tips", t, "FAIL", "not found"); continue; }
      const b = await loc.boundingBox();
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
      const t0 = Date.now();
      let first = null;
      for (let i = 0; i < 90 && first === null; i++) { if (await tipUp()) first = Date.now() - t0; else await wait(20); }
      rec("topbar-tips", t, first !== null && first >= 700 && first <= 1050 ? "PASS" : "FAIL", first === null ? "no custom tip within 1.8 s (native title only)" : `${first} ms`);
    }
  });

  section("forced-drag", async () => {
    const ids = await loadPlan(page, plans.forcedPlan);
    await focus(ids.an, 500, 250);
    await idle();
    const row = page.locator(`${nodeSel(ids.an)} .cc-forced`).first();
    if (!(await row.count())) return rec("forced-drag", "setup", "FAIL", "no forced row");
    const b = await row.boundingBox();
    const n0 = await page.evaluate(() => window.__ccStore.getState().project.storages.length);
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x - 150, b.y + b.height / 2 + 120, { steps: 8 });
    await wait(300);
    await shot("forced-row-in-hand", { x: 0, y: 100, width: 1700, height: 980 });
    await page.mouse.up();
    await wait(900);
    const n1 = await page.evaluate(() => window.__ccStore.getState().project.storages.length);
    check("forced-drag", "dragging a forced row out makes a drawer that takes the flow", n1 === n0 + 1, `drawers ${n0} -> ${n1}`);
    const after = await page.locator(`${nodeSel(ids.an)} .cc-forced`).count();
    check("forced-drag", "the Forced row goes once the drawer takes it", after === 0, `forced rows left ${after}`);
    // forced row tooltip wording
    const ids2 = await loadPlan(page, plans.forcedPlan);
    await focus(ids2.an, 500, 250);
    const r2 = page.locator(`${nodeSel(ids2.an)} .cc-forced`).first();
    const b2 = await r2.boundingBox();
    await page.mouse.move(b2.x + 6, b2.y + 6);
    await wait(1300);
    const txt = await page.evaluate((s) => [...document.querySelectorAll(s)].map((e) => e.innerText.replace(/\n/g, " | ")).join(" ## "), tipSel);
    rec("forced-drag", "forced row tooltip", /forced|plan brings|puts in|comes in/i.test(txt) ? "PASS" : "FAIL", txt.slice(0, 300));
  });

  section("panels", async () => {
    await loadPlan(page, refChain);
    await wait(500);
    // screenshot panel
    await page.locator('.mb-key:text-is("Share")').first().click(); await page.getByText('Screenshot...').first().click();
    await wait(1500);
    await shot("screenshot-panel");
    const sp = await page.evaluate(() => document.querySelector("[role=dialog]")?.innerText?.replace(/\n/g, " | ").slice(0, 400) ?? document.body.innerText.slice(0, 100));
    rec("panels", "screenshot panel", "INFO", sp);
    const cardMode = /Detailed/i.test(sp) && /Simple/i.test(sp);
    rec("panels", "screenshot panel offers Detailed / Simple cards and a footer (mod)", cardMode ? "PASS" : "FAIL", sp.slice(0, 160));
    await page.keyboard.press("Escape");
    await wait(400);
    // help menu / tour
    await page.locator('[aria-label="Help"]').first().click();
    await wait(500);
    await shot("help-menu", { x: 1500, y: 0, width: 420, height: 500 });
    const help = await page.evaluate(() => document.body.innerText);
    rec("panels", "help menu offers a tour (mod: Take the tour, 37 steps)", /tour/i.test(help) ? "PASS" : "FAIL", "");
    await page.keyboard.press("Escape");
    // minimap
    rec("panels", "minimap on the board (mod: minimap of the plan last open)", (await page.locator(".mmap").count()) ? "PASS" : "FAIL", `.mmap count ${await page.locator(".mmap").count()}`);
    // see-through
    await page.locator('[aria-label="Settings"]').first().click();
    await wait(600);
    const body = await page.evaluate(() => document.body.innerText);
    await page.keyboard.press("Escape");
    await wait(300);
    rec("panels", "update offer / see-through / pin list text anywhere", /see-through|paper strength|pin list|minimap/i.test(body) ? "PASS" : "FAIL", "");
    // library wording
    await page.locator('.mb-key:text-is("Library")').first().click().catch(() => {});
    await wait(900);
    const lib = await page.evaluate(() => document.body.innerText);
    rec("panels", "library words (mod: plans, not designs; two shelves My plans / public setups)", /My plans/i.test(lib) ? "PASS" : "FAIL", /My designs/i.test(lib) ? "says 'My designs'" : "");
    await page.locator('.mb-key:text-is("Board")').first().click().catch(() => {});
    await wait(500);
  });
}
