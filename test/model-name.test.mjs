import assert from "node:assert/strict";
import test from "node:test";
import { shortModelName } from "../shared.ts";

test("the widget names Bedrock global profiles by family and version", () => {
	assert.equal(shortModelName("global.anthropic.claude-opus-5-5"), "opus 5.5");
	assert.equal(shortModelName("global.anthropic.claude-opus-5"), "opus 5");
	assert.equal(shortModelName("global.anthropic.claude-fable-5-2"), "fable 5.2");
	assert.equal(shortModelName("global.openai.gpt-6.2-sol"), "gpt 6.2 sol");
	assert.equal(shortModelName("global.openai.gpt-6-astra"), "gpt 6 astra");
	assert.equal(shortModelName("global.moonshotai.kimi-k3.1"), "kimi k3.1");
	assert.equal(shortModelName("global.zai.glm-5.3"), "glm 5.3");
	assert.equal(shortModelName("global.xai.grok-4.7"), "grok 4.7");
});

test("the widget drops version stamps, dates and router namespaces", () => {
	assert.equal(shortModelName("us.anthropic.claude-opus-4-5-20251101-v1:0"), "opus 4.5");
	assert.equal(shortModelName("anthropic.claude-opus-4-6-v1"), "opus 4.6");
	assert.equal(shortModelName("anthropic.claude-3-5-sonnet-20240620-v1:0"), "3.5 sonnet");
	assert.equal(shortModelName("claude-sonnet-4-5-20250929"), "sonnet 4.5");
	assert.equal(shortModelName("anthropic/claude-opus-4.5"), "opus 4.5");
	assert.equal(shortModelName("amazon.nova-pro-v1:0"), "nova pro");
	assert.equal(shortModelName("us-gov.openai.gpt-oss-120b-1:0"), "gpt oss 120b 1:0");
});

test("a version or name that only looks like a stamp is kept", () => {
	// Dropping these would merge different models, or leave a name with no family.
	assert.equal(shortModelName("sakana/fugu-ultra-v2"), "fugu ultra v2");
	assert.equal(shortModelName("nvidia.nemotron-nano-12b-v2"), "nemotron nano 12b v2");
	assert.equal(shortModelName("deepseek.v3-v1:0"), "deepseek.v3");
	assert.equal(shortModelName("llama.cpp"), "llama.cpp");
	assert.equal(shortModelName("model.gguf"), "model.gguf");
	assert.equal(shortModelName("claude-sonnet-4-20250514-thinking"), "sonnet 4 20250514 thinking");
	assert.equal(shortModelName("mymodel"), "mymodel");
	assert.equal(shortModelName("foo/"), "foo/");
});

test("hyphens between digits join only in Anthropic IDs", () => {
	assert.equal(shortModelName("qwen3-235b-a22b"), "qwen3 235b a22b");
	assert.equal(shortModelName("gpt-4o"), "gpt 4o");
});
