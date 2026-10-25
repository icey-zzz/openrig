import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { resolveEscalationOwner, ESCALATION_HOP_TAG } from "../src/domain/escalation-owner.js";
import { runStuckSweep, createStuckSweepStatus } from "../src/domain/queue-stuck-sweep.js";
import { runWakeLadderTick, createWakeLadderStatus } from "../src/domain/queue-wake-ladder.js";
import { addRigEdge, removeRigEdge } from "../src/domain/rig-edge-ops.js";
import { RigSpecExporter } from "../src/domain/rigspec-exporter.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { LegacyRigSpecSchema, RigSpecSchema } from "../src/domain/rigspec-schema.js";

describe("same-daemon escalation routes (#605)", () => {
  let db: Database.Database;
  let rigs: RigRepository;
  let queue: QueueRepository;
  let seq: number;
  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    rigs = new RigRepository(db);
    queue = new QueueRepository(db, new EventBus(db), { validateRig: () => true, loadHumanRegistry: () => ({ ok: true, entities: [] }) });
    seq = 0;
  });
  afterEach(() => db.close());

  function seat(rigName: string, logicalId: string, session: string, status = "running") {
    const existing = rigs.listRigs().find(r => r.name === rigName);
    const rig = existing ?? rigs.createRig(rigName);
    const node = rigs.addNode(rig.id, logicalId, { runtime: "claude-code" });
    db.prepare("INSERT INTO sessions (id,node_id,session_name,status) VALUES (?,?,?,?)")
      .run(`session-${++seq}`, node.id, session, status);
    return { rig, node, session };
  }
  const resolve = (session: string) => resolveEscalationOwner(db, session);
  async function sweep() {
    return runStuckSweep({ db, queueRepo: queue, status: createStuckSweepStatus(),
      unclaimedAgeMinutes: 1, log: () => {}, isRegisteredHost: () => false });
  }
  async function work(destination: string, handedOff = false) {
    const row = await queue.create({ sourceSession: "sender@lane", destinationSession: destination,
      body: "Scope decision needed", nudge: false });
    db.prepare("UPDATE queue_items SET ts_created=?, handed_off_from=?, last_nudge_result=? WHERE qitem_id=?")
      .run(new Date(Date.now() - 3_600_000).toISOString(), handedOff ? "predecessor" : null,
        handedOff ? "failed:fixture transport" : null, row.qitemId);
    return row;
  }

  it("stores a deferred edge, resolves it after the other rig appears, and removes the exact declaration", () => {
    const source = seat("lane", "work.lead", "actual-lead");
    expect(addRigEdge(rigs, { rigId: source.rig.id, from: "work.lead", to: "review-advisor@coord", kind: "escalates_to", plan: true }))
      .toMatchObject({ outcome: "would_add" });
    expect(rigs.getRig(source.rig.id)!.edges).toEqual([]);
    const added = addRigEdge(rigs, { rigId: source.rig.id, from: "work.lead", to: "review-advisor@coord", kind: "escalates_to" });
    expect(added).toMatchObject({ ok: true, outcome: "added", edge: { to: { nodeId: null } } });
    expect(resolve(source.session).outcome).toBe("unavailable");
    seat("coord", "review.advisor", "actual-advisor");
    expect(resolve(source.session)).toMatchObject({ outcome: "routed", owner: "actual-advisor" });
    const duplicate = addRigEdge(rigs, { rigId: source.rig.id, from: "work.lead", to: "review-advisor@coord", kind: "escalates_to" });
    expect(duplicate).toMatchObject({ outcome: "present" });
    if (!added.ok) throw new Error("edge not added");
    expect(removeRigEdge(rigs, { rigId: source.rig.id, edgeId: added.edge.id! })).toMatchObject({ outcome: "removed" });
    expect(resolve(source.session).outcome).toBe("none");
  });

  it.each(["running", "exited"])("retains an existing %s delegation parent", status => {
    const source = seat("lane", "work.lead", "lead@lane");
    const parent = seat("lane", "coord.owner", "owner@lane", status);
    seat("coord", "review.advisor", "advisor@coord");
    rigs.addEdge(source.rig.id, parent.node.id, source.node.id, "delegates_to");
    rigs.addEdge(source.rig.id, source.node.id, "advisor@coord", "escalates_to");
    expect(resolve(source.session)).toMatchObject({ outcome: "parent", owner: parent.session });
    db.prepare("DELETE FROM sessions WHERE node_id=?").run(parent.node.id);
    expect(resolve(source.session)).toMatchObject({ outcome: "parent", owner: null });
  });

  it.each(["exited", "detached", "unknown"])("does not route to a destination whose session is %s", status => {
    const source = seat("lane", "work.lead", "lead@lane");
    seat("coord", "review.advisor", "advisor@coord", status);
    rigs.addEdge(source.rig.id, source.node.id, "advisor@coord", "escalates_to");
    expect(resolve(source.session)).toMatchObject({ outcome: "unavailable", owner: null });
  });

  it("detects self routes, ambiguous topology and multiple destinations", () => {
    const source = seat("lane", "work.lead", "lead@lane");
    const edge = rigs.addEdge(source.rig.id, source.node.id, "lead@lane", "escalates_to");
    expect(resolve(source.session).outcome).toBe("self");
    rigs.removeEdge(source.rig.id, edge.id);
    for (let i = 0; i < 2; i++) {
      const rig = rigs.createRig("coord");
      rigs.addNode(rig.id, "review.advisor");
    }
    rigs.addEdge(source.rig.id, source.node.id, "review-advisor@coord", "escalates_to");
    expect(resolve(source.session).outcome).toBe("ambiguous");
    rigs.addEdge(source.rig.id, source.node.id, "another@coord", "escalates_to");
    expect(resolve(source.session).reason).toContain("multiple declared");
  });

  it("detects a cycle through stopped seats and delegation edges", () => {
    const a = seat("a", "top.lead", "lead@a");
    const b = seat("b", "work.builder", "builder@b");
    const c = seat("b", "top.lead", "lead@b", "exited");
    rigs.addEdge(a.rig.id, a.node.id, "builder@b", "escalates_to");
    rigs.addEdge(b.rig.id, c.node.id, b.node.id, "delegates_to");
    rigs.addEdge(c.rig.id, c.node.id, "lead@a", "escalates_to");
    expect(resolve(a.session)).toMatchObject({ outcome: "cycle", owner: null });
  });

  it("reports an unresolved downstream topology as unknown rather than proving no cycle", () => {
    const a = seat("a", "top.lead", "lead@a");
    const b = seat("b", "top.lead", "lead@b");
    rigs.addEdge(a.rig.id, a.node.id, "lead@b", "escalates_to");
    rigs.addEdge(b.rig.id, b.node.id, "absent@c", "escalates_to");
    expect(resolve(a.session)).toMatchObject({ outcome: "unknown", owner: null });
  });

  it("routes local escalates_to edges too, without adding a new edge kind", () => {
    const a = seat("a", "work.builder", "builder@a");
    const b = seat("a", "top.lead", "lead@a");
    rigs.addEdge(a.rig.id, a.node.id, b.node.id, "escalates_to");
    expect(resolve(a.session)).toMatchObject({ outcome: "routed", owner: b.session });
  });

  it("lands a stuck-sweep finding in the other rig's queue and never forwards it a second hop", async () => {
    const a = seat("a", "top.lead", "lead@a");
    const b = seat("b", "top.lead", "lead@b");
    seat("c", "top.lead", "lead@c");
    rigs.addEdge(a.rig.id, a.node.id, "lead@b", "escalates_to");
    rigs.addEdge(b.rig.id, b.node.id, "lead@c", "escalates_to");
    const original = await work(a.session);
    expect((await sweep()).outcome).toBe("findings");
    const findings = queue.list({ limit: 100 }).filter(r => r.tags?.includes("stuck-sweep-finding"));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ destinationSession: b.session });
    expect(findings[0]!.tags).toContain(ESCALATION_HOP_TAG);
    expect(findings[0]!.body).toContain("escalates_to routed");
    expect(queue.getById(original.qitemId)!.destinationSession).toBe(a.session);
    expect((await sweep()).outcome).toBe("findings");
    expect(queue.list({ limit: 100 }).some(r => r.destinationSession === "lead@c")).toBe(false);
  });

  it("keeps the sweep fallback with visible evidence when a destination is absent", async () => {
    const a = seat("a", "top.lead", "lead@a");
    rigs.addEdge(a.rig.id, a.node.id, "absent@b", "escalates_to");
    await work(a.session);
    await sweep();
    const finding = queue.list({ limit: 100 }).find(r => r.tags?.includes("stuck-sweep-finding"))!;
    expect(finding.destinationSession).toBe(a.session);
    expect(finding.body).toContain("escalates_to unavailable");
  });

  it("the real wake ladder creates the aggregate for the other rig and attempts its delivery", async () => {
    const a = seat("a", "top.lead", "lead@a");
    const b = seat("b", "top.lead", "lead@b");
    rigs.addEdge(a.rig.id, a.node.id, "lead@b", "escalates_to");
    const original = await work(a.session, true);
    const attempts: Array<[string, string]> = [];
    const result = await runWakeLadderTick({ db, queueRepo: queue, status: createWakeLadderStatus(),
      retryCap: 0, log: () => {}, attemptWake: async (id, target) => { attempts.push([id, target]); return "verified"; } });
    expect(result.actions).toContainEqual({ qitemId: original.qitemId, action: "escalate-orchestrator", target: b.session });
    const aggregate = queue.list({ limit: 100 }).find(r => r.tags?.includes("wake-escalation"))!;
    expect(aggregate.destinationSession).toBe(b.session);
    expect(attempts).toContainEqual([aggregate.qitemId, b.session]);
    expect(aggregate.tags).toContain(ESCALATION_HOP_TAG);
  });

  it.each(["unavailable", "ambiguous", "self", "cycle", "unknown", "queue-rejected"])("both recovery engines retain their fallback with a visible %s reason", async outcome => {
    const a = seat("a", "top.lead", "lead@a");
    const b = seat("b", "top.lead", "lead@b");
    const target = outcome === "unavailable" ? "missing@b" : outcome === "self" ? "lead@a" : "lead@b";
    rigs.addEdge(a.rig.id, a.node.id, target, "escalates_to");
    if (outcome === "ambiguous") rigs.addEdge(a.rig.id, a.node.id, "another@b", "escalates_to");
    if (outcome === "cycle") rigs.addEdge(b.rig.id, b.node.id, "lead@a", "escalates_to");
    if (outcome === "unknown") rigs.addEdge(b.rig.id, b.node.id, "missing@c", "escalates_to");
    if (outcome === "queue-rejected") queue = new QueueRepository(db, new EventBus(db), {
      validateRig: destination => destination !== b.session, loadHumanRegistry: () => ({ ok: true, entities: [] }) });
    const expected = outcome === "queue-rejected" ? "unavailable" : outcome;
    await work(a.session);
    await sweep();
    const finding = queue.list({ limit: 100 }).find(r => r.tags?.includes("stuck-sweep-finding"))!;
    expect(finding.destinationSession).toBe(a.session);
    expect(finding.body).toContain(`escalates_to ${expected}`);
    // Remove only the fixture work/recovery before exercising the independent ladder path.
    db.prepare("DELETE FROM queue_items").run();
    const original = await work(a.session, true);
    const result = await runWakeLadderTick({ db, queueRepo: queue, status: createWakeLadderStatus(),
      retryCap: 0, log: () => {}, attemptWake: async () => "verified" });
    expect(result.outcome).not.toBe("failed");
    expect(result.actions.some(action => action.action === "escalate-orchestrator")).toBe(false);
    const aggregate = queue.list({ limit: 100 }).find(r => r.tags?.includes("wake-escalation"))!;
    expect(aggregate.body).toContain(`escalates_to ${expected}`);
    expect(db.prepare("SELECT transition_note FROM queue_transitions WHERE qitem_id=? AND transition_note LIKE '%orchestrator self-skip%'").get(original.qitemId)).toBeDefined();
  });

  it("does not send a one-hop recovery through the next seat's fallback declaration", async () => {
    const b = seat("b", "top.lead", "lead@b");
    seat("c", "top.lead", "lead@c");
    rigs.addEdge(b.rig.id, b.node.id, "lead@c", "escalates_to");
    const row = await work(b.session, true);
    db.prepare("UPDATE queue_items SET tags=? WHERE qitem_id=?").run(JSON.stringify([ESCALATION_HOP_TAG]), row.qitemId);
    const result = await runWakeLadderTick({ db, queueRepo: queue, status: createWakeLadderStatus(),
      retryCap: 0, log: () => {}, attemptWake: async () => "verified" });
    expect(result.actions.some(action => action.target === "lead@c")).toBe(false);
    expect(queue.list({ limit: 100 }).some(row => row.destinationSession === "lead@c")).toBe(false);
  });

  it("retains the consumed hop through a handoff whose tags are replaced", async () => {
    const b = seat("b", "top.lead", "lead@b");
    const c = seat("c", "top.lead", "lead@c");
    seat("d", "top.lead", "lead@d");
    rigs.addEdge(c.rig.id, c.node.id, "lead@d", "escalates_to");
    const recovery = await queue.create({ sourceSession: "watchdog@system", destinationSession: b.session,
      body: "Cross-rig recovery", tags: [ESCALATION_HOP_TAG], nudge: false });
    const { created } = await queue.handoff({ qitemId: recovery.qitemId, fromSession: b.session,
      toSession: c.session, tags: [], nudge: false });
    db.prepare("UPDATE queue_items SET ts_created=?, last_nudge_result='delivered-ack-pending' WHERE qitem_id=?")
      .run(new Date(Date.now() - 3_600_000).toISOString(), created.qitemId);
    expect(queue.waitingView(created.qitemId)!.nextBackstop.owner).not.toBe("lead@d");
    const result = await runWakeLadderTick({ db, queueRepo: queue, status: createWakeLadderStatus(),
      retryCap: 0, log: () => {}, attemptWake: async () => "verified" });
    expect(result.actions).toContainEqual({ qitemId: created.qitemId, action: "escalate-operator" });
    expect(queue.list({ limit: 100 }).some(row => row.destinationSession === "lead@d")).toBe(false);
  });

  it.each(["parent", "escalation"])("a mixed ladder group preserves ordinary %s routing without forwarding the consumed recovery", async kind => {
    const a = seat("a", "top.lead", "lead@a");
    const b = seat(kind === "parent" ? "a" : "b", "review.owner", "owner@b");
    rigs.addEdge(a.rig.id, kind === "parent" ? b.node.id : a.node.id,
      kind === "parent" ? a.node.id : b.session, kind === "parent" ? "delegates_to" : "escalates_to");
    const ordinary = await work(a.session, true);
    const consumed = await work(a.session, true);
    db.prepare("UPDATE queue_items SET tags=? WHERE qitem_id=?").run(JSON.stringify([ESCALATION_HOP_TAG]), consumed.qitemId);
    const calls: Array<[string, string]> = [];
    const result = await runWakeLadderTick({ db, queueRepo: queue, status: createWakeLadderStatus(), retryCap: 0,
      log: () => {}, attemptWake: async (id, target) => { calls.push([id, target]); return "verified"; } });
    expect(result.actions).toContainEqual({ qitemId: ordinary.qitemId, action: "escalate-orchestrator", target: b.session });
    expect(result.actions).toContainEqual({ qitemId: consumed.qitemId, action: "escalate-operator" });
    const forwarded = calls.filter(([, target]) => target === b.session).map(([id]) => queue.getById(id)!);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]!.tags).toContain(`recovery-for:${ordinary.qitemId}`);
    expect(forwarded[0]!.tags).not.toContain(`recovery-for:${consumed.qitemId}`);
    expect(queue.getById(ordinary.qitemId)!.tags ?? []).not.toContain(ESCALATION_HOP_TAG);
  });

  it.each([
    { path: "ladder", withEngine: true },
    { path: "ladder", withEngine: false },
    { path: "prompt", withEngine: false },
    { path: "choice", withEngine: true },
  ])("keeps a consumed handoff visible on the $path floor with engine=$withEngine", async ({ path, withEngine }) => {
    const b = seat("b", "top.lead", "lead@b");
    const c = seat("c", "top.lead", "lead@c");
    const d = seat("d", "top.lead", "lead@d");
    rigs.addEdge(c.rig.id, c.node.id, d.session, "escalates_to");
    const recovery = await queue.create({ sourceSession: "watchdog@system", destinationSession: b.session,
      body: "Cross-rig recovery", tags: [ESCALATION_HOP_TAG], nudge: false });
    const { created } = await queue.handoff({ qitemId: recovery.qitemId, fromSession: b.session,
      toSession: c.session, tags: [], nudge: false });
    db.prepare("UPDATE queue_items SET ts_created=?, last_nudge_result=? WHERE qitem_id=?")
      .run(new Date(Date.now() - 3_600_000).toISOString(), path === "ladder" ? "failed:fixture transport" : null, created.qitemId);
    if (path !== "ladder") {
      const key = `${c.session}|consumed#1`;
      queue.update({ qitemId: created.qitemId, actorSession: "watchdog@system", transitionNote:
        `parked-owner wake reserved: ${key}; obligations ${created.qitemId}` });
      queue.update({ qitemId: created.qitemId, actorSession: "watchdog@system", transitionNote:
        `parked-owner wake delivery refused: ${key}; Refused: interactive prompt${path === "choice" ? " (selection_prompt)" : ""}` });
    }
    const posted: string[] = [];
    const woken: string[] = [];
    const status = createWakeLadderStatus();
    const deps = { db, queueRepo: queue, status, retryCap: 0, humanRung: "explicit-only" as const,
      loadHumanRegistry: () => ({ ok: true as const, entities: [] }), log: () => {},
      readPromptState: () => "blocked" as const,
      attemptWake: async (_id: string, target: string) => { woken.push(target); return "verified"; },
      deliveryEngine: withEngine ? { dispatchEscalation: async (row: { qitemId: string }) => {
        posted.push(row.qitemId); return { decision: "post", resolved: true, dispatched: true };
      } } : undefined };
    const result = await runWakeLadderTick(deps);
    expect(result.outcome, result.error).not.toBe("failed");
    expect(result.actions).toContainEqual({ qitemId: created.qitemId, action: "escalate-operator" });
    const floors = () => queue.list({ limit: 100 }).filter(row =>
      row.tags?.includes("wake-escalation") && row.tags.includes(`recovery-for:${created.qitemId}`));
    expect(floors()).toHaveLength(1);
    expect(status.snapshot().escalationsOpen).toBeGreaterThanOrEqual(1);
    expect(posted).toEqual([]);
    expect(woken).toEqual([]);
    expect(floors()[0]!.destinationSession).not.toBe(d.session);
    await runWakeLadderTick(deps);
    expect(floors()).toHaveLength(1);
    expect(posted).toEqual([]);
    expect(woken).toEqual([]);
  });

  it.each([false, true])("a mixed prompt refusal preserves ordinary routing with existing consumed recovery=%s", async ownedElsewhere => {
    const a = seat("a", "top.lead", "lead@a");
    const b = seat("b", "top.lead", "lead@b");
    rigs.addEdge(a.rig.id, a.node.id, b.session, "escalates_to");
    const ordinary = await work(a.session);
    const consumed = await work(a.session);
    db.prepare("UPDATE queue_items SET tags=? WHERE qitem_id=?").run(JSON.stringify([ESCALATION_HOP_TAG]), consumed.qitemId);
    if (ownedElsewhere) await queue.create({ sourceSession: "watchdog@system", destinationSession: "operator@elsewhere",
      body: "Existing consumed recovery", nudge: false, tags: ["wake-escalation", `recovery-for:${consumed.qitemId}`] });
    const key = `${a.session}|mixed#1`;
    queue.update({ qitemId: ordinary.qitemId, actorSession: "watchdog@system", transitionNote:
      `parked-owner wake reserved: ${key}; obligations ${ordinary.qitemId},${consumed.qitemId}` });
    queue.update({ qitemId: ordinary.qitemId, actorSession: "watchdog@system", transitionNote:
      `parked-owner wake delivery refused: ${key}; Refused: interactive prompt` });
    const calls: Array<[string, string]> = [];
    const result = await runWakeLadderTick({ db, queueRepo: queue, status: createWakeLadderStatus(), retryCap: 0,
      readPromptState: () => "blocked", log: () => {},
      attemptWake: async (id, target) => { calls.push([id, target]); return "verified"; } });
    const forwarded = calls.filter(([, target]) => target === b.session).map(([id]) => queue.getById(id)!);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]!.tags).toContain(`recovery-for:${ordinary.qitemId}`);
    expect(forwarded[0]!.tags).not.toContain(`recovery-for:${consumed.qitemId}`);
    expect(result.actions.some(action => action.qitemId === consumed.qitemId && action.action === "escalate-operator"))
      .toBe(!ownedElsewhere);
  });

  it.each(["available", "absent", "delegation-parent"])("wakes the recorded recovery owner when the new route is %s", async kind => {
    const a = seat("a", "top.lead", "lead@a");
    const b = seat("b", "top.lead", "lead@b");
    if (kind !== "absent") {
      const c = seat(kind === "delegation-parent" ? "a" : "c", "review.owner", "lead@c");
      if (kind === "delegation-parent") rigs.addEdge(a.rig.id, c.node.id, a.node.id, "delegates_to");
    }
    rigs.addEdge(a.rig.id, a.node.id, "lead@c", "escalates_to");
    const original = await work(a.session, true);
    const aggregate = await queue.create({ sourceSession: "sender@lane", destinationSession: b.session,
      body: "Existing recovery", nudge: false, tags: ["wake-escalation", `wake-escalation:${a.session}`, `recovery-for:${original.qitemId}`] });
    db.prepare("UPDATE queue_items SET last_nudge_result='delivered-ack-pending' WHERE qitem_id=?").run(original.qitemId);
    expect(queue.waitingView(original.qitemId)!.nextBackstop.owner).toBe(b.session);
    const attempts: Array<[string, string]> = [];
    await runWakeLadderTick({ db, queueRepo: queue, status: createWakeLadderStatus(), retryCap: 0,
      log: () => {}, attemptWake: async (id, target) => { attempts.push([id, target]); return "verified"; } });
    expect(attempts).toContainEqual([aggregate.qitemId, b.session]);
    expect(attempts.some(([, target]) => target === "lead@c")).toBe(false);
    expect(queue.getById(aggregate.qitemId)!.destinationSession).toBe(b.session);
  });

  it("prompt refusal wakes the recorded recovery owner when the new target is absent", async () => {
    const a = seat("a", "top.lead", "lead@a");
    const b = seat("b", "top.lead", "lead@b");
    rigs.addEdge(a.rig.id, a.node.id, "absent@c", "escalates_to");
    const original = await work(a.session);
    const key = `${a.session}|retained#1`;
    queue.update({ qitemId: original.qitemId, actorSession: "watchdog@system", transitionNote:
      `parked-owner wake reserved: ${key}; obligations ${original.qitemId}` });
    queue.update({ qitemId: original.qitemId, actorSession: "watchdog@system", transitionNote:
      `parked-owner wake delivery refused: ${key}; Refused: interactive prompt` });
    const aggregate = await queue.create({ sourceSession: "watchdog@system", destinationSession: b.session,
      body: "Existing prompt recovery", nudge: false, tags: ["wake-escalation", "wake-prompt-refusal",
        `prompt-destination:${a.session}`, `prompt-episode:${key}`, `recovery-for:${original.qitemId}`] });
    const attempts: Array<[string, string]> = [];
    await runWakeLadderTick({ db, queueRepo: queue, status: createWakeLadderStatus(), retryCap: 0,
      readPromptState: () => "blocked", log: () => {},
      attemptWake: async (id, target) => { attempts.push([id, target]); return "verified"; } });
    expect(attempts).toContainEqual([aggregate.qitemId, b.session]);
  });

  it("waiting projections name the same cross-rig owner as both executing engines", async () => {
    const a = seat("a", "top.lead", "lead@a");
    const b = seat("b", "top.lead", "lead@b");
    rigs.addEdge(a.rig.id, a.node.id, "lead@b", "escalates_to");
    const unclaimed = await work(a.session);
    expect(queue.waitingView(unclaimed.qitemId)!.nextBackstop.owner).toBe(b.session);
    const baton = await work(a.session, true);
    db.prepare("UPDATE queue_items SET last_nudge_result='delivered-ack-pending' WHERE qitem_id=?").run(baton.qitemId);
    expect(queue.waitingView(baton.qitemId)!.nextBackstop).toMatchObject({ owner: b.session, mechanism: "queue-wake-ladder:orchestrator" });
    db.prepare("UPDATE queue_items SET tags=? WHERE qitem_id=?").run(JSON.stringify([ESCALATION_HOP_TAG]), unclaimed.qitemId);
    expect(queue.waitingView(unclaimed.qitemId)!.nextBackstop.owner).toBe(a.session);
    queue = new QueueRepository(db, new EventBus(db), { validateRig: destination => destination !== b.session,
      loadHumanRegistry: () => ({ ok: true, entities: [] }) });
    expect(queue.waitingView(baton.qitemId)!.nextBackstop.owner).not.toBe(b.session);
  });

  it("exports deferred declarations without needing their targets to exist", () => {
    const a = seat("a", "lead", "lead@a");
    rigs.addEdge(a.rig.id, a.node.id, "absent@b", "escalates_to");
    const spec = new RigSpecExporter({ rigRepo: rigs, sessionRegistry: new SessionRegistry(db) }).exportRig(a.rig.id);
    expect(spec.edges).toContainEqual({ from: "lead", to: "absent@b", kind: "escalates_to" });
    expect(LegacyRigSpecSchema.validate(spec).errors).toEqual([]);
  });

  it("only escalation edges accept same-daemon deferred addresses", () => {
    const spec = { version: "0.2", name: "lane", pods: [{ id: "work", label: "Work", members: [{ id: "lead", runtime: "stub", agent_ref: "local:agents/lead", profile: "default", cwd: "." }], edges: [] }],
      edges: [{ from: "work.lead", to: "advisor@coord", kind: "escalates_to" }] };
    expect(RigSpecSchema.validate(spec).errors).toEqual([]);
    for (const target of ["advisor@coord@host", "external:thing", "human@kernel", "advisor@external"]) {
      expect(RigSpecSchema.validate({ ...spec, edges: [{ ...spec.edges[0], to: target }] }).valid).toBe(false);
    }
    expect(RigSpecSchema.validate({ ...spec, edges: [{ ...spec.edges[0], kind: "delegates_to" }] }).valid).toBe(false);
  });
});

it("upgrades existing edges without changing identity, constraints or cascade semantics", () => {
  const db = new Database(":memory:");
  try {
    migrate(db, ALL_MIGRATIONS.filter(m => !m.name.startsWith("126_")));
    const rigs = new RigRepository(db);
    const rig = rigs.createRig("old");
    const a = rigs.addNode(rig.id, "a");
    const b = rigs.addNode(rig.id, "b");
    const edge = rigs.addEdge(rig.id, a.id, b.id, "delegates_to");
    migrate(db, ALL_MIGRATIONS);
    expect(rigs.getRig(rig.id)!.edges).toEqual([edge]);
    const other = rigs.createRig("other");
    const c = rigs.addNode(other.id, "c");
    expect(() => rigs.addEdge(rig.id, a.id, c.id, "delegates_to")).toThrow(/same rig/);
    db.prepare("DELETE FROM nodes WHERE id=?").run(b.id);
    expect(rigs.getRig(rig.id)!.edges).toEqual([]);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { db.close(); }
});
