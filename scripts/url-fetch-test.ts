// 测试 URL 抓取器：本地模拟"网上的题目页"（HTML 页 + 附件下载链接）
import { createServer } from "node:http";
import { fetchChallengeFromUrl, writeChallengeToDir } from "@rio/contest";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// 造一个附件（zip 内含 flag.txt）
const { makeZip } = await import("@rio/contest");
const zip = makeZip([{ name: "flag.txt", data: Buffer.from("flag{url_fetcher_works}\n") }]);

const server = createServer((req, res) => {
  if (req.url === "/challenge.zip") {
    res.writeHead(200, { "content-type": "application/zip" });
    res.end(zip);
    return;
  }
  if (req.url === "/challenge") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><html><head><title>Easy Archive — TestCTF</title></head>
<body>
  <h1>Easy Archive</h1>
  <div class="challenge-description">Unpack the archive and find the flag. Category: Misc</div>
  <a href="/challenge.zip" download>challenge.zip</a>
</body></html>`);
    return;
  }
  res.writeHead(404).end();
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;

console.log("=== 测试 1: HTML 题目页 ===");
const page = await fetchChallengeFromUrl(`http://127.0.0.1:${port}/challenge`);
console.log("标题:", page.title, "| 描述:", page.description.slice(0, 60), "| 附件:", page.attachments.length);
const dir = mkdtempSync(join(tmpdir(), "rio-url-"));
await writeChallengeToDir(page, dir);
console.log("落盘:", existsSync(join(dir, "challenge.json")), existsSync(join(dir, "attachments", "challenge.zip")));

console.log("=== 测试 2: 直接附件链接 ===");
const direct = await fetchChallengeFromUrl(`http://127.0.0.1:${port}/challenge.zip`);
console.log("标题:", direct.title, "| 附件:", direct.attachments.length, "| 大小:", direct.attachments[0]!.data.length);

const ok = page.attachments.length === 1 && direct.attachments.length === 1 && page.title.includes("Easy Archive");
console.log(ok ? "\n✅ URL 抓取器验证通过" : "\n❌ 失败");
server.close();
rmSync(dir, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
