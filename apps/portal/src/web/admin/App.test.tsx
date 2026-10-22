import { afterEach, describe, expect, it } from "bun:test";
import { act } from "react";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("admin placeholder SPA", () => {
  it("renders its title when the entry point runs", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    await act(async () => {
      await import("./main");
    });
    expect(document.querySelector("#root h1")?.textContent).toBe("Photobooth Admin");
  });
});
