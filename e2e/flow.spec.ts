import { expect, test, type Page } from "@playwright/test";
import { choose, passportFile, passportPhonePhotoFile, payslipFile } from "./fixtures.ts";

/** Every request the browser made, as Playwright sees it (page + workers). */
function recordRequests(page: Page) {
  const seen: { url: string; method: string; body: string }[] = [];
  page.context().on("request", (r) => seen.push({ url: r.url(), method: r.method(), body: r.postData() ?? "" }));
  return seen;
}

const flow = (page: Page) => page.locator("pde-flow");

test("payslip PDF: read on-device, reviewed, sealed — no document data leaves", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const requests = recordRequests(page);
  const { truth, file } = await payslipFile();

  await page.goto("./?req=req_e2e_1&types=payslip");
  await choose(page, "payslip");
  await expect(flow(page).getByText("Your document never leaves this device.")).toBeVisible();
  await expect(flow(page).getByTestId("offline-ready")).toBeVisible();

  await flow(page).getByTestId("file-input").setInputFiles(file);
  await expect(flow(page).getByTestId("review-continue")).toBeEnabled();
  await expect(flow(page).locator("[data-field=net_pay] input")).toHaveValue(truth.net_pay);
  await expect(flow(page).locator("[data-field=gross_pay]")).toContainText("Gross − deductions = net");

  await flow(page).getByTestId("review-continue").click();
  await expect(flow(page).getByTestId("collected-payslip")).toBeVisible();
  await flow(page).getByTestId("to-seal").click();
  await expect(flow(page).getByText("Not shared with AI or Terminal 3 in plain-text.")).toBeVisible();
  await flow(page).getByTestId("seal").click();
  await expect(flow(page).getByTestId("done")).toContainText("You can go back to your chat now.");

  // Dry-run destination: only same-origin GETs for app code and models — the
  // document and its values were never sent anywhere.
  const origin = new URL(page.url()).origin;
  const foreign = requests.filter((r) => !r.url.startsWith(`${origin}/`) && !/^(blob|data):/.test(r.url));
  expect(foreign).toEqual([]);
  expect(requests.filter((r) => r.method !== "GET")).toEqual([]);
  for (const value of [truth.employee_name, truth.net_pay, truth.employer_name]) {
    expect(requests.some((r) => r.body.includes(value) || decodeURIComponent(r.url).includes(value))).toBe(false);
  }
  expect(errors).toEqual([]);
});

test("passport photo: MRZ read and validated on-device", async ({ page }) => {
  const { truth, file } = passportFile();
  await page.goto("./?types=passport");
  await choose(page, "passport");
  await expect(flow(page).getByTestId("offline-ready")).toBeVisible();
  await flow(page).getByTestId("file-input").setInputFiles(file);
  await expect(flow(page).locator("[data-field=document_number] input")).toHaveValue(truth.document_number);
  await expect(flow(page).locator("[data-field=document_number]")).toContainText("Check digits on the document match");
  // Dates are shown as DD-MM-YYYY (stored and sent as ISO).
  const [y, m, d] = truth.date_of_birth.split("-");
  await expect(flow(page).locator("[data-field=date_of_birth] input")).toHaveValue(`${d}-${m}-${y}`);
  await expect(flow(page).locator("[data-field=date_of_birth] label")).toContainText("(DD-MM-YYYY)");
});

test("clicking the upload box opens the file picker", async ({ page }) => {
  const { file } = await payslipFile();
  await page.goto("./?types=payslip");
  await choose(page, "payslip");
  await expect(flow(page).getByTestId("offline-ready")).toBeVisible();
  const chooser = page.waitForEvent("filechooser");
  await flow(page).getByTestId("drop-zone").click();
  await (await chooser).setFiles(file);
  await expect(flow(page).getByTestId("review-continue")).toBeEnabled();
});

test("one Verify all button confirms every highlighted field; dates are edited as DD-MM-YYYY", async ({ page }) => {
  const { file } = await payslipFile(8);
  await page.goto("./?types=payslip");
  await choose(page, "payslip");
  await expect(flow(page).getByTestId("offline-ready")).toBeVisible();
  await flow(page).getByTestId("file-input").setInputFiles(file);
  const payDate = flow(page).locator("[data-field=pay_date] input");
  await expect(flow(page).locator("[data-field=pay_date] label")).toContainText("(DD-MM-YYYY)");
  await payDate.fill("2025-13-45");
  await payDate.blur();
  await expect(flow(page).locator("[data-field=pay_date]")).toContainText("Use DD-MM-YYYY");
  await expect(flow(page).getByTestId("review-continue")).toBeDisabled();
  await payDate.fill("28-02-2025");
  await payDate.blur();
  await expect(flow(page).getByTestId("review-continue")).toBeEnabled();
  await expect(flow(page).locator("input[type=checkbox]")).toHaveCount(0);
  await flow(page).getByTestId("review-continue").click();
  await expect(flow(page).getByTestId("collected-payslip")).toBeVisible();
  await flow(page).getByTestId("to-seal").click();
  await expect(flow(page).getByTestId("seal")).toBeVisible();
});

// Safari and every iOS browser take the single-threaded WASM path (no WebGPU,
// no thread pool). Chromium with their user agents runs that same code path.
for (const [name, userAgent] of [
  ["Safari on a Mac", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15"],
  ["Chrome on an iPhone", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1"],
] as const) {
  test(`${name}: reads a passport on the single-threaded WASM path`, async ({ browser }) => {
    const context = await browser.newContext({ userAgent });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const runtime: string[] = [];
    context.on("request", (r) => {
      if (/ort[.-].*\.(wasm|js)$/.test(r.url())) runtime.push(r.url().split("/").pop()!);
    });
    const { truth, file } = passportFile();
    await page.goto("./?types=passport");
    await choose(page, "passport");
    await expect(flow(page).getByTestId("offline-ready")).toBeVisible();
    await flow(page).getByTestId("file-input").setInputFiles(file);
    await expect(flow(page).locator("[data-field=document_number] input")).toHaveValue(truth.document_number);
    // The 26 MB WebGPU runtime is never fetched on WebKit.
    expect(runtime.some((u) => u.includes("asyncify") || u.includes("webgpu"))).toBe(false);
    expect(errors).toEqual([]);
    await context.close();
  });
}

test("on a phone, Take a photo is the OS camera input itself, and the photo is read", async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const { truth, file } = passportFile();
  await page.goto("./?types=passport");
  await choose(page, "passport");
  const camera = flow(page).getByTestId("camera-input");
  await expect(camera).toHaveAttribute("capture", "environment");
  // The tap lands on the input (not on a button that opens it from script).
  const box = (await camera.boundingBox())!;
  const hit = await page.evaluate(
    ([x, y]: [number, number]) => {
      const flowRoot = document.querySelector("pde-flow")!.shadowRoot!;
      const captureRoot = flowRoot.querySelector("pde-capture")!.shadowRoot!;
      return captureRoot.elementFromPoint(x, y)?.id;
    },
    [box.x + box.width / 2, box.y + box.height / 2] as [number, number],
  );
  expect(hit).toBe("native-camera");
  await expect(flow(page).getByTestId("offline-ready")).toBeVisible();
  await camera.setInputFiles(file);
  await expect(flow(page).locator("[data-field=document_number] input")).toHaveValue(truth.document_number);
  await context.close();
});

test("an older cached build reloads itself once to the server's build", async ({ page }) => {
  let served = 0;
  await page.route("**/version.json", (route) => {
    served++;
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ sha: "0000000000000000000000000000000000000000" }) });
  });
  const loads: string[] = [];
  page.on("load", () => loads.push(page.url()));
  await page.goto("./?types=passport");
  await expect(flow(page).getByText("Your document never leaves this device.")).toBeVisible();
  // One reload, then it carries on (no loop when the server still disagrees).
  await expect.poll(() => served).toBe(2);
  expect(loads.length).toBe(2);
});

test("payslip PDF reads where streams cannot be looped over (Safari / iOS before 2025)", async ({ browser }) => {
  const removeStreamIteration = "delete ReadableStream.prototype[Symbol.asyncIterator]; delete ReadableStream.prototype.values;";
  // Block the service worker so the pdf.js worker request reaches our route.
  const context = await browser.newContext({ serviceWorkers: "block" });
  await context.addInitScript(removeStreamIteration);
  // Workers don't run init scripts: prepend the same removal to pdf.js's worker.
  await context.route(/\/assets\/pdf\.worker-[^/]+\.js$/, async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, body: `${removeStreamIteration}\n${await res.text()}` });
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { truth, file } = await payslipFile();
  await page.goto("./?types=payslip");
  await choose(page, "payslip");
  await flow(page).getByTestId("file-input").setInputFiles(file);
  await expect(flow(page).locator("[data-field=net_pay] input")).toHaveValue(truth.net_pay);
  expect(errors).toEqual([]);
  await context.close();
});

test("a full-size phone photo is shrunk without blurring the MRZ: every check passes", async ({ page }) => {
  // Like Safari / iOS: createImageBitmap ignores resizeWidth / resizeQuality.
  await page.addInitScript(() => {
    const original = window.createImageBitmap.bind(window);
    window.createImageBitmap = ((src: ImageBitmapSource, opts?: ImageBitmapOptions) =>
      original(src, opts?.imageOrientation ? { imageOrientation: opts.imageOrientation } : {})) as typeof window.createImageBitmap;
  });
  const { truth, file } = await passportPhonePhotoFile();
  await page.goto("./?types=passport");
  await choose(page, "passport");
  await flow(page).getByTestId("file-input").setInputFiles(file);
  await expect(flow(page).locator("[data-field=document_number] input")).toHaveValue(truth.document_number);
  await expect(flow(page).locator("[data-field=document_number]")).toContainText("Check digits on the document match");
});

test("start page: pick a type, scan more, remove one, send what is left", async ({ page }) => {
  await page.goto("./?req=req_e2e_multi&types=payslip");
  // Every type is offered; the link's request is listed first and marked.
  for (const t of ["passport", "id_card", "payslip", "bank_statement", "generic"]) await expect(flow(page).getByTestId(`choose-${t}`)).toBeVisible();
  await expect(flow(page).getByTestId("choose-payslip")).toContainText("Requested");
  await expect(flow(page).getByTestId("file-input")).toHaveCount(0);

  // Back from a type without scanning returns to the start page.
  await choose(page, "bank_statement");
  await flow(page).getByTestId("back-home").click();
  await expect(flow(page).getByTestId("choose-passport")).toBeVisible();

  await choose(page, "passport");
  await flow(page).getByTestId("file-input").setInputFiles(passportFile().file);
  await flow(page).getByTestId("review-continue").click();
  await expect(flow(page).getByTestId("collected-passport")).toBeVisible();

  await flow(page).getByTestId("scan-more").click();
  await choose(page, "payslip");
  await flow(page).getByTestId("file-input").setInputFiles((await payslipFile()).file);
  await flow(page).getByTestId("review-continue").click();
  await expect(flow(page).getByTestId("collected-passport")).toBeVisible();
  await expect(flow(page).getByTestId("collected-payslip")).toBeVisible();

  await flow(page).getByTestId("collected-passport").getByRole("button", { name: "Remove" }).click();
  await expect(flow(page).getByTestId("collected-passport")).toHaveCount(0);
  await flow(page).getByTestId("to-seal").click();
  const seal = flow(page).locator("pde-seal-confirm");
  await expect(seal).toContainText("Payslip");
  await expect(seal).not.toContainText("Passport");
  await flow(page).getByTestId("seal").click();
  await expect(flow(page).getByTestId("done")).toBeVisible();
});
