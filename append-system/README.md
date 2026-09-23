# append-system

Default communication style for pi, installed as the `APPEND_SYSTEM.md` system-prompt addendum.

Shapes every response for a reader with a small working memory: lead with the next action, number multi-step work, restate state across turns, suppress tangents, specific estimates, concrete wins, matter-of-fact errors, lists capped at 5, no preamble/recap/closers.

Based on the [i-have-adhd](https://github.com/ayghri/i-have-adhd) skill, adapted to apply by default via `APPEND_SYSTEM.md` instead of an explicit invocation.

## Install

Symlink the file (pi loads the exact filename `APPEND_SYSTEM.md` from the agent directory):

```bash
ln -s /path/to/pi-skills/append-system/APPEND_SYSTEM.md ~/.pi/agent/APPEND_SYSTEM.md
```

Run `/reload` in an open session.

## Turn off

- Per session: say `normal mode` (or `stop adhd mode`).
- Permanently: remove the symlink.

## Notes

- Subagents inherit the style (they run as full pi sessions). The "Agent readers" section in the file scopes the human-facing rules out, so agent-to-agent output stays concrete without progress narration.
- `APPEND_SYSTEM.md` is appended to the system prompt, not replacing it. A trusted project `.pi/APPEND_SYSTEM.md` takes precedence over the agent-directory file when both exist; the two are not combined.
