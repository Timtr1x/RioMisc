// rio CLI — talks to the Control API (REST). `solve` boots a headless runtime.
import { Command } from "commander";

const API_BASE = process.env.RIO_API ?? "http://127.0.0.1:3000";

async function api(path: string, opts: { method?: string; body?: unknown } = {}): Promise<unknown> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: opts.method ?? "GET",
    headers: opts.body ? { "content-type": "application/json" } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`API ${res.status} ${path}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

function table(rows: Record<string, unknown>[]): void {
  if (rows.length === 0) {
    console.log("(empty)");
    return;
  }
  const cols = Object.keys(rows[0]!);
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)));
  const fmt = (row: Record<string, unknown>) => cols.map((c, i) => String(row[c] ?? "").padEnd(widths[i]!)).join("  ");
  console.log(fmt(rows[0]!));
  console.log(cols.map((c, i) => "-".repeat(widths[i]!)).join("  "));
  for (const r of rows.slice(1)) console.log(fmt(r));
}

export async function main(argv: string[]): Promise<void> {
  const program = new Command();
  program.name("rio").description("RioMisc — CTF Misc/Crypto Autonomous Runtime CLI").version("0.1.0");

  program
    .command("start")
    .description("Start the control plane + API server (foreground)")
    .option("--config <path>", "config file")
    .action(async (opts) => {
      const { startRuntime } = await import("@rio/server");
      const runtime = await startRuntime({ configPath: opts.config });
      const onExit = () => {
        void runtime.close();
      };
      process.on("SIGINT", onExit);
      process.on("SIGTERM", onExit);
      console.log(`RioMisc running — dashboard API at http://127.0.0.1:${runtime.config.server.port}`);
      await new Promise(() => {
        /* run until signal */
      });
    });

  program.command("stop").description("Shut down a running server").action(async () => {
    await api("/api/shutdown", { method: "POST" });
    console.log("shutdown requested");
  });

  program.command("status").description("Show system status").action(async () => {
    const s = (await api("/api/status")) as Record<string, unknown>;
    console.log(JSON.stringify(s, null, 2));
  });

  program.command("challenges").description("List challenges").action(async () => {
    const list = (await api("/api/challenges")) as Record<string, unknown>[];
    table(
      list.map((c) => ({
        id: c.id,
        title: String(c.title).slice(0, 30),
        cat: c.category,
        score: c.score ?? "",
        status: c.status,
        prio: c.priorityScore ?? "",
        progress: c.progress,
        wrong: c.wrong,
      })),
    );
  });

  program.command("challenge <id>").description("Show challenge detail").action(async (id) => {
    const c = (await api(`/api/challenges/${id}`)) as Record<string, unknown>;
    console.log(JSON.stringify(c, null, 2).slice(0, 12000));
  });

  program
    .command("pause <id>")
    .description("Pause a challenge")
    .action(async (id) => {
      await api(`/api/challenges/${id}/pause`, { method: "POST" });
      console.log("paused", id);
    });

  program
    .command("resume <id>")
    .description("Resume a paused challenge")
    .action(async (id) => {
      await api(`/api/challenges/${id}/resume`, { method: "POST" });
      console.log("resumed", id);
    });

  program
    .command("park <id>")
    .description("Park a challenge (low priority)")
    .action(async (id) => {
      await api(`/api/challenges/${id}/park`, { method: "POST" });
      console.log("parked", id);
    });

  program
    .command("unpark <id>")
    .description("Unpark a challenge")
    .action(async (id) => {
      await api(`/api/challenges/${id}/unpark`, { method: "POST" });
      console.log("unparked", id);
    });

  program
    .command("restart <id>")
    .description("Restart a challenge solver")
    .action(async (id) => {
      await api(`/api/challenges/${id}/restart`, { method: "POST" });
      console.log("restart requested", id);
    });

  program
    .command("hint <id>")
    .description("Force-fetch a hint")
    .action(async (id) => {
      const r = (await api(`/api/challenges/${id}/hint`, { method: "POST" })) as { hint?: string };
      console.log("hint:", r.hint ?? "(none)");
    });

  program
    .command("reflection <id>")
    .description("Trigger a reflection pass")
    .action(async (id) => {
      await api(`/api/challenges/${id}/reflection`, { method: "POST" });
      console.log("reflection triggered", id);
    });

  program
    .command("priority <id> <level>")
    .description("Set priority (LOW|NORMAL|HIGH|CRITICAL)")
    .action(async (id, level) => {
      await api(`/api/challenges/${id}/priority`, { method: "POST", body: { priority: level.toUpperCase() } });
      console.log("priority set", id, level);
    });

  program.command("providers").description("List model providers").action(async () => {
    const p = (await api("/api/providers")) as { providers: Record<string, unknown>[] };
    table(p.providers.map((x) => ({ id: x.id, name: x.displayName, protocol: x.protocol, health: x.health, enabled: x.enabled })));
  });

  program
    .command("provider-test <id>")
    .description("Test a provider connection (chat + tool call)")
    .action(async (id) => {
      const r = (await api(`/api/providers/${id}/test`, { method: "POST" })) as { result: Record<string, unknown> };
      console.log(JSON.stringify(r.result, null, 2));
    });

  program
    .command("solve <folder>")
    .description("Solve a single local challenge (challenge.json + attachments/ + answer.json)")
    .option("--timeout <seconds>", "max wait in seconds", "600")
    .action(async (folder, opts) => {
      const { startRuntime } = await import("@rio/server");
      const { resolve } = await import("node:path");
      const runtime = await startRuntime({
        skipApi: true,
        configOverrides: {
          contest: { adapter: "local", localChallengeDir: resolve(folder), poll: { initialMs: 1000, maxMs: 2000 } },
          submission: { autoSubmit: true, confidenceThreshold: 0.85, localMaxWrong: 3, defaultCooldownMs: 1000 },
          paths: { dataDir: `${resolve(folder)}/.rio-solve`, configDir: resolve(folder) },
        } as never,
      });
      const deadline = Date.now() + Number(opts.timeout) * 1000;
      console.log(`solving ${resolve(folder)} …`);
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000));
        const c = runtime.repos.challenges.list()[0];
        if (!c) continue;
        if (c.lifecycleStatus === "SOLVED") {
          const flag = runtime.repos.submissions
            .listByChallenge(c.id)
            .find((s) => s.status === "CORRECT")?.flagValue;
          console.log(`\n✅ SOLVED: ${c.title}`);
          console.log(`FLAG: ${flag ?? "(flag recorded in submissions)"}`);
          await runtime.close();
          process.exit(0);
        }
        if (c.lifecycleStatus === "ERROR" || c.lifecycleStatus === "UNSUPPORTED") {
          console.log(`status: ${c.lifecycleStatus} — cannot solve`);
          await runtime.close();
          process.exit(1);
        }
      }
      console.log("timeout — challenge not solved");
      await runtime.close();
      process.exit(1);
    });

  program.parseAsync(argv).catch((e) => {
    console.error("error:", e.message);
    process.exit(1);
  });
}

const isDirectEntry =
  process.argv[1] !== undefined &&
  (process.argv[1].replaceAll("\\", "/").endsWith("apps/cli/src/index.ts") ||
    process.argv[1].replaceAll("\\", "/").endsWith("apps/cli/src/index.js") ||
    process.argv[1].replaceAll("\\", "/").endsWith("apps/cli/dist/index.js"));

if (isDirectEntry) {
  void main(process.argv);
}
