//! Local stdio ↔ loopback Streamable HTTP bridge. DiskHound owns consent and tools.
mod credentials;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use credentials::Credentials;
use reqwest::{redirect::Policy, Client, Response, Url};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    io::Write,
    time::{Duration, Instant},
};
use tokio::io::{AsyncBufReadExt, AsyncReadExt};

type Result<T> = std::result::Result<T, &'static str>;
const INPUT_LIMIT: usize = 1024 * 1024;
const RESPONSE_LIMIT: usize = 16 * 1024 * 1024;
const DEFAULT_PORT: u16 = 51735;
const UNAVAILABLE: &str = "Keep DiskHound open with Settings > AI Agents enabled. Transport failed; an operation's outcome may be unknown. Check status before retrying.";
const REVOKED: &str =
    "This connection was revoked. Reconnect to request fresh approval in DiskHound.";

#[derive(Debug, PartialEq)]
struct Options {
    port: u16,
    ephemeral: bool,
    forget: bool,
}
fn options(args: impl Iterator<Item = String>) -> Result<Options> {
    let mut args = args;
    let mut options = Options {
        port: DEFAULT_PORT,
        ephemeral: false,
        forget: false,
    };
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--port" => {
                options.port = args
                    .next()
                    .and_then(|v| v.parse().ok())
                    .filter(|p| *p != 0)
                    .ok_or("Invalid loopback port")?
            }
            "--ephemeral" => options.ephemeral = true,
            "--forget" => options.forget = true,
            _ => return Err("Usage: diskhound-mcp [--port PORT] [--ephemeral | --forget]"),
        }
    }
    if options.forget && options.ephemeral {
        return Err("--forget and --ephemeral cannot be combined");
    }
    Ok(options)
}
fn random() -> Result<String> {
    let mut bytes = [0; 32];
    getrandom::fill(&mut bytes).map_err(|_| "System randomness unavailable")?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}
fn field(value: &Value, name: &str) -> Result<String> {
    value[name]
        .as_str()
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
        .ok_or("Invalid DiskHound response")
}
async fn bytes(mut response: Response, limit: usize) -> Result<Vec<u8>> {
    let mut data = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| UNAVAILABLE)? {
        if data.len() + chunk.len() > limit {
            return Err("DiskHound response too large");
        }
        data.extend_from_slice(&chunk);
    }
    Ok(data)
}
async fn body(response: Response) -> Result<Value> {
    serde_json::from_slice(&bytes(response, RESPONSE_LIMIT).await?)
        .map_err(|_| "Invalid DiskHound response")
}
fn pending_id(html: &str) -> Result<&str> {
    let id = html
        .split("/authorize/status?id=")
        .nth(1)
        .and_then(|s| s.split('"').next())
        .ok_or("Invalid approval response")?;
    if id.len() != 43
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err("Invalid approval response");
    }
    Ok(id)
}
fn callback_code(location: &str, redirect: &str, state: &str) -> Result<String> {
    let destination = Url::parse(location).map_err(|_| "Invalid OAuth callback")?;
    let mut expected = Url::parse(redirect).map_err(|_| "Invalid OAuth callback")?;
    expected.set_query(destination.query());
    if destination != expected {
        return Err("OAuth callback mismatch");
    }
    let pairs: Vec<_> = destination.query_pairs().collect();
    if pairs.iter().filter(|(k, _)| k == "state").count() != 1
        || !pairs.iter().any(|(k, v)| k == "state" && v == state)
    {
        return Err("OAuth state mismatch");
    }
    if pairs.iter().any(|(k, _)| k == "error") {
        return Err(DENIED);
    }
    let codes: Vec<_> = pairs.iter().filter(|(k, _)| k == "code").collect();
    if codes.len() != 1 || codes[0].1.is_empty() {
        return Err("Invalid OAuth code");
    }
    Ok(codes[0].1.to_string())
}
/// Known MCP client ids (clientInfo.name) and the names users know them by.
/// Claude Desktop names an extension's connection `local-agent-mode-<extension>`.
fn client_label(info: &Value) -> String {
    let name = info["name"].as_str().unwrap_or("").trim();
    let title = info["title"].as_str().unwrap_or("").trim();
    let lower = name.to_ascii_lowercase();
    let known = match lower.as_str() {
        "claude-ai" => Some("Claude Desktop"),
        n if n.starts_with("local-agent-mode-") => Some("Claude Desktop"),
        "claude-code" => Some("Claude Code"),
        n if n.starts_with("codex") => Some("Codex"),
        n if n.contains("cursor") => Some("Cursor"),
        "visual studio code" | "vscode" => Some("VS Code"),
        _ => None,
    };
    let label = known
        .map(str::to_owned)
        .or_else(|| (!title.is_empty()).then(|| title.to_owned()))
        .or_else(|| (!name.is_empty()).then(|| name.to_owned()))
        .unwrap_or_else(|| "MCP client".into());
    label.chars().filter(|c| !c.is_control()).take(60).collect()
}

/// Claude Desktop reads a server's tool list once, when it connects, and
/// keeps it: it ignores `tools/list_changed`. (Its extensions connect as
/// `local-agent-mode-<extension>`; `claude-ai` was its name before them.)
fn lists_tools_once(info: &Value) -> bool {
    let name = info["name"]
        .as_str()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    name == "claude-ai" || name.starts_with("local-agent-mode-")
}

/// Versions DiskHound's server speaks; the helper echoes the client's if it's one of these.
const PROTOCOL_VERSIONS: [&str; 4] = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
/// A health check (`claude mcp list`) connects and hangs up at once. Wait
/// this long before opening DiskHound's approval sheet, so it doesn't pop
/// up for a client that is already gone.
const APPROVAL_DELAY: Duration = Duration::from_millis(1500);
/// How long a tool call waits for the user before answering "still waiting".
const APPROVAL_WAIT: Duration = Duration::from_secs(30);
/// How long Claude Desktop's first `tools/list` waits for the user. It gives
/// up on a request after 60 s (the MCP SDK's default).
const LIST_WAIT: Duration = Duration::from_secs(45);
const NOT_DISKHOUND: &str = "Something other than DiskHound is listening on DiskHound's port. Ask the user to quit that program and keep DiskHound open with Settings > AI Agents turned on, then call diskhound_status again.";
const OFFLINE: &str = "DiskHound isn't reachable. Ask the user to open DiskHound and turn on Settings > AI Agents > Allow local AI agents, then call diskhound_status again.";
const DENIED: &str =
    "The user denied this connection in DiskHound. Reconnect this MCP server to ask again.";
const EXPIRED: &str =
    "The approval request expired before the user answered. Call diskhound_status to ask again.";
const PENDING: &str = "DiskHound is waiting for the user to approve this connection in the DiskHound window. Ask them to approve it there, then call diskhound_status again.";
const RECONNECT_FOR_TOOLS: &str = "Claude Desktop loads DiskHound's tools only when it connects, and it connected before this session had its current role, so some of DiskHound's tools may be missing. Ask the user to turn DiskHound off and on in Claude's Settings > Extensions, then start a new chat.";
const INSTRUCTIONS: &str = "DiskHound is a disk-space analyzer on the user's computer: disk usage, large files, duplicates, caches, cleanup, and disk growth. This connection is waiting for the user to approve it in the DiskHound window; call diskhound_status to check. Once it is approved, DiskHound's other tools appear (the tool list changes). If tools are deferred, search your host's tool catalog for DiskHound. Start with diskhound_status, and read skill://diskhound-free-up-space/SKILL.md before recommending deletions.";
/// Response header with the session's permissions; a change means its role changed.
const CAPABILITIES_HEADER: &str = "DiskHound-Capabilities";

#[derive(Clone, Debug, PartialEq)]
enum Approval {
    Pending,
    Approved(String),
    Failed(&'static str),
}

/// The id of the approval DiskHound is showing for this process, while
/// it waits. Shared with the approval task so exit can withdraw it.
type PendingApproval = std::sync::Arc<std::sync::Mutex<Option<String>>>;

/// Clears the pending id once the approval task stops waiting.
struct PendingGuard<'a>(&'a PendingApproval);
impl Drop for PendingGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut id) = self.0.lock() {
            *id = None;
        }
    }
}

struct Bridge {
    http: Client,
    origin: String,
    port: u16,
    token: Option<String>,
    credentials: Option<Credentials>,
    version: String,
    /// What the client called itself in `initialize`; names the approval.
    client_name: String,
    /// DiskHound (not another app) answered on the port.
    verified: bool,
    /// The background approval, once started.
    approval: Option<tokio::sync::watch::Receiver<Approval>>,
    /// When to start the approval if nothing asks for it sooner.
    approval_due: Option<Instant>,
    /// The approval's outcome was applied and announced.
    approval_applied: bool,
    /// Why there's no approval: the user denied it, it expired, or
    /// DiskHound isn't reachable. Only a denial is final.
    failed: Option<&'static str>,
    capabilities: Option<String>,
    capabilities_changed: bool,
    /// The approval DiskHound is showing, while the user decides.
    pending: PendingApproval,
    /// The client keeps the tool list it got when it connected (Claude Desktop).
    lists_once: bool,
    /// ...and that list no longer matches the session's role.
    stale_list: bool,
}

/// Register, open DiskHound's approval, and wait for the user. Holds the
/// per-port lock so parallel connections share one approval.
async fn obtain_token(
    http: &Client,
    origin: &str,
    port: u16,
    credentials: Option<&Credentials>,
    client_name: &str,
    pending: &PendingApproval,
) -> Result<String> {
    if let Some(store) = credentials {
        let _lock = store.lock(port).await?;
        // Another connection may have been approved while this one waited.
        if let Some(token) = store.load().await? {
            return Ok(token);
        }
        let token = authenticate(http, origin, client_name, pending).await?;
        store.save(&token).await?;
        Ok(token)
    } else {
        authenticate(http, origin, client_name, pending).await
    }
}

async fn authenticate(
    http: &Client,
    origin: &str,
    client_name: &str,
    pending: &PendingApproval,
) -> Result<String> {
    // Reserve the callback port but consume the validated redirect locally;
    // no browser URL or bearer credential crosses stdout to the MCP client.
    let callback = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|_| "Cannot reserve OAuth callback")?;
    let redirect = format!(
        "http://127.0.0.1:{}/callback",
        callback
            .local_addr()
            .map_err(|_| "Cannot reserve OAuth callback")?
            .port()
    );
    let response = http.post(format!("{origin}/register")).json(&json!({
        "client_name": client_name, "redirect_uris": [redirect], "token_endpoint_auth_method": "none",
        "grant_types": ["authorization_code"], "response_types": ["code"],
        "software_id": "diskhound-mcp", "software_version": env!("CARGO_PKG_VERSION")
    })).send().await.map_err(|_| UNAVAILABLE)?;
    if !response.status().is_success() {
        return Err("DiskHound refused registration");
    }
    let client = field(&body(response).await?, "client_id")?;
    let verifier = random()?;
    let state = random()?;
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let resource = format!("{origin}/mcp");
    let response = http
        .get(format!("{origin}/authorize"))
        .query(&[
            ("client_id", client.as_str()),
            ("redirect_uri", &redirect),
            ("response_type", "code"),
            ("code_challenge_method", "S256"),
            ("code_challenge", &challenge),
            ("state", &state),
            ("resource", &resource),
            (
                "scope",
                "disk.read scan.run app.navigate files.trash files.delete",
            ),
        ])
        .send()
        .await
        .map_err(|_| UNAVAILABLE)?;
    if response.status().as_u16() != 200 {
        return Err("DiskHound refused authorization");
    }
    let html = String::from_utf8(bytes(response, 65536).await?)
        .map_err(|_| "Invalid approval response")?;
    let id = pending_id(&html)?;
    if let Ok(mut shown) = pending.lock() {
        *shown = Some(id.to_owned());
    }
    let _shown = PendingGuard(pending);
    eprintln!("Approve this connection in the DiskHound window. Choose the role you want this agent to have.");
    // DiskHound's own approval expires after 5 minutes.
    let deadline = Instant::now() + Duration::from_secs(300);
    while Instant::now() < deadline {
        let response = http
            .get(format!("{origin}/authorize/status"))
            .query(&[("id", id)])
            .send()
            .await
            .map_err(|_| UNAVAILABLE)?;
        match response.status().as_u16() {
            200 => {
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
            302 => {
                let location = response
                    .headers()
                    .get("Location")
                    .and_then(|h| h.to_str().ok())
                    .ok_or("Invalid OAuth callback")?;
                let code = callback_code(location, &redirect, &state)?;
                let response = http
                    .post(format!("{origin}/token"))
                    .form(&[
                        ("grant_type", "authorization_code"),
                        ("client_id", &client),
                        ("redirect_uri", &redirect),
                        ("code_verifier", &verifier),
                        ("code", &code),
                        ("resource", &resource),
                    ])
                    .send()
                    .await
                    .map_err(|_| UNAVAILABLE)?;
                if !response.status().is_success() {
                    return Err("DiskHound refused the authorization code");
                }
                let token = field(&body(response).await?, "access_token")?;
                if !credentials::valid_token(&token) {
                    return Err("Invalid DiskHound token");
                }
                return Ok(token);
            }
            _ => return Err(EXPIRED),
        }
    }
    Err(EXPIRED)
}

fn result(id: &Value, result: Value) -> Value {
    json!({"jsonrpc":"2.0", "id":id, "result":result})
}
fn notification(method: &str) -> Value {
    json!({"jsonrpc":"2.0", "method":method})
}
fn tool_text(text: &str) -> Value {
    json!({"content":[{"type":"text","text":text}], "isError":true})
}
/// Until the user approves, the only tool: it says approval is pending,
/// and turns into the real diskhound_status once it isn't.
fn placeholder_tools() -> Value {
    json!({"tools":[{
        "name":"diskhound_status",
        "title":"DiskHound status",
        "description":"Start here. Until the user approves this connection in DiskHound, this reports that approval is pending; afterwards it returns drives, scans, and what this session may do. DiskHound's other tools appear once the connection is approved.",
        "inputSchema":{"type":"object","properties":{}},
        "annotations":{"readOnlyHint":true,"destructiveHint":false,"openWorldHint":false}
    }]})
}

impl Bridge {
    fn new(http: Client, origin: String, port: u16, credentials: Option<Credentials>) -> Self {
        Bridge {
            http,
            origin,
            port,
            token: None,
            credentials,
            version: "2025-03-26".into(),
            client_name: "MCP client".into(),
            verified: false,
            approval: None,
            approval_due: None,
            approval_applied: false,
            failed: None,
            capabilities: None,
            capabilities_changed: false,
            pending: PendingApproval::default(),
            lists_once: false,
            stale_list: false,
        }
    }

    /// Make sure DiskHound owns the port before sending it a token or a login.
    async fn verify(&mut self) -> Result<()> {
        if self.verified {
            return Ok(());
        }
        let response = self
            .http
            .get(format!(
                "{}/.well-known/oauth-protected-resource/mcp",
                self.origin
            ))
            .send()
            .await
            .map_err(|_| UNAVAILABLE)?;
        if !response.status().is_success() {
            return Err(NOT_DISKHOUND);
        }
        let metadata = body(response).await.map_err(|_| NOT_DISKHOUND)?;
        if metadata["resource_name"] != "DiskHound"
            || metadata["resource"] != format!("{}/mcp", self.origin)
        {
            return Err(NOT_DISKHOUND);
        }
        self.verified = true;
        Ok(())
    }

    async fn load_saved(&mut self) -> Result<()> {
        if self.token.is_none() {
            if let Some(store) = &self.credentials {
                self.token = store.load().await?;
            }
        }
        Ok(())
    }

    /// Load the saved approval, or get one now. Used by `--login`-style
    /// callers and tests; connections use the non-blocking path.
    #[cfg(test)]
    async fn ensure_token(&mut self) -> Result<()> {
        self.load_saved().await?;
        if self.token.is_none() {
            let token = obtain_token(
                &self.http,
                &self.origin,
                self.port,
                self.credentials.as_ref(),
                &self.client_name,
                &self.pending,
            )
            .await?;
            self.token = Some(token);
        }
        Ok(())
    }

    fn start_approval(&mut self) {
        self.approval_due = None;
        if self.approval.is_some() {
            return;
        }
        let (sender, receiver) = tokio::sync::watch::channel(Approval::Pending);
        self.approval = Some(receiver);
        let http = self.http.clone();
        let origin = self.origin.clone();
        let port = self.port;
        let credentials = self.credentials.clone();
        let name = self.client_name.clone();
        let pending = self.pending.clone();
        tokio::spawn(async move {
            let outcome =
                match obtain_token(&http, &origin, port, credentials.as_ref(), &name, &pending)
                    .await
                {
                    Ok(token) => Approval::Approved(token),
                    Err(reason) => Approval::Failed(reason),
                };
            let _ = sender.send(outcome);
        });
    }

    /// Apply a finished approval once; returns the notifications that tell
    /// the client to reload DiskHound's lists.
    fn apply_approval(&mut self) -> Vec<Value> {
        if self.approval_applied {
            return Vec::new();
        }
        let Some(receiver) = &self.approval else {
            return Vec::new();
        };
        let state = receiver.borrow().clone();
        match state {
            Approval::Pending => Vec::new(),
            Approval::Approved(token) => {
                self.approval_applied = true;
                self.token = Some(token);
                eprintln!("diskhound-mcp: approved in DiskHound");
                vec![
                    notification("notifications/tools/list_changed"),
                    notification("notifications/resources/list_changed"),
                    notification("notifications/prompts/list_changed"),
                ]
            }
            Approval::Failed(reason) => {
                self.approval_applied = true;
                self.failed = Some(reason);
                eprintln!("diskhound-mcp: {reason}");
                vec![notification("notifications/tools/list_changed")]
            }
        }
    }

    /// Wait (bounded) for the user to decide, for a request made early.
    async fn wait_for_approval(&mut self, limit: Duration) {
        if self.approval.is_none() {
            self.start_approval();
        }
        if let Some(receiver) = &mut self.approval {
            let _ = tokio::time::timeout(
                limit,
                receiver.wait_for(|state| *state != Approval::Pending),
            )
            .await;
        }
    }

    /// Before an early tool call: find DiskHound again if it wasn't
    /// reachable, and ask again unless the user said no.
    async fn retry(&mut self) {
        if self.failed == Some(DENIED) {
            return;
        }
        if let Err(reason) = self.verify().await {
            self.failed = Some(if reason == NOT_DISKHOUND {
                NOT_DISKHOUND
            } else {
                OFFLINE
            });
            return;
        }
        if self.failed.is_some() {
            // Reachable again, or the last request expired: start over.
            self.failed = None;
            self.approval = None;
            self.approval_applied = false;
        }
        if self.load_saved().await.is_ok() && self.token.is_some() {
            return;
        }
        self.wait_for_approval(APPROVAL_WAIT).await;
    }

    /// Handle one client message. Returns the reply (if any) and
    /// notifications to send after it.
    async fn handle(&mut self, message: &Value) -> Result<(Option<Value>, Vec<Value>)> {
        let method = message["method"].as_str().unwrap_or("");
        let id = message.get("id");
        if method == "initialize" {
            self.client_name = client_label(&message["params"]["clientInfo"]);
            self.lists_once = lists_tools_once(&message["params"]["clientInfo"]);
            if let Some(store) = &self.credentials {
                self.credentials = Some(store.for_client(&self.client_name)?);
            }
            match self.verify().await {
                Ok(()) => {
                    self.load_saved().await?;
                    if self.token.is_some() {
                        match self.forward(message).await {
                            Err(REVOKED) => {} // A stale saved approval: ask again below.
                            other => return other.map(|reply| (reply, Vec::new())),
                        }
                    }
                    self.approval_due = Some(Instant::now() + APPROVAL_DELAY);
                }
                // Connect anyway: diskhound_status tells the agent what to ask the user.
                Err(reason) => {
                    self.failed = Some(if reason == NOT_DISKHOUND {
                        NOT_DISKHOUND
                    } else {
                        OFFLINE
                    });
                }
            }
            // No approval yet. Answer now and ask the user in the background,
            // so a client's connect timeout can't cut the user's decision short.
            let requested = message["params"]["protocolVersion"].as_str().unwrap_or("");
            self.version = PROTOCOL_VERSIONS
                .iter()
                .find(|v| **v == requested)
                .unwrap_or(&"2025-06-18")
                .to_string();
            let reply = id.map(|id| {
                result(
                    id,
                    json!({
                        "protocolVersion": self.version,
                        "capabilities": {"tools":{"listChanged":true},"resources":{"listChanged":true},"prompts":{"listChanged":true}},
                        "serverInfo": {"name":"diskhound","title":"DiskHound","version":env!("CARGO_PKG_VERSION")},
                        "instructions": INSTRUCTIONS
                    }),
                )
            });
            return Ok((reply, Vec::new()));
        }
        let mut notes = self.apply_approval();
        if self.token.is_none() && method == "tools/call" {
            self.retry().await;
            notes.extend(self.apply_approval());
        }
        // Claude Desktop keeps its first tool list, so hold it until the
        // user decides: then it lists the tools of the role they grant.
        if self.token.is_none()
            && method == "tools/list"
            && self.lists_once
            && self.failed.is_none()
        {
            self.wait_for_approval(LIST_WAIT).await;
            notes.extend(self.apply_approval());
        }
        if self.token.is_some() {
            let mut reply = self.forward(message).await?;
            let changed = self.take_capability_change();
            self.stale_list |= self.lists_once && !changed.is_empty();
            notes.extend(changed);
            if self.stale_list
                && method == "tools/call"
                && message["params"]["name"] == "diskhound_status"
            {
                if let Some(content) = reply
                    .as_mut()
                    .and_then(|reply| reply["result"]["content"].as_array_mut())
                {
                    content.push(json!({"type":"text","text":RECONNECT_FOR_TOOLS}));
                }
            }
            return Ok((reply, notes));
        }
        let Some(id) = id else {
            return Ok((None, notes)); // notifications need no approval
        };
        // Listing is what a health check (`claude mcp list`) does before
        // it hangs up, so only a tool call or staying connected past
        // APPROVAL_DELAY asks the user.
        let reply = match method {
            "ping" => result(id, json!({})),
            "tools/list" => {
                self.stale_list |= self.lists_once;
                result(id, placeholder_tools())
            }
            "tools/call" => result(id, tool_text(self.failed.unwrap_or(PENDING))),
            "resources/list" => result(id, json!({"resources":[]})),
            "resources/templates/list" => result(id, json!({"resourceTemplates":[]})),
            "prompts/list" => result(id, json!({"prompts":[]})),
            _ => error(id.clone(), -32000, self.failed.unwrap_or(PENDING)),
        };
        Ok((Some(reply), notes))
    }

    /// A changed permissions header means the user changed this session's
    /// role: tell the client to reload the tool list.
    fn take_capability_change(&mut self) -> Vec<Value> {
        if !std::mem::take(&mut self.capabilities_changed) {
            return Vec::new();
        }
        eprintln!("diskhound-mcp: this session's role changed; tool list updated");
        vec![notification("notifications/tools/list_changed")]
    }

    /// The client hung up while DiskHound was still asking the user:
    /// withdraw the request so its approval sheet closes.
    async fn withdraw_pending(&self) {
        let id = self.pending.lock().ok().and_then(|id| id.clone());
        let Some(id) = id else { return };
        let request = self
            .http
            .post(format!("{}/authorize/cancel", self.origin))
            .form(&[("id", id.as_str())])
            .send();
        let _ = tokio::time::timeout(Duration::from_secs(1), request).await;
    }

    async fn forward(&mut self, message: &Value) -> Result<Option<Value>> {
        self.verify().await?;
        let response = self
            .http
            .post(format!("{}/mcp", self.origin))
            .bearer_auth(self.token.as_ref().ok_or("Missing approval")?)
            .header("Accept", "application/json, text/event-stream")
            .header("MCP-Protocol-Version", &self.version)
            .json(message)
            .send()
            .await
            .map_err(|_| {
                // Something else may hold the port next time; check again.
                self.verified = false;
                UNAVAILABLE
            })?;
        if response.status().as_u16() == 401 {
            // Never retry a tool call, or silently regain a revoked permission.
            // Keep this process denied; only a new connection may ask again.
            if let Some(store) = &self.credentials {
                let _lock = store.lock(self.port).await?;
                // Another process may already have approved a new session.
                if store.load().await? == self.token {
                    store.clear().await?;
                }
            }
            self.token = None;
            return Err(REVOKED);
        }
        if let Some(granted) = response
            .headers()
            .get(CAPABILITIES_HEADER)
            .and_then(|h| h.to_str().ok())
        {
            let granted = granted.to_owned();
            if self
                .capabilities
                .as_deref()
                .is_some_and(|seen| seen != granted)
            {
                self.capabilities_changed = true;
            }
            self.capabilities = Some(granted);
        }
        if response.status().as_u16() == 202 && message.get("id").is_none() {
            return Ok(None);
        }
        let status = response.status();
        let value = body(response).await?;
        if value["jsonrpc"] != "2.0"
            || value.get("id") != message.get("id")
            || (value.get("result").is_some() == value.get("error").is_some())
        {
            return Err("Invalid MCP response from DiskHound");
        }
        if !status.is_success() && value.get("error").is_none() {
            return Err("DiskHound rejected the request");
        }
        if message["method"] == "initialize" {
            if let Some(version) = value["result"]["protocolVersion"].as_str() {
                self.version = version.to_owned();
            }
        }
        Ok(Some(value))
    }
}
fn error(id: Value, code: i32, message: &str) -> Value {
    json!({"jsonrpc":"2.0", "id":id, "error":{"code":code,"message":message}})
}
async fn run() -> Result<()> {
    if std::env::args()
        .nth(1)
        .is_some_and(|arg| arg == "--help" || arg == "-h")
    {
        eprintln!("DiskHound MCP stdio bridge\nUsage: diskhound-mcp [--port PORT] [--ephemeral | --forget]\nKeep DiskHound open with Settings > AI Agents enabled.\nCredentials use the OS store. --ephemeral saves none; --forget removes the saved connections.\nAll diagnostics go to stderr; stdout is reserved for MCP JSON.");
        return Ok(());
    }
    let options = options(std::env::args().skip(1))?;
    let origin = format!("http://127.0.0.1:{}", options.port);
    let credentials = if options.ephemeral {
        None
    } else {
        Some(Credentials::new(&origin)?)
    };
    if options.forget {
        let store = credentials.as_ref().ok_or("Missing credential store")?;
        for client in credentials::KNOWN_CLIENTS {
            let saved = store.for_client(client)?;
            let _lock = saved.lock(options.port).await?;
            saved.clear().await?;
        }
        let _lock = store.lock(options.port).await?;
        store.clear().await?;
        eprintln!(
            "Saved connections forgotten. Revoke their sessions in DiskHound to invalidate them."
        );
        return Ok(());
    }
    let http = Client::builder()
        .no_proxy()
        .redirect(Policy::none())
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|_| UNAVAILABLE)?;
    let mut bridge = Bridge::new(http, origin, options.port, credentials);
    let (tx, mut rx) = tokio::sync::mpsc::channel(16);
    let (closed, mut eof) = tokio::sync::watch::channel(false);
    tokio::spawn(async move {
        let mut input = tokio::io::BufReader::new(tokio::io::stdin());
        loop {
            let mut line = Vec::new();
            match (&mut input)
                .take((INPUT_LIMIT + 1) as u64)
                .read_until(b'\n', &mut line)
                .await
            {
                Ok(0) | Err(_) => break,
                Ok(_) if line.len() > INPUT_LIMIT => {
                    eprintln!("diskhound-mcp: MCP input exceeds 1 MiB");
                    break;
                }
                Ok(_) => {
                    if tx.try_send(line).is_err() {
                        eprintln!("diskhound-mcp: input queue full or closed; reconnect");
                        break;
                    }
                }
            }
        }
        let _ = closed.send(true);
    });
    // Whatever ends the session (EOF, a closed stdout, an error), a
    // request still waiting in DiskHound is withdrawn on the way out.
    let outcome: Result<()> = async {
        loop {
            let due = bridge.approval_due;
            let line = tokio::select! {
                _ = tokio::signal::ctrl_c() => break,
                line = rx.recv() => match line { Some(line) => line, None => break },
                _ = async {
                    match due {
                        Some(at) => tokio::time::sleep_until(at.into()).await,
                        None => std::future::pending::<()>().await,
                    }
                } => {
                    bridge.start_approval();
                    continue;
                }
                _ = async {
                    match bridge.approval.as_mut() {
                        Some(receiver) if !bridge.approval_applied => { let _ = receiver.changed().await; }
                        _ => std::future::pending::<()>().await,
                    }
                } => {
                    for note in bridge.apply_approval() {
                        output(&note)?;
                    }
                    continue;
                }
            };
            let message: Value = match serde_json::from_slice(&line) {
                Ok(message) => message,
                Err(_) => {
                    output(&error(Value::Null, -32700, "Invalid JSON"))?;
                    continue;
                }
            };
            if !message.is_object()
                || message["jsonrpc"] != "2.0"
                || !message["method"].is_string()
                || message
                    .get("id")
                    .is_some_and(|id| !id.is_string() && !id.is_number())
            {
                output(&error(Value::Null, -32600, "Invalid MCP request"))?;
                continue;
            }
            // Dropping the handler on EOF closes its HTTP request, canceling queued
            // Trash work in the app. No write can be retried after an ambiguous disconnect.
            let reply = tokio::select! {
                biased;
                _ = eof.wait_for(|closed| *closed) => break,
                _ = tokio::signal::ctrl_c() => break,
                reply = bridge.handle(&message) => reply,
            };
            match reply {
                Ok((reply, notes)) => {
                    if let (Some(reply), Some(_)) = (reply, message.get("id")) {
                        output(&reply)?;
                    }
                    for note in notes {
                        output(&note)?;
                    }
                }
                Err(reason) => {
                    eprintln!("diskhound-mcp: {reason}");
                    if let Some(id) = message.get("id") {
                        output(&error(id.clone(), -32000, reason))?;
                    }
                    return Err(reason);
                }
            }
        }
        Ok(())
    }
    .await;
    bridge.withdraw_pending().await;
    outcome
}
fn output(value: &Value) -> Result<()> {
    let mut output = std::io::stdout().lock();
    writeln!(output, "{value}")
        .and_then(|_| output.flush())
        .map_err(|_| "Stdout closed")
}
fn main() {
    std::panic::set_hook(Box::new(|_| eprintln!("diskhound-mcp: internal failure")));
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime");
    let code = match runtime.block_on(run()) {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("diskhound-mcp: {e}");
            1
        }
    };
    // Tokio's blocking stdin reader may still be waiting; do not wait for it on exit.
    std::process::exit(code);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_loopback_ports_can_be_configured() {
        assert_eq!(
            options(
                ["--port", "1234", "--ephemeral"]
                    .map(String::from)
                    .into_iter()
            )
            .unwrap()
            .port,
            1234
        );
        for args in [
            vec!["--port", "0"],
            vec!["--port", "65536"],
            vec!["--url", "https://example.com"],
            vec!["--forget", "--ephemeral"],
        ] {
            assert!(options(args.into_iter().map(String::from)).is_err());
        }
    }
    #[test]
    fn approval_destination_and_state_are_bound() {
        let redirect = "http://127.0.0.1:1234/callback";
        assert_eq!(
            callback_code(&format!("{redirect}?state=s&code=c"), redirect, "s").unwrap(),
            "c"
        );
        for location in [
            "http://evil.example/callback?state=s&code=c",
            "http://127.0.0.1:1234/callback?state=s&state=s&code=c",
            "http://127.0.0.1:1234/callback?state=x&code=c",
            "http://127.0.0.1:1234/callback?state=s&error=access_denied",
        ] {
            assert!(callback_code(location, redirect, "s").is_err());
        }
    }
    #[test]
    fn pending_approval_is_an_opaque_id_not_a_url() {
        assert_eq!(
            pending_id(&format!("/authorize/status?id={}\"", "a".repeat(43))).unwrap(),
            "a".repeat(43)
        );
        assert!(pending_id("/authorize/status?id=../evil\"").is_err());
    }
}

#[cfg(test)]
#[path = "tests.rs"]
mod transport_tests;
