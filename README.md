# pi-skills

Reusable skills for [pi](https://pi.dev) and other harnesses.

Each skill is a self-contained folder that can be copied or symlinked into `~/.pi/agent/` on any machine.

## Skills

| Folder | Purpose |
| ------ | ---------- |
| `extensions/web/` | **pi-web**: `web_search` and `web_fetch` tools, plus a `/web` command. |
| `extensions/subagent/` | **pi-subagent**: `subagent` tool that delegates self-contained tasks to isolated pi sessions (single or parallel, up to 8 tasks / 4 concurrent). |

## System prompt

| Folder | Purpose |
| ------ | ---------- |
| `append-system/` | **append-system**: default communication style installed as `~/.pi/agent/APPEND_SYSTEM.md`, shaped for a reader with a small working memory. |

## Install

```bash
ln -s /path/to/pi-skills/extensions/web ~/.pi/agent/extensions/web
ln -s /path/to/pi-skills/extensions/subagent ~/.pi/agent/extensions/subagent
ln -s /path/to/pi-skills/append-system/APPEND_SYSTEM.md ~/.pi/agent/APPEND_SYSTEM.md
```

See each skill's README for usage and configuration.
