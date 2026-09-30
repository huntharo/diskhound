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
const DEFAULT_PORT: u16 = 51733;
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
        return Err("Connection denied in DiskHound");
    }
    let codes: Vec<_> = pairs.iter().filter(|(k, _)| k == "code").collect();
    if codes.len() != 1 || codes[0].1.is_empty() {
        return Err("Invalid OAuth code");
    }
    Ok(codes[0].1.to_string())
}
struct Bridge {
    http: Client,
    origin: String,
    port: u16,
    token: Option<String>,
    credentials: Option<Credentials>,
    version: String,
}
impl Bridge {
    async fn authenticate(&self) -> Result<String> {
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
        let response = self.http.post(format!("{}/register", self.origin)).json(&json!({
            "client_name": "DiskHound stdio", "redirect_uris": [redirect], "token_endpoint_auth_method": "none",
            "grant_types": ["authorization_code"], "response_types": ["code"]
        })).send().await.map_err(|_| UNAVAILABLE)?;
        if !response.status().is_success() {
            return Err("DiskHound refused registration");
        }
        let client = field(&body(response).await?, "client_id")?;
        let verifier = random()?;
        let state = random()?;
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        let resource = format!("{}/mcp", self.origin);
        let response = self
            .http
            .get(format!("{}/authorize", self.origin))
            .query(&[
                ("client_id", client.as_str()),
                ("redirect_uri", &redirect),
                ("response_type", "code"),
                ("code_challenge_method", "S256"),
                ("code_challenge", &challenge),
                ("state", &state),
                ("resource", &resource),
                ("scope", "disk.read scan.run app.navigate files.trash"),
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
        eprintln!("Approve this connection in the DiskHound window. Choose the role you want this agent to have.");
        let deadline = Instant::now() + Duration::from_secs(120);
        while Instant::now() < deadline {
            let response = self
                .http
                .get(format!("{}/authorize/status", self.origin))
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
                    let response = self
                        .http
                        .post(format!("{}/token", self.origin))
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
                _ => return Err("Approval expired or failed; reconnect to try again"),
            }
        }
        Err("Approval timed out; reconnect and approve in DiskHound")
    }
    async fn ensure_token(&mut self) -> Result<()> {
        if self.token.is_some() {
            return Ok(());
        }
        if let Some(store) = &self.credentials {
            let _lock = store.lock(self.port).await?;
            self.token = store.load().await?;
            if self.token.is_none() {
                let token = self.authenticate().await?;
                store.save(&token).await?;
                self.token = Some(token);
            }
        } else {
            self.token = Some(self.authenticate().await?);
        }
        Ok(())
    }
    async fn forward(&mut self, message: &Value) -> Result<Option<Value>> {
        self.ensure_token().await?;
        let response = self
            .http
            .post(format!("{}/mcp", self.origin))
            .bearer_auth(self.token.as_ref().ok_or("Missing approval")?)
            .header("Accept", "application/json, text/event-stream")
            .header("MCP-Protocol-Version", &self.version)
            .json(message)
            .send()
            .await
            .map_err(|_| UNAVAILABLE)?;
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
            return Err(REVOKED);
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
        eprintln!("DiskHound MCP stdio bridge\nUsage: diskhound-mcp [--port PORT] [--ephemeral | --forget]\nKeep DiskHound open with Settings > AI Agents enabled.\nCredentials use the OS store. --ephemeral saves none; --forget removes the saved connection.\nAll diagnostics go to stderr; stdout is reserved for MCP JSON.");
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
        let _lock = store.lock(options.port).await?;
        store.clear().await?;
        eprintln!("Saved connection forgotten. Revoke its session in DiskHound to invalidate it.");
        return Ok(());
    }
    let http = Client::builder()
        .no_proxy()
        .redirect(Policy::none())
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|_| UNAVAILABLE)?;
    let mut bridge = Bridge {
        http,
        origin,
        port: options.port,
        credentials,
        token: None,
        version: "2025-03-26".into(),
    };
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
    loop {
        let line = tokio::select! {
            _ = tokio::signal::ctrl_c() => break,
            line = rx.recv() => match line { Some(line) => line, None => break },
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
        // Dropping forward on EOF closes its HTTP request, canceling queued Trash
        // work in the app. No write can be retried after an ambiguous disconnect.
        let reply = tokio::select! {
            biased;
            _ = eof.wait_for(|closed| *closed) => break,
            _ = tokio::signal::ctrl_c() => break,
            reply = bridge.forward(&message) => reply,
        };
        match reply {
            Ok(Some(reply)) if message.get("id").is_some() => output(&reply)?,
            Ok(_) => {}
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
