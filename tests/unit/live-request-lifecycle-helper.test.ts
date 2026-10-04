import test from "node:test";
import assert from "node:assert/strict";

import { on } from "../../src/lib/events/eventBus.ts";
import type {
  RequestCompletedPayload,
  RequestFailedPayload,
  RequestStartedPayload,
} from "../../src/lib/events/types.ts";
import { beginLiveRequest, runLiveRequestTail } from "../../open-sse/utils/liveRequestLifecycle.ts";

// Embeddings/audio handlers use this helper to light the topology node the same way chat
// does: request.started, then exactly one request.completed or request.failed with the same id.

type Captured = {
  started: RequestStartedPayload[];
  completed: RequestCompletedPayload[];
  failed: RequestFailedPayload[];
};

function capture(): { events: Captured; stop: () => void } {
  const events: Captured = { started: [], completed: [], failed: [] };
  const offs = [
    on("request.started", (p) => events.started.push(p)),
    on("request.completed", (p) => events.completed.push(p)),
    on("request.failed", (p) => events.failed.push(p)),
  ];
  return { events, stop: () => offs.forEach((off) => off()) };
}

const flush = async () => {
  await new Promise(setImmediate);
  await new Promise(setImmediate);
};

test("beginLiveRequest emits started then completed with the same id and provider", async () => {
  const { events, stop } = capture();
  try {
    const live = beginLiveRequest({ provider: "arc-embed", model: "qwen3-embedding-0.6b" });
    live.finish({ status: 200, tokens: { prompt_tokens: 4, total_tokens: 4 } });
    await flush();
    const started = events.started.filter((e) => e.id === live.id);
    const completed = events.completed.filter((e) => e.id === live.id);
    assert.equal(started.length, 1);
    assert.equal(completed.length, 1);
    assert.equal(started[0].provider, "arc-embed");
    assert.equal(completed[0].provider, "arc-embed");
    assert.equal(completed[0].model, "qwen3-embedding-0.6b");
    assert.equal(completed[0].tokensInput, 4);
    assert.equal(events.failed.filter((e) => e.id === live.id).length, 0);
  } finally {
    stop();
  }
});

test("beginLiveRequest: status 500 + error emits request.failed with the same id", async () => {
  const { events, stop } = capture();
  try {
    const live = beginLiveRequest({ provider: "arc-kokoro", model: "kokoro" });
    live.finish({ status: 500, error: "upstream down" });
    await flush();
    const failed = events.failed.filter((e) => e.id === live.id);
    assert.equal(failed.length, 1);
    assert.equal(failed[0].statusCode, 500);
    assert.equal(failed[0].provider, "arc-kokoro");
    assert.equal(failed[0].error, "upstream down");
    assert.equal(events.started.filter((e) => e.id === live.id).length, 1);
  } finally {
    stop();
  }
});

test("beginLiveRequest: finish is idempotent (one terminal event)", async () => {
  const { events, stop } = capture();
  try {
    const live = beginLiveRequest({ provider: "arc-whisper" });
    live.finish({ status: 200 });
    live.finish({ status: 500, error: "late" });
    await flush();
    const terminal =
      events.completed.filter((e) => e.id === live.id).length +
      events.failed.filter((e) => e.id === live.id).length;
    assert.equal(terminal, 1);
    assert.equal(events.completed.filter((e) => e.id === live.id).length, 1);
    assert.equal(events.started.find((e) => e.id === live.id)?.model, "unknown");
  } finally {
    stop();
  }
});
// The audio routes run their post-dispatch tail (cost, call log, headers) through
// runLiveRequestTail so a throw there can never leave a stuck "active" pulse.
test("runLiveRequestTail: a throwing tail rethrows and emits exactly one request.failed", async () => {
  const { events, stop } = capture();
  try {
    const live = beginLiveRequest({ provider: "arc-kokoro", model: "kokoro" });
    const boom = new Error("post-processing exploded");
    await assert.rejects(
      runLiveRequestTail(live, async () => {
        throw boom;
      }),
      (error) => error === boom
    );
    await flush();
    assert.equal(events.started.filter((e) => e.id === live.id).length, 1);
    const failed = events.failed.filter((e) => e.id === live.id);
    assert.equal(failed.length, 1);
    assert.equal(failed[0].statusCode, 500);
    assert.equal(failed[0].error, "post-processing exploded");
    assert.equal(events.completed.filter((e) => e.id === live.id).length, 0);
  } finally {
    stop();
  }
});
test("runLiveRequestTail: a finish issued before the throw wins (idempotent)", async () => {
  const { events, stop } = capture();
  try {
    const live = beginLiveRequest({ provider: "arc-whisper" });
    await assert.rejects(
      runLiveRequestTail(live, async () => {
        live.finish({ status: 200 });
        throw new Error("late failure");
      })
    );
    await flush();
    assert.equal(events.completed.filter((e) => e.id === live.id).length, 1);
    assert.equal(events.failed.filter((e) => e.id === live.id).length, 0);
  } finally {
    stop();
  }
});
test("runLiveRequestTail: a successful tail returns its value and adds no event", async () => {
  const { events, stop } = capture();
  try {
    const live = beginLiveRequest({ provider: "arc-kokoro" });
    const value = await runLiveRequestTail(live, async () => {
      live.finish({ status: 200 });
      return 42;
    });
    assert.equal(value, 42);
    await flush();
    assert.equal(events.completed.filter((e) => e.id === live.id).length, 1);
    assert.equal(events.failed.filter((e) => e.id === live.id).length, 0);
  } finally {
    stop();
  }
});
