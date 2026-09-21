# pi-subagent

Delegate tasks to subagents for [pi](https://pi.dev): one tool that runs
self-contained tasks in separate pi sessions with isolated context windows.

## Tool (callable by the model)

### `subagent`

Runs a task in a `pi --mode json -p --no-session` subprocess and returns the
subagent's final answer plus usage stats (turns, tokens, cost, context, model).

- **Single mode**: `{ task, ... }`
- **Parallel mode**: `{ tasks: [{ task, ... }, ...] }` — up to 8 tasks, 4
  concurrent. Use it for independent work (e.g. "review module A" and
  "review module B"). Top-level `model`/`thinking`/`system`/`tools`/`cwd`
  apply to all tasks; per-task values take precedence.
- The subagent does **not** see the parent conversation. The task must be
  self-contained: file paths, code, constraints.
- Live progress streams into the tool output while the subagent runs; Ctrl+C
  kills the subprocess.

### Model resolution (per task, first match wins)

1. `model` param: `"provider/model-id"` with optional `":thinking"` suffix,
   e.g. `"adf/adf-mini"` or `"adf/adf-main:xhigh"`
2. `thinking` param, when the model does not pin a level
3. `medium`, if the current session model supports it (checked against the
   model's `thinkingLevelMap`)
4. the session's current thinking level, if the model supports it
5. no thinking flag (pi default)

So with `adf` as the current provider: subagents default to `adf-main`
(medium); pass `thinking: "xhigh"` for very complex tasks,
`model: "adf/adf-mini"` for cheap ones. An explicit level the model does not
support is an error listing the supported levels, so the model can retry.

### Parameters

| Parameter  | Scope          | Effect                                                        |
| ---------- | -------------- | ------------------------------------------------------------- |
| `task`     | single         | The self-contained task                                       |
| `tasks`    | parallel       | Array of task items, each with its own overrides              |
| `model`    | both           | `"provider/model-id[:thinking]"` override                     |
| `thinking` | both           | `off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`           |
| `system`   | both           | Role instructions appended to the subagent system prompt      |
| `tools`    | both           | Comma-separated tool restriction, e.g. `"read, grep, bash"` (default: all) |
| `cwd`      | both           | Working directory (default: current)                          |
| `agent`    | both           | Reserved for named agent definitions (not supported yet)      |

## Subagent environment

- Runs in the same cwd, so AGENTS.md/project context applies.
- Loads the same user skills and extensions as the parent session, so
  subagents can use tools like `web_search`.
- Same permissions as the parent: bash, file writes, etc.
- Depth guard: the tool sets `PI_SUBAGENT_DEPTH` for each subprocess and
  hides itself beyond `PI_SUBAGENT_MAX_DEPTH` (default 2), so subagents can
  spawn one more level of subagents and no further.

## Config (env vars)

| Variable                 | Default | Effect                          |
| ------------------------ | ------- | ------------------------------- |
| `PI_SUBAGENT_MAX_DEPTH`  | 2       | Max subagent recursion depth    |
| `PI_SUBAGENT_MAX_PARALLEL` | 8     | Max parallel tasks per call     |
| `PI_SUBAGENT_CONCURRENCY` | 4      | Max concurrent subagent processes |
| `PI_SUBAGENT_OUTPUT_CAP` | 51200   | Per-task output cap in bytes    |

## Install

Symlink the folder into the agent dir (see the repo root README for the
general convention):

```bash
ln -s "$PWD/extensions/subagent" ~/.pi/agent/extensions/subagent
```
