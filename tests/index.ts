import { logs, mockModules, reset, stateCache } from "./mocks"; // this MUST be imported first

mockModules();

beforeEach(reset);

describe("hello-world", () => {
  it("should pass when `to` is 'test2'", async () => {
    const mod = await import("../build/debug");
    expect(mod.testJSON(JSON.stringify({ to: "test2" }))).toBe("Count: 1");
    expect(logs).toEqual([
      '{"to":"test2"}',
      "to",
      "to",
      "to value: test2 false",
      "assert code: test2",
      "test val",
      '{"to":"test2"}',
    ]);
    expect(stateCache.get("key-1")).toBe('{"to":"test2"}');
  });

  it("should fail when `to` is 'test1'", async () => {
    const mod = await import("../build/debug");
    expect(mod.testJSON).toThrow();
    let threw = false;
    try {
      mod.testJSON(JSON.stringify({ to: "test1" }));
      throw new Error("should throw");
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(logs).toEqual([
      '{"to":"test1"}',
      "to",
      "to",
      "to value: test1 true",
      "assert code: test1",
      "I should throw error",
    ]);
  });
});
