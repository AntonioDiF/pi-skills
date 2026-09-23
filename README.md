# pi-skills

Reusable skills for [pi](https://pi.dev) and other harnesses.

Each skill is a self-contained folder that can be copied or symlinked into `~/.pi/agent/` on any machine.

## Skills

| Folder | Purpose |
| ------ | ---------- |
| `extensions/web/` | **pi-web**: `web_search` and `web_fetch` tools, plus a `/web` command.
| `extensions/subagent/` | **pi-subagent**: `subagent` tool that delegates self-contained tasks to isolated pi sessions (single or parallel, up to 8 tasks / 4 concurrent).

## Install

```bash
ln -s /path/to/pi-skills/extensions/web ~/.pi/agent/extensions/web
ln -s /path/to/pi-skills/extensions/subagent ~/.pi/agent/extensions/subagent
```

See each skill's README for usage and configuration.
