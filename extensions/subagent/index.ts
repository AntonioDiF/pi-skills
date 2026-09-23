/**
 * pi-subagent — delegate tasks to subagents
 *
 * Tool:
 *   subagent — run a self-contained task in a separate pi process with its
 *              own context window. Returns the subagent's final answer plus
 *              usage stats (turns, tokens, cost, context, model).
 *
 *   Modes:
 *     single:   { task, ... }
 *     parallel: { tasks: [{ task, ... }, ...] }   (max 8, 4 at a time)
 *
 *   Model resolution (per task, first match wins):
 *     1. model param: "provider/model-id" with optional ":thinking"
 *        suffix, e.g. "adf/adf-mini" or "adf/adf-main:xhigh"
 *     2. thinking param (when the model does not pin a level)
 *     3. "medium", if the current session model supports it
 *     4. the session's current thinking level, if supported
 *     5. no thinking flag (pi default)
 *
 *   Subagents run as `pi --mode json -p --no-session` subprocesses in the
 *   same cwd, so AGENTS.md/project context, user skills and extensions all
 *   apply. A depth guard (env PI_SUBAGENT_DEPTH) hides the tool from
 *   subagents beyond the limit so recursion cannot run away.
 *
 * Config (env vars):
 *   PI_SUBAGENT_MAX_DEPTH     max recursion depth (default 2: main ->
 *                             subagent -> sub-subagent, no further)
 *   PI_SUBAGENT_MAX_PARALLEL  max parallel tasks (default 8)
 *   PI_SUBAGENT_CONCURRENCY   max concurrent subagent processes (default 4)
 *   PI_SUBAGENT_OUTPUT_CAP    per-task output cap in bytes (default 51200)
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { Type } from "typebox";

// ============================== config ==============================

function intEnv(name: string, def: number): number {
	const v = parseInt(process.env[name] ?? "", 10);
	return Number.isFinite(v) && v > 0 ? v : def;
}

const MAX_DEPTH = intEnv("PI_SUBAGENT_MAX_DEPTH", 2);
const MAX_PARALLEL = intEnv("PI_SUBAGENT_MAX_PARALLEL", 8);
const CONCURRENCY = intEnv("PI_SUBAGENT_CONCURRENCY", 4);
const OUTPUT_CAP = intEnv("PI_SUBAGENT_OUTPUT_CAP", 50 * 1024);
const CURRENT_DEPTH = intEnv("PI_SUBAGENT_DEPTH", 0);

const THINKING_LEVELS: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const DEFAULT_SYSTEM_PROMPT = [
	"You are a subagent delegated a self-contained task. You do not have access to the parent conversation: work only from the task text, the files on disk, and your tools.",
	"Complete the task autonomously; do not ask questions.",
	"Your final message is delivered to the parent agent as your answer: make it complete and self-contained (include file paths, key code and results) and keep it focused.",
].join("\n");

// ============================== types ==============================

interface TaskSpec {
	task: string;
	model?: string;
	thinking?: ModelThinkingLevel;
	system?: string;
	tools?: string;
	cwd?: string;
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface TaskResult {
	spec: TaskSpec;
	modelLabel: string;
	thinking: ModelThinkingLevel | undefined;
	exitCode: number;
	finalText: string;
	stderr: string;
	usage: UsageStats;
	stopReason?: string;
	errorMessage?: string;
	aborted: boolean;
}

interface SubagentDetails {
	mode: "single" | "parallel";
	results: TaskResult[];
}

interface ModelRegistryLike {
	find(provider: string, modelId: string): Model<any> | undefined;
	getAvailable(): Model<any>[];
	getAll(): Model<any>[];
}

interface SubagentContext {
	cwd: string;
	model: Model<any> | undefined;
	thinkingLevel: ModelThinkingLevel | undefined;
	modelRegistry: ModelRegistryLike;
}

// ============================== helpers ==============================

function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

function supportedLevels(model: Model<any>): ModelThinkingLevel[] {
	return getSupportedThinkingLevels(model);
}

function supportsLevel(model: Model<any>, level: ModelThinkingLevel): boolean {
	return supportedLevels(model).includes(level);
}

function findModel(registry: ModelRegistryLike, ref: string): Model<any> | undefined {
	if (ref.includes("/")) {
		const [provider, ...rest] = ref.split("/");
		return registry.find(provider, rest.join("/"));
	}
	return registry.getAll().find((m) => m.id === ref);
}

function formatModelList(models: Model<any>[]): string {
	return models
		.map((m) => {
			const levels = m.reasoning ? supportedLevels(m).filter((l) => l !== "off") : [];
			return levels.length > 0 ? `${m.provider}/${m.id} (${levels.join(", ")})` : `${m.provider}/${m.id}`;
		})
		.join(", ");
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 1000000) return `${(count / 1000).toFixed(1)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsage(usage: UsageStats, modelLabel: string, thinking: ModelThinkingLevel | undefined): string {
	const parts: string[] = [];
	if (usage.turns > 0) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input > 0) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output > 0) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.contextTokens > 0) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	if (usage.cost > 0) parts.push(`$${usage.cost.toFixed(4)}`);
	parts.push(modelLabel + (thinking && thinking !== "off" ? ` (${thinking})` : ""));
	return parts.join(" ");
}

function truncateOutput(text: string): string {
	const byteLength = Buffer.byteLength(text, "utf8");
	if (byteLength <= OUTPUT_CAP) return text;
	let cut = text.slice(0, OUTPUT_CAP);
	while (Buffer.byteLength(cut, "utf8") > OUTPUT_CAP) cut = cut.slice(0, -1);
	return `${cut}\n\n[Output truncated: ${byteLength - Buffer.byteLength(cut, "utf8")} bytes omitted]`;
}

function tail(text: string, maxChars: number): string {
	return text.length > maxChars ? `...${text.slice(-maxChars)}` : text;
}

function previewTask(task: string, maxChars = 80): string {
	const firstLine = task.split("\n")[0].trim();
	return firstLine.length > maxChars ? `${firstLine.slice(0, maxChars - 3)}...` : firstLine;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

async function writeTempFile(prefix: string, content: string): Promise<string> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const filePath = path.join(dir, `${prefix}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, content, { encoding: "utf-8", mode: 0o600 });
	});
	return filePath;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

// ============================== model resolution ==============================

interface ResolvedModel {
	model: Model<any>;
	thinking: ModelThinkingLevel | undefined;
	label: string;
}

function resolveTaskModel(spec: TaskSpec, ctx: SubagentContext): ResolvedModel | { error: string } {
	let model: Model<any> | undefined;
	let pinned: ModelThinkingLevel | undefined;

	if (spec.model) {
		const idx = spec.model.lastIndexOf(":");
		let ref = spec.model;
		if (idx > 0) {
			const suffix = spec.model.slice(idx + 1);
			if ((THINKING_LEVELS as string[]).includes(suffix)) {
				pinned = suffix as ModelThinkingLevel;
				ref = spec.model.slice(0, idx);
			}
		}
		model = findModel(ctx.modelRegistry, ref);
		if (!model) {
			return {
				error: `Unknown model "${spec.model}". Available: ${formatModelList(ctx.modelRegistry.getAvailable())}`,
			};
		}
	} else {
		model = ctx.model;
	}
	if (!model) {
		return { error: "No model available for the subagent. Pass an explicit model." };
	}

	const label = `${model.provider}/${model.id}`;

	let thinking: ModelThinkingLevel | undefined;
	const requested = pinned ?? spec.thinking;
	if (requested) {
		if (!supportsLevel(model, requested)) {
			return {
				error: `Model ${label} does not support thinking level "${requested}". Supported: ${supportedLevels(model).join(", ")}`,
			};
		}
		thinking = requested;
	} else if (supportsLevel(model, "medium")) {
		thinking = "medium";
	} else if (ctx.thinkingLevel && supportsLevel(model, ctx.thinkingLevel)) {
		thinking = ctx.thinkingLevel;
	}

	return { model, thinking, label };
}

// ============================== execution ==============================

function isFailed(r: TaskResult): boolean {
	return r.aborted || r.exitCode !== 0 || r.stopReason === "error";
}

function formatResult(r: TaskResult): string {
	const usage = formatUsage(r.usage, r.modelLabel, r.thinking);
	const body = truncateOutput(r.finalText || "(no output)");
	if (r.aborted) return `${body}\n\n---\nsubagent aborted (${usage})`;
	if (isFailed(r)) {
		const reason = r.errorMessage || tail(r.stderr, 500) || `exit code ${r.exitCode}`;
		const footer = r.modelLabel ? `\n(${usage})` : "";
		return `${body}\n\n---\nsubagent failed: ${reason}${footer}`;
	}
	return `${body}\n\n---\n${usage}`;
}

function formatResults(results: TaskResult[]): string {
	return results
		.map((r, i) => `### ${i + 1}. ${previewTask(r.spec.task)}\n\n${formatResult(r)}`)
		.join("\n\n");
}

function progressText(r: TaskResult): string {
	const turns = r.usage.turns > 0 ? `, ${r.usage.turns} turns` : "";
	const head = `[${r.modelLabel || "?"}${r.thinking ? ` (${r.thinking})` : ""}] running${turns}\n`;
	return head + (r.finalText || "(working...)");
}

function parallelProgress(results: (TaskResult | undefined)[]): string {
	return results
		.map((r, i) => {
			if (!r) return null;
			const turns = r.usage.turns > 0 ? `, ${r.usage.turns} turns` : "";
			const text = tail((r.finalText || "(working...)").replace(/\n+/g, " "), 200);
			return `[${i + 1}/${results.length}] ${r.modelLabel || "?"}${r.thinking ? ` (${r.thinking})` : ""} running${turns}: ${text}`;
		})
		.filter((line): line is string => line !== null)
		.join("\n");
}

async function runSubagent(
	spec: TaskSpec,
	ctx: SubagentContext,
	signal: AbortSignal | undefined,
	onProgress?: (r: TaskResult) => void,
): Promise<TaskResult> {
	const resolved = resolveTaskModel(spec, ctx);
	if ("error" in resolved) {
		return {
			spec,
			modelLabel: spec.model ?? "",
			thinking: undefined,
			exitCode: 1,
			finalText: resolved.error,
			stderr: "",
			usage: emptyUsage(),
			aborted: false,
		};
	}

	const { thinking, label } = resolved;
	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	args.push("--model", label);
	if (thinking) args.push("--thinking", thinking);
	if (spec.tools?.trim()) args.push("--tools", spec.tools);

	const systemPrompt = [DEFAULT_SYSTEM_PROMPT, spec.system?.trim()].filter(Boolean).join("\n\n");
	const promptPath = await writeTempFile("system-prompt", systemPrompt);
	args.push("--append-system-prompt", promptPath);
	args.push(`Task: ${spec.task}`);

	const result: TaskResult = {
		spec,
		modelLabel: label,
		thinking,
		exitCode: 0,
		finalText: "",
		stderr: "",
		usage: emptyUsage(),
		aborted: false,
	};

	const emit = () => onProgress?.(result);

	try {
		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: spec.cwd ? path.resolve(ctx.cwd, spec.cwd) : ctx.cwd,
				shell: false,
				// Own process group so abort can kill nested subagents too
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, PI_SUBAGENT_DEPTH: String(CURRENT_DEPTH + 1) },
			});
			proc.stdout.setEncoding("utf8");
			proc.stderr.setEncoding("utf8");
			let buffer = "";
			let exited = false;

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}
				if (event.type !== "message_end" || !event.message) return;
				const msg = event.message;
				if (msg.role !== "assistant") return;
				result.usage.turns++;
				const usage = msg.usage;
				if (usage) {
					result.usage.input += usage.input || 0;
					result.usage.output += usage.output || 0;
					result.usage.cacheRead += usage.cacheRead || 0;
					result.usage.cacheWrite += usage.cacheWrite || 0;
					result.usage.cost += usage.cost?.total || 0;
					result.usage.contextTokens = usage.totalTokens || 0;
				}
				result.stopReason = msg.stopReason;
				result.errorMessage = msg.errorMessage;
				let text = "";
				for (const part of msg.content) {
					if (part.type === "text" && part.text) text = text ? `${text}\n\n${part.text}` : part.text;
				}
				if (text) result.finalText = text;
				emit();
			};

			proc.stdout.on("data", (data: string) => {
				buffer += data;
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data: string) => {
				result.stderr += data;
			});

			proc.on("close", (code, sig) => {
				exited = true;
				if (buffer.trim()) processLine(buffer);
				if (code === null && sig) {
					result.errorMessage = `terminated by ${sig}`;
					resolve(1);
				} else {
					resolve(code ?? 0);
				}
			});

			proc.on("error", (err) => {
				result.stderr = result.stderr ? `${result.stderr}\n${err.message}` : err.message;
				resolve(1);
			});

			// Kill the whole process group: a nested pi can outlive a signal to the direct child.
			// On win32 group kill is unsupported, so only the direct child is killed.
			const killGroup = (sig: NodeJS.Signals) => {
				if (proc.pid == null) return;
				try {
					if (process.platform === "win32") proc.kill(sig);
					else process.kill(-proc.pid, sig);
				} catch {
					/* ESRCH: already gone */
				}
			};

			if (signal) {
				const killProc = () => {
					result.aborted = true;
					killGroup("SIGTERM");
					setTimeout(() => {
						if (!exited) killGroup("SIGKILL");
					}, 5000);
					emit();
				};
				if (signal.aborted) killProc();
				else {
					// Drop the listener once the child is gone: a later abort of the
					// run signal must not touch a finished result or signal a dead group.
					const detach = () => signal.removeEventListener("abort", killProc);
					signal.addEventListener("abort", killProc, { once: true });
					proc.on("close", detach);
					proc.on("error", detach);
				}
			}
		});

		result.exitCode = exitCode;
		if (!result.finalText && result.aborted) result.finalText = "Subagent aborted.";
		if (!result.finalText && (exitCode !== 0 || result.stopReason === "error")) {
			result.finalText = tail(result.stderr, 1000) || "(no output)";
		}
		return result;
	} finally {
		try {
			fs.unlinkSync(promptPath);
			fs.rmdirSync(path.dirname(promptPath));
		} catch {
			/* ignore */
		}
	}
}

// ============================== tool ==============================

const ThinkingParam = Type.Union(
	THINKING_LEVELS.map((l) => Type.Literal(l)),
	{ description: "Thinking level, used when the model does not pin one (see description)" },
);

const ModelParam = Type.Optional(
	Type.String({
		description:
			'Model override: "provider/model-id" with optional ":thinking" suffix, e.g. "adf/adf-mini" or "adf/adf-main:xhigh". Default: current session model at medium thinking (if supported).',
	}),
);

const taskFields = {
	model: ModelParam,
	thinking: Type.Optional(ThinkingParam),
	system: Type.Optional(
		Type.String({ description: "Extra role instructions appended to the subagent system prompt, e.g. 'you are a code reviewer; do not modify files'" }),
	),
	tools: Type.Optional(
		Type.String({ description: "Comma-separated tool restriction for the subagent, e.g. 'read, grep, bash'. Default: all tools" }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the subagent (default: current)" })),
};

const TaskItem = Type.Object({
	task: Type.String({
		description: "Self-contained task. The subagent does not see this conversation, so include all needed context (file paths, code, constraints)",
	}),
	...taskFields,
});

const SubagentParams = Type.Object({
	task: Type.Optional(TaskItem.properties.task),
	tasks: Type.Optional(
		Type.Array(
			TaskItem,
			{ description: `Parallel tasks (max ${MAX_PARALLEL}, ${CONCURRENCY} concurrent). Top-level model/thinking/system/tools/cwd apply to all tasks; per-task values take precedence.` },
		),
	),
	agent: Type.Optional(
		Type.String({ description: "Reserved for named agent definitions (not supported yet; use system for role instructions)" }),
	),
	...taskFields,
});

export default function (pi: ExtensionAPI) {
	if (CURRENT_DEPTH >= MAX_DEPTH) return;

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate a self-contained task to a subagent: a separate pi session with its own context window.",
			"Returns the subagent's final answer plus usage stats (turns, tokens, cost, context, model).",
			"The subagent does NOT see this conversation: include all needed context in the task.",
			`Defaults to the current model at medium thinking (if the model supports it); override with model (e.g. "adf/adf-mini") and/or thinking (e.g. "xhigh").`,
			`Use tasks for independent parallel work (max ${MAX_PARALLEL}, ${CONCURRENCY} concurrent).`,
			"Restrict the subagent's tools with tools; set its role with system.",
		].join(" "),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const details = (mode: "single" | "parallel", results: TaskResult[]): SubagentDetails => ({ mode, results });
			const textResult = (text: string, d: SubagentDetails) => ({ content: [{ type: "text", text }], details: d });

			if (params.agent) {
				const msg = `Agent "${params.agent}": named agent definitions are not supported yet (create .md files in ${path.join(
					getAgentDir(),
					"agents",
				)} once they are). Use the system parameter for role instructions.`;
				return textResult(msg, details("single", []));
			}

			const emptyTask = (specs: TaskSpec[]) => specs.find((s) => !s.task.trim());
			const topLevel: Partial<TaskSpec> = { model: params.model, thinking: params.thinking, system: params.system, tools: params.tools, cwd: params.cwd };
			const single: TaskSpec[] | null = params.task !== undefined ? [{ task: params.task, ...topLevel }] : null;
			const tasks: TaskSpec[] | null = params.tasks ? params.tasks.map((t) => ({ ...topLevel, ...t })) : null;

			if (single && emptyTask(single)) return textResult("task must not be empty.", details("single", []));
			if (tasks && emptyTask(tasks)) return textResult("Each parallel task needs a non-empty task.", details("parallel", []));

			if (single && tasks) return textResult("Provide exactly one of task (single) or tasks (parallel).", details("single", []));
			if (!single && (!tasks || tasks.length === 0)) {
				return textResult("Provide task (single mode) or tasks (parallel mode).", details("single", []));
			}
			if (tasks && tasks.length > MAX_PARALLEL) {
				return textResult(`At most ${MAX_PARALLEL} parallel tasks (got ${tasks.length}).`, details("parallel", []));
			}

			const subCtx: SubagentContext = {
				cwd: ctx.cwd,
				model: ctx.model,
				thinkingLevel: ctx.thinkingLevel,
				modelRegistry: ctx.modelRegistry,
			};

			if (single) {
				const result = await runSubagent(single[0], subCtx, signal, (r) => {
					onUpdate?.({ content: [{ type: "text", text: progressText(r) }], details: details("single", [r]) });
				});
				return {
					content: [{ type: "text", text: formatResult(result) }],
					details: details("single", [result]),
				};
			}

			const results: (TaskResult | undefined)[] = new Array(tasks!.length).fill(undefined);
			await mapWithConcurrencyLimit(tasks!, CONCURRENCY, (spec, i) =>
				runSubagent(spec, subCtx, signal, (r) => {
					results[i] = r;
					onUpdate?.({
						content: [{ type: "text", text: parallelProgress(results) }],
						details: details("parallel", results.filter(Boolean) as TaskResult[]),
					});
				}).then((r) => {
					results[i] = r;
				}),
			);
			const all = results as TaskResult[];
			return {
				content: [{ type: "text", text: formatResults(all) }],
				details: details("parallel", all),
			};
		},
	});
}
