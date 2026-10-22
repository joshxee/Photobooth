import { afterEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { mount } from "./mount";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("mount", () => {
  it("renders the component into #root", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    await act(async () => {
      mount(() => <h1>Hello</h1>);
    });
    expect(document.querySelector("#root h1")?.textContent).toBe("Hello");
  });

  it("throws a clear error when #root is missing", () => {
    expect(() => mount(() => <h1>Hello</h1>)).toThrow("#root");
  });
});
