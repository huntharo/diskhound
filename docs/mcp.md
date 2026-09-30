# AI agents (MCP)

DiskHound can act as a local [Model Context Protocol](https://modelcontextprotocol.io)
server, so an AI agent such as Claude Code or Codex can read your scans, run
scans, and steer the DiskHound window while it helps you free up space. The
window follows along: the agent opens folders, switches tabs, and its actions
show up in the header and in Settings.

It is off by default. Nothing listens until you turn it on, only this
computer can connect, and every agent needs your approval in DiskHound.

## Turn it on

Settings → **AI Agents** → **Allow local AI agents**. DiskHound listens on
`http://127.0.0.1:51733/mcp`. That port is fixed, so an agent's saved
configuration keeps working after restarts.

## Connect an agent

Settings shows connection commands with a Copy button, including the full path
to the bundled `diskhound-mcp` executable.

### Claude Code (recommended: stdio)

Use the command from Settings. On a Mac with DiskHound in Applications:

```bash
claude mcp add --scope user --transport stdio diskhound -- '/Applications/DiskHound.app/Contents/Resources/native/diskhound-mcp'
```

`--scope user` makes DiskHound available in every directory. If you already
registered DiskHound as HTTP, first run `claude mcp remove --scope user diskhound`,
then add it again as stdio. Open Claude's `/mcp` menu to connect or reconnect.

The small Rust helper translates stdio to DiskHound's loopback HTTP server and
handles OAuth itself. This avoids client restrictions on OAuth over local HTTP;
you do not need a TLS certificate or a public endpoint. Keep DiskHound running
with AI Agents enabled. Approve the first connection in DiskHound's window.

On Windows use the PowerShell command in Settings. The helper is in
`resources/native/diskhound-mcp.exe` beside the installed app. Linux tarball
installs also include `resources/native/diskhound-mcp`. For an **AppImage**, copy
that executable from the running image to a stable location such as
`~/.local/bin/diskhound-mcp`, then use the copied path; temporary AppImage mount
paths change between launches. Replace the copy after an app update.

For Claude Desktop or another stdio client, use the same executable as its
`command`, with optional `args: ["--port", "51733"]`. No bearer token belongs in
client configuration. For example, Claude Desktop on macOS:

```json
{
  "mcpServers": {
    "diskhound": {
      "command": "/Applications/DiskHound.app/Contents/Resources/native/diskhound-mcp",
      "args": []
    }
  }
}
```

The helper saves its approval in macOS Keychain, Windows Credential Manager,
or Linux Secret Service. Connections from the same OS account to the same
port reuse that session. Session roles and revocation remain in DiskHound.
If a credential store is unavailable, unlock it or explicitly add `--ephemeral`
to approve every connection without saving credentials. There is no plaintext
fallback. `diskhound-mcp --forget` removes the saved connection locally; revoke
its session in Settings as well if you want to invalidate it.

### HTTP with OAuth

The HTTP endpoint and OAuth flow remain available for compatible clients:

```bash
codex mcp add diskhound --url http://127.0.0.1:51733/mcp --oauth-client-registration dcr
```

Clients must accept loopback HTTP for OAuth. If yours requires HTTPS, use the
stdio helper. Do not disable OAuth or expose DiskHound on a public interface.

### Approving an agent

DiskHound opens an approval window where you name the session and pick a role.
The stdio helper opens it directly; HTTP clients may also open a browser tab
that says **Continue in DiskHound**. Only the DiskHound window can approve the
request. Closing that window counts as Deny.

![Approval window](screenshots/agent-consent.png)

| Role | Can |
| --- | --- |
| Disk Explorer | Read drives, scan results, history, duplicates, and cleanup suggestions |
| Cleanup Guide (default) | Everything above, plus run scans and steer the DiskHound window |
| Cleanup Operator | Everything above, plus ask to move items to the Trash / Recycle Bin |

You can change a session's role or revoke it at any time in Settings → AI
Agents. The change applies to the agent's next call. A role can only use the
permissions the agent asked for at sign-in. Claude Code and Codex ask for all
of them, so the role you pick is what counts.

## What agents can do

| Tool | Does |
| --- | --- |
| `diskhound_status` | Drives, free space, scanned roots, running scans, what the window shows, and what this session may do. Agents start here. |
| `diskhound_scan_summary` | Totals, largest files and folders, and file types for a scan |
| `diskhound_list_folder` | One folder's children by size (the Folders tab) |
| `diskhound_search_files` | Search the full scan index by path, extension, and minimum size |
| `diskhound_cleanup_suggestions` | Temp files, caches, old downloads, and other candidates |
| `diskhound_dev_artifacts` | `node_modules`, build output, package caches, venvs, and git worktrees, grouped by project |
| `diskhound_scan_history`, `diskhound_changes` | Past scans, and what grew or shrank between two of them |
| `diskhound_duplicates`, `diskhound_find_duplicates` | Duplicate groups, and starting a duplicate search |
| `diskhound_start_scan`, `diskhound_cancel_scan` | Scan a drive or folder |
| `diskhound_show`, `diskhound_reveal_path` | Point the window at a tab, drive, or folder; reveal an item in Finder or Explorer |
| `diskhound_move_to_trash` | Ask to move up to 20 items to the Trash (Cleanup Operator only) |

Most read tools take `showInApp: true`, which moves the window to what the
agent is looking at. The header shows which agent acted last; click it to
open Settings → AI Agents, which lists recent agent actions.

**Nothing is ever deleted permanently.** `diskhound_move_to_trash` shows a
DiskHound confirmation listing every item, its size, and the agent's reason.
Nothing moves unless you click **Move to Trash**, and protected folders are
always skipped. Agents also can't move a drive root, your home folder, its
standard folders (Documents, Downloads, Desktop, Library or AppData, and so
on), DiskHound itself, or any folder that contains one of these. DiskHound
checks the real location on disk, so a different spelling or a symlink
doesn't get around this.

![Trash confirmation](screenshots/agent-trash-confirm.png)

## Deferred tool discovery

DiskHound publishes its tools through standard `tools/list`; they can be called
without a preceding list request. Its initialization instructions describe when
to discover them: disk usage, large files, duplicates, caches, cleanup, and growth.
Hosts can keep those definitions out of the model's initial context and load
them through their own tool search. [Claude Code does this automatically](https://code.claude.com/docs/en/mcp#scale-with-mcp-tool-search).

Tool search is a client/host feature, not a required MCP server method. PwrAgent's
native tool catalog likewise adds its own `tool_search` and deferred-loading
flags; those are not advertised by its MCP adapter. DiskHound keeps its full
standard catalog available to clients without tool search, over either transport.

## Cleanup procedures (skills)

DiskHound ships two procedures that agents read before recommending anything:

- **diskhound-free-up-space**: measure the gap, get a fresh scan, walk the
  biggest folders, sweep developer caches and duplicates, and check whether
  deleting something actually frees space.
- **diskhound-investigate-growth**: compare scans to explain what filled the
  disk and when.

The free-up-space skill has one reference per OS. They cover space that
deleting files does not give back:

- **macOS**: APFS clones (for example pnpm's `node_modules`), which share
  blocks, so the space only comes back when the last copy is gone. Time
  Machine local snapshots, which keep deleted data until they expire. Purgeable
  space, and the Trash.
- **Windows**: System Restore and Volume Shadow Copies, WSL and Docker
  `.vhdx` disks that never shrink, hardlinks, and the Recycle Bin.
- **Linux**: hardlinks (pnpm stores) and reflinks, btrfs and ZFS snapshots,
  files deleted but still open, and the systemd journal.

The skills are served over MCP in two ways:

- As Skills over MCP (SEP-2640, extension `io.modelcontextprotocol/skills`):
  `skills/list`, `skills/get`, and `skill://` resources, with
  `resources/directory/read`. This is for clients that support the
  extension.
- As the prompts `free-up-space` and `investigate-growth`, for clients that
  don't. Claude Code shows these as `/mcp__diskhound__free-up-space` and
  `/mcp__diskhound__investigate-growth`.

The server's instructions also point agents at the `skill://` resources.
The source lives in [`skills/`](../skills).

## Security

- The server binds `127.0.0.1` only. It rejects any other `Host` header,
  non-loopback peers, and browser `Origin`s other than loopback. That blocks
  DNS rebinding and cross-site requests from web pages.
- OAuth 2.1 with dynamic client registration, PKCE (S256), and a resource
  indicator pinned to the MCP URL. Clients are public; there are no client
  secrets.
- Approval happens only in DiskHound's own window. Browser pages and URL
  parameters can't approve a request.
- Tokens are stored as SHA-256 hashes in `mcp-policy.json` in DiskHound's
  data folder (mode 0600). They don't expire; revoke them in Settings.
- Every tool call checks the session against the policy file, so revoking a
  session or changing its role applies immediately.
- Moving items to the Trash needs the Cleanup Operator role and your
  confirmation in a native dialog every time. If you revoke the session or
  turn AI Agents off while a request waits for its dialog, DiskHound drops
  the request.

## Troubleshooting

- **"Port 51733 is already in use"**: another program, or a second copy of
  DiskHound, holds the port. Quit it, then toggle AI Agents off and on.
- **The agent says a permission is missing**: open Settings → AI Agents and
  give that session a bigger role. The agent's next call picks it up.
- **The agent can't connect after you revoked it**: the stdio helper fails the
  current connection and forgets that credential. Reconnect once more to request
  approval, or repeat the HTTP client's OAuth login. Tool calls are never retried
  automatically because their outcome may be unknown.
- **The stdio command cannot be found**: copy the command from Settings again
  after moving the app. In a source checkout, run `bun run build:mcp:debug` first.
- **Secret Service unavailable on Linux**: run in a desktop session with an
  unlocked credential store, or add `--ephemeral`. Headless sessions usually do
  not have Secret Service.

## Building the bridge

`bun run build:mcp:debug` builds the development helper; `bun run build:mcp`
builds the release binary. `bun run dist` includes it automatically. Release CI
builds both macOS architectures and combines them into the universal app.
`cargo test --locked --manifest-path native/diskhound-mcp/Cargo.toml` tests the
transport and credential lifecycle; `e2e/stdio-agent.spec.ts` tests real native
approval and MCP calls using ephemeral credentials in an isolated profile.
