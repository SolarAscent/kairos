import "./zod-runtime";
import { recordExportPageSchema } from "@life/contracts";
import type { z } from "zod";
import { ClientError, type ApiClient } from "./client";

/** Stream all owned textual originals through the server's fixed export snapshot. */
export async function exportRecordText(client: ApiClient, isCurrent: () => boolean = () => true) {
  const owner = client.userId;
  if (!owner) throw new ClientError("LOGIN_REQUIRED");
  const fileId = await client.newKey();
  const filePath = `${wx.env.USER_DATA_PATH}/kairos-records-${fileId}.txt`;
  const fs = wx.getFileSystemManager();
  const dispose = () => fs.unlink({ filePath, fail() {} });
  const current = () => client.userId === owner && isCurrent();
  const append = (text: string, first = false) =>
    new Promise<void>((resolve, reject) => {
      const options = {
        filePath,
        data: text,
        encoding: "utf8" as const,
        success: () => resolve(),
        fail: reject,
      };
      if (first) fs.writeFile(options);
      else fs.appendFile(options);
    });
  let cursor: string | null = null;
  let count = 0;
  const visited = new Set<string>();
  try {
    do {
      if (!current()) throw new ClientError("SESSION_CHANGED");
      const page: z.infer<typeof recordExportPageSchema> = await client.request(
        `/v1/records/export${cursor ? "?cursor=" + encodeURIComponent(cursor) : ""}`,
        recordExportPageSchema,
      );
      if (!current()) throw new ClientError("SESSION_CHANGED");
      const header =
        count === 0 && !cursor ? `此刻 · 原始记录\n导出时间：${page.exportedAt}\n\n` : "";
      const content = page.records
        .map(
          (record) =>
            `${record.title || "原始记录"}\n${record.createdAt} · ${record.type}\n${record.text || "（图片或语音记录没有附加文字）"}\n${record.summary ? "整理摘要：" + record.summary + "\n" : ""}\n——\n\n`,
        )
        .join("");
      await append(header + content, count === 0 && !cursor);
      count += page.records.length;
      cursor = page.nextCursor;
      if (cursor && visited.has(cursor)) throw new ClientError("RESPONSE_INVALID");
      if (cursor) visited.add(cursor);
    } while (cursor);
    if (!current()) throw new ClientError("SESSION_CHANGED");
    return { filePath, count, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
