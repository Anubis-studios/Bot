import { expect, it } from "vitest";

import { isAbsolutePreviewPath, previewTargetPath } from "./preview-target";

const root = "/repo";

it("checkout files become root-relative", () => {
  expect(previewTargetPath("/repo/src/a.ts", root)).toBe("src/a.ts");
  expect(previewTargetPath("src/a.ts", root)).toBe("src/a.ts");
});

it("guest /workspace paths map onto the host root", () => {
  expect(previewTargetPath("/workspace/out/report.pdf", root)).toBe(
    "out/report.pdf"
  );
});

it("absolute files outside the checkout stay absolute", () => {
  expect(previewTargetPath("/tmp/out/chart.png", root)).toBe(
    "/tmp/out/chart.png"
  );
  expect(isAbsolutePreviewPath("/tmp/out/chart.png")).toBe(true);
  expect(isAbsolutePreviewPath("out/chart.png")).toBe(false);
  expect(previewTargetPath("C:\\out\\chart.png", root)).toBe(
    "C:\\out\\chart.png"
  );
});

it("traversal and empty paths are refused", () => {
  expect(previewTargetPath("../x.png", root)).toBeNull();
  expect(previewTargetPath("/tmp/../etc/passwd", root)).toBeNull();
  expect(previewTargetPath("", root)).toBeNull();
});
