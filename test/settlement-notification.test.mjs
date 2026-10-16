import assert from "node:assert/strict";
import test from "node:test";

import {
	isDispatchingSession,
	parentRunWasInterrupted,
	pendingSettlementToken,
	settlementDelivery,
} from "../shared.ts";

function run(overrides = {}) {
	return {
		version: 1,
		handle: "abc123",
		tmuxSession: "pi-subagent-abc123",
		runDir: "/tmp/subagents/abc123",
		sessionFile: "/tmp/subagents/abc123/session.jsonl",
		cwd: "/tmp",
		provider: "test",
		model: "test",
		thinking: "off",
		state: "idle",
		hasStarted: true,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:01.000Z",
		...overrides,
	};
}

test("a durable settlement is delivered once", () => {
	const settledAt = "2026-01-01T00:00:02.000Z";
	assert.equal(pendingSettlementToken(run({ settledAt }), "busy", "idle"), settledAt);
	assert.equal(
		pendingSettlementToken(run({ settledAt, parentNotifiedSettledAt: settledAt }), "busy", "idle"),
		undefined,
	);
});

test("each later settled turn has a new token even if another turn is already busy", () => {
	const previous = "2026-01-01T00:00:02.000Z";
	const current = "2026-01-01T00:00:03.000Z";
	assert.equal(
		pendingSettlementToken(run({ settledAt: current, parentNotifiedSettledAt: previous }), "idle", "busy"),
		current,
	);
});

test("legacy children notify only on an observed transition to idle", () => {
	const metadata = run();
	assert.equal(pendingSettlementToken(metadata, "busy", "idle"), `legacy:${metadata.updatedAt}`);
	assert.equal(pendingSettlementToken(metadata, "idle", "idle"), undefined);
	assert.equal(pendingSettlementToken(metadata, undefined, "idle"), undefined);
});

test("a child that never started cannot report a settlement", () => {
	assert.equal(
		pendingSettlementToken(run({ hasStarted: false, settledAt: "2026-01-01T00:00:02.000Z" }), "starting", "idle"),
		undefined,
	);
});

test("delivery waits for a persistent idle parent and preserves an interrupted run", () => {
	assert.equal(settlementDelivery("tui", false, false), undefined);
	assert.equal(settlementDelivery("print", true, false), undefined);
	assert.equal(settlementDelivery("json", true, false), undefined);
	assert.equal(settlementDelivery("tui", true, true), "display");
	assert.equal(settlementDelivery("rpc", true, false), "trigger");
	assert.equal(parentRunWasInterrupted(true, "stop"), true);
	assert.equal(parentRunWasInterrupted(false, "aborted"), true);
	assert.equal(parentRunWasInterrupted(false, "error"), true);
	assert.equal(parentRunWasInterrupted(false, "stop"), false);
});

test("only the dispatching Pi session can acknowledge a wait", () => {
	const metadata = run({ parentSessionId: "parent-1" });
	assert.equal(isDispatchingSession(metadata, "parent-1"), true);
	assert.equal(isDispatchingSession(metadata, "parent-2"), false);
	assert.equal(isDispatchingSession(metadata, undefined), false);
});
