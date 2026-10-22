import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { resolveNodeConfig, type ResolutionContext } from "../src/domain/profile-resolver.js";
import { resolveNodeConfigAsync, withNodeConfigResolver } from "../src/domain/profile-resolution-worker.js";
import { preflightValidatedSpec } from "../src/domain/rigspec-preflight.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(): ResolutionContext {
  const root = mkdtempSync(join(tmpdir(), "profile-worker-"));
  roots.push(root);
  const member = { id: "worker", agentRef: "local:agent", profile: "default", runtime: "codex", cwd: root };
  const pod = { id: "dev", label: "Dev", members: [member], edges: [] };
  return {
    baseSpec: {
      sourcePath: root, hash: "test",
      spec: {
        name: "worker", version: "1.0.0", imports: [],
        startup: { files: [], actions: [] },
        resources: { skills: [], guidance: [], subagents: [], plugins: [], runtimeResources: [] },
        profiles: { default: { uses: { skills: ["wanted"], guidance: [], subagents: [], plugins: [], runtimeResources: [] } } },
      },
    },
    importedSpecs: [], collisions: [], profileName: "default", member, pod,
    rig: { version: "0.2", name: "test", pods: [pod], edges: [] }, homedir: root,
  };
}

function skill(ctx: ResolutionContext, folder: string, name: string): void {
  const dir = join(ctx.homedir!, ".agents", "skills", folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Test skill\n---\nBody\n`);
}

describe("profile resolution outside the daemon request thread", () => {
  it("preserves fallback discovery and reads edits on the next call", async () => {
    const ctx = fixture();
    skill(ctx, "different-folder", "wanted");
    await withNodeConfigResolver(async resolve => {
      const first = await resolve(ctx);
      expect(first.ok).toBe(true);
      expect(first).toEqual(resolveNodeConfig(ctx));

      skill(ctx, "different-folder", "renamed");
      const next = await resolve(ctx);
      expect(next.ok).toBe(false);
      expect(next).toEqual(resolveNodeConfig(ctx));
    });
  });

  it("serves a health request while a missing skill requires scanning a large library", async () => {
    const ctx = fixture();
    for (let i = 0; i < 1000; i++) skill(ctx, `skill-${i}`, `skill-${i}`);
    const server = createServer((_req, res) => { res.end("healthy"); });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as { port: number };
    let completed = false;
    const resolution = preflightValidatedSpec(ctx.rig, {
      rigRoot: ctx.homedir!,
      fsOps: {
        exists: path => path === join(ctx.homedir!, "agent", "agent.yaml"),
        readFile: () => "name: worker\nversion: '1.0.0'\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: [wanted]\n",
      },
    }).then(result => { completed = true; return result; });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(await response.text()).toBe("healthy");
      expect(completed).toBe(false);
      const result = await resolution;
      expect(result.ready).toBe(false);
      expect(result.errors.some(error => error.includes("wanted"))).toBe(true);
    } finally {
      await resolution.catch(() => undefined);
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it("propagates a resolver exception instead of waiting forever for a result", async () => {
    const ctx = fixture();
    // A malformed internal input throws before producing a normal validation result.
    ctx.baseSpec.spec = null as unknown as ResolutionContext["baseSpec"]["spec"];
    await expect(resolveNodeConfigAsync(ctx)).rejects.toThrow(/profiles/);
  });
});
