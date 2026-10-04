import { describe, expect, it } from "vitest";
import { createWriteOperation } from "../../apps/demo/src/write-operation";

describe("demo writes after a lost server receipt", () => {
  it("replays a committed capture without creating a second record", async () => {
    const saved = new Map<string, { id: number; body: string }>();
    let loseResponse = true;
    const write = createWriteOperation(async (_path, options) => {
      const key = options.headers["X-Idempotency-Key"]!;
      if (!saved.has(key)) saved.set(key, { id: saved.size + 1, body: options.body });
      if (loseResponse) {
        loseResponse = false;
        throw new Error("response lost after commit");
      }
      return saved.get(key);
    });
    const capture = { type: "TEXT", text: "想看海" };
    await expect(write("/v1/captures", capture)).rejects.toThrow("response lost");
    expect(await write("/v1/captures", capture)).toMatchObject({ id: 1 });
    expect(saved.size).toBe(1);
    await write("/v1/captures", capture);
    expect(saved.size).toBe(2);
  });

  it("gives changed content and different routes independent identities", async () => {
    const keys: string[] = [];
    const write = createWriteOperation(async (_path, options) => {
      keys.push(options.headers["X-Idempotency-Key"]!);
      throw new Error("offline");
    });
    for (const [path, text] of [
      ["/a", "first"],
      ["/a", "second"],
      ["/b", "second"],
    ])
      await expect(write(path!, { text })).rejects.toThrow("offline");
    expect(new Set(keys).size).toBe(3);
  });
});
