import * as FS from "node:fs";
import * as Path from "node:path";
import { expect, it, vi } from "vitest";
import { bootMainProcess, disposeMainProcess } from "./mainProcessHarness";

it("removes a partial seed and stops its timers when setup fails", async () => {
  const argv = process.argv;
  const home = process.env.HOME;
  const url = process.env.VITE_DEV_SERVER_URL;
  const interval = globalThis.setInterval;
  let root = "";
  const background = vi.fn();
  await expect(bootMainProcess({ seed: (userData) => {
    root = Path.dirname(userData);
    FS.writeFileSync(Path.join(userData, "partial-snapshot.json"), "partial");
    setInterval(background, 5);
    throw new Error("seed failed");
  } })).rejects.toThrow("seed failed");
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(background).not.toHaveBeenCalled();
  expect(FS.existsSync(root)).toBe(false);
  expect(process.argv).toBe(argv);
  expect(process.env.HOME).toBe(home);
  expect(process.env.VITE_DEV_SERVER_URL).toBe(url);
  expect(globalThis.setInterval).toBe(interval);
  await disposeMainProcess(); // afterAll is safe after explicit/failed teardown
});
