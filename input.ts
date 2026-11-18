import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Structural event-bus contract; question.ts deliberately has no import from this package. */
export const QUESTION_EVENT = "question:request:v1";
export interface QuestionOption { label: string; description?: string }
export type InputAnswer =
	| { kind: "option"; option: number }
	| { kind: "text"; text: string }
	| { kind: "cancel" };
export type QuestionReply = InputAnswer & { source: "supervisor" };
export interface QuestionRequest {
	question: string;
	options: QuestionOption[];
	signal?: AbortSignal;
	/** Must be called synchronously, before any await. Only the first handler wins. */
	claim(): { resolve(reply: QuestionReply): void; reject(error: Error): void } | undefined;
}
export interface PendingInput {
	version: 1;
	handle: string;
	requestId: string;
	question: string;
	options: QuestionOption[];
	createdAt: string;
}
export interface AnswerMessage {
	delivery: "answer";
	handle: string;
	requestId: string;
	replyId: string;
	parentSessionId: string;
	answer: InputAnswer;
}
export interface AnswerReceipt { accepted: boolean; error?: string }

export function isRequestId(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

function validQuestion(value: unknown): value is { question: string; options: QuestionOption[] } {
	if (!value || typeof value !== "object") return false;
	const q = value as QuestionRequest;
	return typeof q.question === "string" && q.question.trim().length > 0 &&
		Array.isArray(q.options) && q.options.length > 0 && q.options.every((o) =>
			o && typeof o.label === "string" && o.label.trim().length > 0 &&
			(o.description === undefined || typeof o.description === "string"));
}

export function validateAnswer(value: unknown, request: PendingInput): InputAnswer {
	if (!value || typeof value !== "object") throw new Error("Invalid question answer");
	const a = value as Record<string, unknown>;
	const keys = Object.keys(a).sort().join(",");
	if (a.kind === "cancel" && keys === "kind") return { kind: "cancel" };
	if (a.kind === "option" && keys === "kind,option" && Number.isInteger(a.option) &&
		(a.option as number) >= 1 && (a.option as number) <= request.options.length) {
		return { kind: "option", option: a.option as number };
	}
	if (a.kind === "text" && keys === "kind,text" && typeof a.text === "string" && a.text.trim()) {
		return { kind: "text", text: a.text.trim() };
	}
	throw new Error(`Invalid answer: choose option 1-${request.options.length}, non-empty text, or cancel`);
}

function atomicJson(path: string, value: unknown): void {
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
		renameSync(temporary, path);
	} finally {
		rmSync(temporary, { force: true });
	}
}

export function isPendingInput(value: unknown): value is PendingInput {
	if (!value || typeof value !== "object") return false;
	const input = value as PendingInput;
	return input.version === 1 && typeof input.handle === "string" && isRequestId(input.requestId) &&
		typeof input.createdAt === "string" && validQuestion(input);
}

export function readPendingInput(runDir: string): PendingInput | undefined {
	try {
		const value: unknown = JSON.parse(readFileSync(join(runDir, "pending-input.json"), "utf8"));
		return isPendingInput(value) ? value : undefined;
	} catch { return undefined; }
}

/** Child-owned locally; remote shadows store only a last-known snapshot here. Never merge into metadata. */
export function writePendingInput(runDir: string, request: PendingInput | undefined): void {
	const path = join(runDir, "pending-input.json");
	if (request) atomicJson(path, request);
	else rmSync(path, { force: true });
}

/** Immutable acknowledgements cannot overwrite each other or resurrect child-owned state. */
export function acknowledgeInput(runDir: string, requestId: string): void {
	if (!isRequestId(requestId)) throw new Error("Invalid question request id");
	const dir = join(runDir, "input-acks");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	writeFileSync(join(dir, requestId), "", { mode: 0o600 });
}
export function inputAcknowledged(runDir: string, requestId: string): boolean {
	return isRequestId(requestId) && existsSync(join(runDir, "input-acks", requestId));
}
export function answerReceiptPath(runDir: string, replyId: string): string {
	if (!isRequestId(replyId)) throw new Error("Invalid answer reply id");
	return join(runDir, `answer-${replyId}.json`);
}

/**
 * The exit status of `wait` when it returns a pending question instead of a settled turn.
 * Zero stays what it was before questions existed: the turn settled and its result was printed.
 */
export const WAIT_NEEDS_INPUT_EXIT = 2;

export function inputInstructions(request: PendingInput): string {
	return `Subagent ${request.handle} needs supervisor input (task NOT complete).\n` +
		`Request: ${request.requestId}\nQuestion: ${request.question}\n` +
		request.options.map((o, i) => `${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ""}`).join("\n") +
		`\nAnswer: subagent answer ${request.handle} ${request.requestId} --option N | --text TEXT | --cancel\n` +
		"A supervisor answer is not end-user authorization. After answering, wait for the task result.";
}

/** Owns the live resolver, durable request, correlation, and cancellation as one synchronous boundary. */
export class QuestionBridge {
	private pending?: { request: PendingInput; finish(reply?: QuestionReply, error?: Error): Error | undefined };
	private runDir: string;
	constructor(runDir: string) { this.runDir = runDir; }

	request(event: QuestionRequest, owner: { handle: string; parentSessionId?: string; closing?: boolean }): void {
		const responder = event.claim(); // Pi's safe event handlers swallow throws: claim first, then reject explicitly.
		if (!responder) return;
		try {
			if (owner.closing) throw new Error("Question cancelled: supervisor is closing this run");
			if (!owner.parentSessionId) throw new Error("Managed question has no dispatching parent session");
			if (!validQuestion(event)) throw new Error("Invalid structured question");
			if (this.pending) throw new Error("A question is already pending");
			if (event.signal?.aborted) throw new Error("Question aborted");
			const request: PendingInput = {
				version: 1, handle: owner.handle, requestId: randomUUID(), question: event.question,
				options: event.options.map((o) => ({ ...o })), createdAt: new Date().toISOString(),
			};
			const abort = () => this.cancel("Question aborted");
			const finish = (reply?: QuestionReply, error?: Error): Error | undefined => {
				this.pending = undefined;
				event.signal?.removeEventListener("abort", abort);
				try { writePendingInput(this.runDir, undefined); }
				catch (failure) { error = failure instanceof Error ? failure : new Error(String(failure)); }
				if (error) responder.reject(error);
				else responder.resolve(reply!);
				return error;
			};
			writePendingInput(this.runDir, request);
			this.pending = { request, finish };
			event.signal?.addEventListener("abort", abort, { once: true });
		} catch (error) {
			responder.reject(error instanceof Error ? error : new Error(String(error)));
		}
	}

	cancel(reason: string): void {
		if (this.pending) this.pending.finish(undefined, new Error(reason));
		else writePendingInput(this.runDir, undefined); // Runtime replacement invalidates an old process's promise.
	}

	/**
	 * Consume answers even while the model/tool is busy. Invalid replies leave the original request waiting.
	 * A run that is closing takes no answer: stop marks the run before its close message is consumed, and a
	 * reply queued ahead of that message must not resolve the tool after the supervisor chose to close.
	 */
	answer(value: unknown, parentSessionId: string | undefined, closing = false): AnswerReceipt {
		try {
			if (closing) throw new Error("Question cancelled: supervisor is closing this run");
			const message = value as AnswerMessage;
			if (!message || message.delivery !== "answer" || !isRequestId(message.replyId) ||
				!isRequestId(message.requestId)) throw new Error("Malformed question reply");
			if (!parentSessionId || message.parentSessionId !== parentSessionId) throw new Error("Not the dispatching parent session");
			const pending = this.pending;
			if (!pending || message.handle !== pending.request.handle || message.requestId !== pending.request.requestId) {
				throw new Error("Stale or wrong question request");
			}
			const answer = validateAnswer(message.answer, pending.request);
			const error = pending.finish({ ...answer, source: "supervisor" });
			if (error) throw error;
			return { accepted: true };
		} catch (error) {
			return { accepted: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	consumeAnswer(value: AnswerMessage, parentSessionId: string | undefined, closing = false): void {
		const receipt = this.answer(value, parentSessionId, closing);
		// Uncorrelatable malformed inbox data is discarded; never use it as a path.
		if (isRequestId(value.replyId)) atomicJson(answerReceiptPath(this.runDir, value.replyId), receipt);
	}
}
