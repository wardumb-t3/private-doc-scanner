import type { Page } from "@playwright/test";
import { payslipPdf, randomPassport, randomPayslip, renderPassportPhoto } from "@pde/bench/synth";
import { createCanvas, loadImage } from "@napi-rs/canvas";

export async function payslipFile(seed = 5) {
  const p = randomPayslip(seed);
  return { truth: p.truth, file: { name: "payslip.pdf", mimeType: "application/pdf", buffer: Buffer.from(await payslipPdf(p)) } };
}

export function passportFile(seed = 7) {
  const p = randomPassport(seed);
  return { truth: p.truth, file: { name: "passport.png", mimeType: "image/png", buffer: renderPassportPhoto(p) } };
}

/** The same passport as a 12 MP phone photo (4032 px wide JPEG), as an iPhone camera sends it. */
export async function passportPhonePhotoFile(seed = 7) {
  const p = randomPassport(seed);
  const img = await loadImage(renderPassportPhoto(p));
  const W = 4032;
  const H = Math.round((img.height * W) / img.width);
  const canvas = createCanvas(W, H);
  canvas.getContext("2d").drawImage(img, 0, 0, W, H);
  return { truth: p.truth, file: { name: "IMG_0001.jpg", mimeType: "image/jpeg", buffer: canvas.toBuffer("image/jpeg", 92) } };
}

/** On the start page, pick which kind of document to scan. */
export async function choose(page: Page, docType: string) {
  await page.locator("pde-flow").getByTestId(`choose-${docType}`).click();
}
