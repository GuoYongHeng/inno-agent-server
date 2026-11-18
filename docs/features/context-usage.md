# Context usage in the chat composer

The conversation composer shows a context ring beside the model picker. Hover or
focus it for the used/maximum token count; click it for a categorized popover.
The welcome composer does not display session usage.

## Data contract

`GET /api/sessions/:id/context-usage` returns aggregate counts only, with
`Cache-Control: no-store`. It never exposes prompt text,
message content, tool schemas, credentials, or filesystem paths.

- `ready`: current context tokens, model context window, percentage and breakdown.
- `pending`: reserved for a context that was compacted and has no new total yet.
- `inactive`: reserved; durable sessions are always addressable, so it is not produced.
- `unavailable`: no usable context window or usage data.

Unknown values are `null`, not zero. Missing sessions return HTTP 404. The UI
also distinguishes loading and request failure, and retries automatically.

## Counting semantics

The total is the provider's last reported usage (input + output + cache) plus an
estimate for the messages that follow it (`agent/context-usage.ts`). Before a usable
provider response exists, the whole total is estimated from the effective system
prompt, the registered tool schemas and the messages.

Category weights are estimates, rounded and scaled to sum to the current total:

- System: effective system prompt excluding the available-skills catalog.
- Tools: the registered tool definitions (name, description, parameters).
- Messages: the session's active conversation (after an edit-and-resend, the fork), including tool results and loaded skill text.
- Skill catalog: the `<available_skills>` section of the system prompt.

Percentages use the whole context window as their denominator, not the used
portion. Above-capacity totals remain visible; visual ring/bar fills cap at 100%.
These are context occupancy estimates, **not billing or cumulative usage totals**.

## Updates and interactions

Polls every 3 seconds while streaming and every 15 seconds while idle. Also
refreshes when history/message count or streaming state changes, and when a
hidden page becomes visible. Hidden pages do not poll. Requests time out after
10 seconds and are aborted on cleanup. Session/model changes remount the meter
so stale responses cannot leak counts across sessions.

The popover is portaled outside clipping containers, fits the visible viewport,
works with light/dark themes and English/Chinese, closes on outside click or
Escape, and restores keyboard focus when explicitly dismissed.
