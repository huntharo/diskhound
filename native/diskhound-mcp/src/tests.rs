use super::*;
use std::sync::{Arc, Mutex};
use tokio::io::AsyncWriteExt;

#[derive(Default, Debug)]
pub struct CredentialCounts {
    pub reads: usize,
    pub writes: usize,
    pub deletes: usize,
    pub bytes: usize,
    pub token: Option<Vec<u8>>,
}
#[derive(Debug)]
struct CountedCredential(Arc<Mutex<CredentialCounts>>);
impl keyring::credential::CredentialApi for CountedCredential {
    fn set_secret(&self, secret: &[u8]) -> keyring::Result<()> {
        let mut counts = self.0.lock().unwrap();
        counts.writes += 1;
        counts.bytes += secret.len();
        counts.token = Some(secret.to_vec());
        Ok(())
    }
    fn get_secret(&self) -> keyring::Result<Vec<u8>> {
        let mut counts = self.0.lock().unwrap();
        counts.reads += 1;
        counts.token.clone().ok_or(keyring::Error::NoEntry)
    }
    fn delete_credential(&self) -> keyring::Result<()> {
        let mut counts = self.0.lock().unwrap();
        counts.deletes += 1;
        counts.token = None;
        Ok(())
    }
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}
fn store(counts: &Arc<Mutex<CredentialCounts>>, directory: &std::path::Path) -> Credentials {
    Credentials::for_test(
        keyring::Entry::new_with_credential(Box::new(CountedCredential(counts.clone()))),
        directory.to_owned(),
    )
}
fn bridge(origin: String) -> Bridge {
    let port = Url::parse(&origin).unwrap().port().unwrap();
    let mut bridge = Bridge::new(
        Client::builder()
            .no_proxy()
            .redirect(Policy::none())
            .build()
            .unwrap(),
        origin,
        port,
        None,
    );
    bridge.token = Some(format!("dhmcp_{}", "a".repeat(43)));
    // Most tests talk to a one-response peer; identity has its own test.
    bridge.verified = true;
    bridge
}

// Tiny loopback peer: record the actual wire request and serve one response.
async fn peer(status: &str, response: Value) -> (String, tokio::task::JoinHandle<String>) {
    peer_with_headers(status, "", response).await
}

async fn peer_with_headers(
    status: &str,
    headers: &str,
    response: Value,
) -> (String, tokio::task::JoinHandle<String>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let body = response.to_string();
    let reply = format!("HTTP/1.1 {status}\r\n{headers}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
    let task = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let request = read_request(&mut socket).await;
        socket.write_all(reply.as_bytes()).await.unwrap();
        request
    });
    (origin, task)
}

async fn read_request(socket: &mut tokio::net::TcpStream) -> String {
    let mut request = Vec::new();
    let mut buffer = [0; 4096];
    loop {
        let count = socket.read(&mut buffer).await.unwrap();
        assert!(count > 0);
        request.extend_from_slice(&buffer[..count]);
        if let Some(end) = request.windows(4).position(|v| v == b"\r\n\r\n") {
            let headers = String::from_utf8_lossy(&request[..end]).to_lowercase();
            let length: usize = headers
                .lines()
                .find_map(|line| line.strip_prefix("content-length: "))
                .unwrap_or("0")
                .parse()
                .unwrap();
            if request.len() >= end + 4 + length {
                break;
            }
        }
    }
    String::from_utf8(request).unwrap()
}

async fn approving_peer() -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        let mut redirect = String::new();
        let mut challenge = String::new();
        for step in 0..4 {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_request(&mut socket).await;
            let target = request
                .lines()
                .next()
                .unwrap()
                .split_whitespace()
                .nth(1)
                .unwrap();
            let url = Url::parse(&format!("http://127.0.0.1{target}")).unwrap();
            let mut headers = String::new();
            let body = match step {
                0 => {
                    assert_eq!(url.path(), "/register");
                    json!({"client_id":"test-client"}).to_string()
                }
                1 => {
                    assert_eq!(url.path(), "/authorize");
                    let pairs: std::collections::HashMap<_, _> = url.query_pairs().collect();
                    assert_eq!(pairs["code_challenge_method"], "S256");
                    challenge = pairs["code_challenge"].to_string();
                    let mut callback = Url::parse(&pairs["redirect_uri"]).unwrap();
                    callback
                        .query_pairs_mut()
                        .append_pair("state", &pairs["state"])
                        .append_pair("code", "test-code");
                    redirect = callback.to_string();
                    format!(
                        "<meta content=\"0;url=/authorize/status?id={}\">",
                        "a".repeat(43)
                    )
                }
                2 => {
                    assert_eq!(url.path(), "/authorize/status");
                    headers = format!("Location: {redirect}\r\n");
                    String::new()
                }
                _ => {
                    assert_eq!(url.path(), "/token");
                    let form = Url::parse(&format!(
                        "http://localhost/?{}",
                        request.split("\r\n\r\n").nth(1).unwrap()
                    ))
                    .unwrap();
                    let pairs: std::collections::HashMap<_, _> = form.query_pairs().collect();
                    assert_eq!(pairs["code"], "test-code");
                    assert_eq!(
                        URL_SAFE_NO_PAD.encode(Sha256::digest(pairs["code_verifier"].as_bytes())),
                        challenge
                    );
                    json!({"access_token":format!("dhmcp_{}", "b".repeat(43))}).to_string()
                }
            };
            let status = if step == 2 { "302 Found" } else { "200 OK" };
            socket.write_all(format!("HTTP/1.1 {status}\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
        }
    });
    (origin, task)
}

#[tokio::test]
async fn forwards_rpc_and_negotiates_version_without_reinterpreting_tools() {
    let result = json!({"jsonrpc":"2.0", "id":"hello", "result":{"protocolVersion":"2025-06-18", "capabilities":{"tools":{}}}});
    let (origin, seen) = peer("200 OK", result.clone()).await;
    let mut client = bridge(origin);
    let request =
        json!({"jsonrpc":"2.0", "id":"hello", "method":"initialize", "params":{"capabilities":{}}});
    assert_eq!(client.forward(&request).await.unwrap(), Some(result));
    assert_eq!(client.version, "2025-06-18");
    let wire = seen.await.unwrap();
    assert!(wire
        .to_lowercase()
        .contains("mcp-protocol-version: 2025-03-26"));
    assert_eq!(
        serde_json::from_str::<Value>(wire.split("\r\n\r\n").nth(1).unwrap()).unwrap(),
        request
    );
}

#[tokio::test]
async fn notifications_have_no_reply_and_mismatched_response_ids_fail() {
    let (origin, seen) = peer("202 Accepted", Value::Null).await;
    assert!(bridge(origin)
        .forward(&json!({"jsonrpc":"2.0","method":"notifications/initialized"}))
        .await
        .unwrap()
        .is_none());
    seen.await.unwrap();
    let (origin, seen) = peer("200 OK", json!({"jsonrpc":"2.0","id":2,"result":{}})).await;
    assert!(bridge(origin)
        .forward(&json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}))
        .await
        .is_err());
    seen.await.unwrap();
}

#[tokio::test]
async fn transport_failure_and_revocation_do_not_replay_calls() {
    let (origin, seen) = peer("401 Unauthorized", json!({"error":"invalid_token"})).await;
    let error = bridge(origin)
        .forward(&json!({"jsonrpc":"2.0","id":1,"method":"tools/call"}))
        .await
        .unwrap_err();
    assert_eq!(error, REVOKED); // A second request would fail: the peer has gone away.
    seen.await.unwrap();
    let (origin, seen) = peer("503 Unavailable", json!({"error":"offline"})).await;
    assert!(bridge(origin)
        .forward(&json!({"jsonrpc":"2.0","id":1,"method":"tools/call"}))
        .await
        .is_err());
    seen.await.unwrap();
}

#[tokio::test]
async fn credential_budget_reconnect_and_poll_are_write_free() {
    let directory =
        std::env::temp_dir().join(format!("diskhound-bridge-test-{}", random().unwrap()));
    let counts = Arc::new(Mutex::new(CredentialCounts::default()));
    let saved = store(&counts, &directory);
    let (origin, approved) = approving_peer().await;
    let mut first = bridge(origin.clone());
    first.credentials = Some(store(&counts, &directory));
    first.token = None;
    first.ensure_token().await.unwrap();
    approved.await.unwrap();
    // 100 separate connections load once each; 1,440 requests per connection
    // (one a minute all day) use only the in-memory token. No per-tick writes.
    for _ in 0..100 {
        let mut client = bridge(origin.clone());
        client.credentials = Some(store(&counts, &directory));
        client.token = None;
        for _ in 0..1440 {
            client.ensure_token().await.unwrap();
        }
    }
    saved.clear().await.unwrap();
    let counts = counts.lock().unwrap();
    let budgets: Value = serde_json::from_str(include_str!("../io-budgets.json")).unwrap();
    let budget = &budgets["approval-reconnect-and-poll"];
    assert_eq!(
        counts.reads,
        budget["credentialReads"].as_u64().unwrap() as usize
    );
    assert_eq!(
        counts.writes,
        budget["credentialWrites"].as_u64().unwrap() as usize
    );
    assert_eq!(
        counts.deletes,
        budget["credentialDeletes"].as_u64().unwrap() as usize
    );
    assert_eq!(
        counts.bytes,
        budget["observedPayloadBytesWritten"].as_u64().unwrap() as usize
    );
    std::fs::remove_dir_all(directory).unwrap();
}

#[tokio::test]
async fn concurrent_connections_wait_for_the_first_approval() {
    let directory =
        std::env::temp_dir().join(format!("diskhound-bridge-lock-{}", random().unwrap()));
    let counts = Arc::new(Mutex::new(CredentialCounts::default()));
    let saved = store(&counts, &directory);
    let first = saved.lock(51735).await.unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(50), saved.lock(51735))
            .await
            .is_err()
    );
    drop(first);
    let second = tokio::time::timeout(Duration::from_secs(1), saved.lock(51735))
        .await
        .unwrap()
        .unwrap();
    drop(second);
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn approvals_name_the_client_the_user_knows() {
    assert_eq!(
        client_label(&json!({"name":"claude-ai","version":"0.1.0"})),
        "Claude Desktop"
    );
    // Claude Desktop 2.16 running DiskHound's extension.
    assert_eq!(
        client_label(&json!({"name":"local-agent-mode-DiskHound"})),
        "Claude Desktop"
    );
    assert_eq!(client_label(&json!({"name":"claude-code"})), "Claude Code");
    assert_eq!(
        client_label(&json!({"name":"codex-mcp-client","title":"Codex"})),
        "Codex"
    );
    assert_eq!(
        client_label(&json!({"name":"acme","title":"Acme Agent"})),
        "Acme Agent"
    );
    assert_eq!(client_label(&json!({"name":"acme"})), "acme");
    assert_eq!(client_label(&json!({})), "MCP client");
    assert_eq!(client_label(&json!({"name":"a\u{7}b"})), "ab");
}

#[tokio::test]
async fn a_token_is_never_sent_to_another_app_on_the_port() {
    let (origin, seen) = peer(
        "200 OK",
        json!({"resource":"http://127.0.0.1:1/mcp","resource_name":"PwrSuiteLab Control"}),
    )
    .await;
    let mut client = bridge(origin);
    client.verified = false;
    assert_eq!(client.verify().await.unwrap_err(), NOT_DISKHOUND);
    let wire = seen.await.unwrap();
    assert!(wire.starts_with("GET /.well-known/oauth-protected-resource/mcp"));
    assert!(!wire.to_lowercase().contains("authorization:"));
}

#[tokio::test]
async fn initialize_answers_at_once_while_the_user_decides() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let metadata =
        json!({"resource":format!("{origin}/mcp"),"resource_name":"DiskHound"}).to_string();
    let served = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let request = read_request(&mut socket).await;
        socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{metadata}", metadata.len()).as_bytes()).await.unwrap();
        request
    });
    let mut client = bridge(origin);
    client.verified = false;
    client.token = None;
    let started = Instant::now();
    let (reply, notes) = client
        .handle(&json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{
            "protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"claude-code","version":"1"}}}))
        .await
        .unwrap();
    assert!(started.elapsed() < Duration::from_secs(2));
    assert!(notes.is_empty());
    let reply = reply.unwrap();
    assert_eq!(reply["result"]["protocolVersion"], "2025-06-18");
    assert_eq!(
        reply["result"]["capabilities"]["tools"]["listChanged"],
        true
    );
    assert!(reply["result"]["instructions"]
        .as_str()
        .unwrap()
        .contains("approve"));
    assert_eq!(client.client_name, "Claude Code");
    // The approval waits a moment, so a health check never opens it.
    assert!(client.approval.is_none() && client.approval_due.is_some());
    assert!(served.await.unwrap().starts_with("GET /.well-known/"));
    // Before approval: one placeholder tool, empty lists, no network.
    let (prompts, _) = client
        .handle(&json!({"jsonrpc":"2.0","id":2,"method":"prompts/list"}))
        .await
        .unwrap();
    assert_eq!(prompts.unwrap()["result"]["prompts"], json!([]));
    let (tools, _) = client
        .handle(&json!({"jsonrpc":"2.0","id":3,"method":"tools/list"}))
        .await
        .unwrap();
    assert_eq!(
        tools.unwrap()["result"]["tools"][0]["name"],
        "diskhound_status"
    );
    // Listing is all a health check does, so it doesn't ask the user.
    assert!(client.approval.is_none());
}

#[tokio::test]
async fn hanging_up_withdraws_the_approval_diskhound_is_showing() {
    let (origin, seen) = peer("204 No Content", json!({})).await;
    let client = bridge(origin);
    // Nothing waiting: nothing to withdraw, no request.
    client.withdraw_pending().await;
    *client.pending.lock().unwrap() = Some("a".repeat(43));
    client.withdraw_pending().await;
    let wire = seen.await.unwrap();
    assert!(wire.starts_with("POST /authorize/cancel"));
    assert!(wire.ends_with(&format!("id={}", "a".repeat(43))));
    assert!(!wire.to_lowercase().contains("authorization:"));
}

#[tokio::test]
async fn an_unreachable_diskhound_still_connects_and_says_why() {
    // Nothing listens on this port.
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);
    let mut client = bridge(origin);
    client.verified = false;
    client.token = None;
    let (reply, _) = client
        .handle(&json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"codex-mcp-client"}}}))
        .await
        .unwrap();
    assert!(reply.unwrap()["result"]["serverInfo"]["name"] == "diskhound");
    let (tools, _) = client
        .handle(&json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}))
        .await
        .unwrap();
    assert_eq!(
        tools.unwrap()["result"]["tools"][0]["name"],
        "diskhound_status"
    );
    let (status, _) = client
        .handle(&json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"diskhound_status","arguments":{}}}))
        .await
        .unwrap();
    let status = status.unwrap();
    assert_eq!(status["result"]["isError"], true);
    assert_eq!(status["result"]["content"][0]["text"], OFFLINE);
}

#[tokio::test]
async fn a_role_change_tells_the_client_to_reload_tools() {
    let reply = json!({"jsonrpc":"2.0","id":1,"result":{"tools":[]}});
    let (origin, seen) = peer_with_headers(
        "200 OK",
        "DiskHound-Capabilities: disk.read,files.trash\r\n",
        reply,
    )
    .await;
    let mut client = bridge(origin);
    client.capabilities = Some("disk.read".into());
    let (_, notes) = client
        .handle(&json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}))
        .await
        .unwrap();
    assert_eq!(
        notes,
        vec![json!({"jsonrpc":"2.0","method":"notifications/tools/list_changed"})]
    );
    assert_eq!(
        client.capabilities.as_deref(),
        Some("disk.read,files.trash")
    );
    seen.await.unwrap();
}

#[tokio::test]
async fn claude_desktop_waits_for_the_users_decision_before_listing_tools() {
    let reply =
        json!({"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"diskhound_list_folder"}]}});
    let (origin, seen) = peer("200 OK", reply).await;
    let mut client = bridge(origin);
    client.token = None;
    assert!(lists_tools_once(
        &json!({"name":"local-agent-mode-DiskHound"})
    ));
    assert!(lists_tools_once(&json!({"name":"claude-ai"})));
    assert!(!lists_tools_once(&json!({"name":"claude-code"})));
    client.lists_once = true;
    // The user approves while Claude's first tools/list is waiting.
    let (decide, decision) = tokio::sync::watch::channel(Approval::Pending);
    client.approval = Some(decision);
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(100)).await;
        let _ = decide.send(Approval::Approved(format!("dhmcp_{}", "c".repeat(43))));
    });
    let (tools, _) = client
        .handle(&json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}))
        .await
        .unwrap();
    assert_eq!(
        tools.unwrap()["result"]["tools"][0]["name"],
        "diskhound_list_folder"
    );
    assert!(!client.stale_list);
    assert!(seen
        .await
        .unwrap()
        .contains(&format!("Bearer dhmcp_{}", "c".repeat(43))));
}

#[tokio::test]
async fn claude_desktop_hears_how_to_reload_tools_it_listed_too_early() {
    // It listed before the user approved: its list is the placeholder.
    let mut client = bridge("http://127.0.0.1:9".into());
    client.token = None;
    client.lists_once = true;
    client.failed = Some(OFFLINE);
    let (tools, _) = client
        .handle(&json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}))
        .await
        .unwrap();
    assert_eq!(
        tools.unwrap()["result"]["tools"][0]["name"],
        "diskhound_status"
    );
    assert!(client.stale_list);
    // Approved later: diskhound_status says how to get the real list.
    let status = json!({"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"ok"}]}});
    let (origin, seen) = peer("200 OK", status).await;
    client.origin = origin;
    client.failed = None;
    client.token = Some(format!("dhmcp_{}", "a".repeat(43)));
    let (reply, _) = client
        .handle(&json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"diskhound_status","arguments":{}}}))
        .await
        .unwrap();
    let content = &reply.unwrap()["result"]["content"];
    assert_eq!(content[0]["text"], "ok");
    assert_eq!(content[1]["text"], RECONNECT_FOR_TOOLS);
    seen.await.unwrap();
}

#[tokio::test]
async fn a_role_change_tells_claude_desktop_to_reconnect() {
    let status = json!({"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"ok"}]}});
    let (origin, seen) = peer_with_headers(
        "200 OK",
        "DiskHound-Capabilities: disk.read,files.trash\r\n",
        status,
    )
    .await;
    let mut client = bridge(origin);
    client.lists_once = true;
    client.capabilities = Some("disk.read".into());
    let (reply, notes) = client
        .handle(&json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"diskhound_status","arguments":{}}}))
        .await
        .unwrap();
    assert_eq!(
        reply.unwrap()["result"]["content"][1]["text"],
        RECONNECT_FOR_TOOLS
    );
    assert_eq!(
        notes,
        vec![json!({"jsonrpc":"2.0","method":"notifications/tools/list_changed"})]
    );
    seen.await.unwrap();
}

#[tokio::test]
async fn each_client_keeps_its_own_approval_and_lock() {
    assert_eq!(
        credentials::account("http://127.0.0.1:51735", "Claude Desktop"),
        "http://127.0.0.1:51735#Claude Desktop"
    );
    let directory =
        std::env::temp_dir().join(format!("diskhound-bridge-clients-{}", random().unwrap()));
    let counts = Arc::new(Mutex::new(CredentialCounts::default()));
    let store = store(&counts, &directory);
    let code = store.for_client("Claude Code").unwrap();
    let desktop = store.for_client("Claude Desktop").unwrap();
    let waiting = code.lock(51735).await.unwrap();
    // Claude Code waiting for the user doesn't hold up Claude Desktop...
    let other = tokio::time::timeout(Duration::from_secs(1), desktop.lock(51735))
        .await
        .unwrap()
        .unwrap();
    // ...but a second Claude Code connection waits for the first.
    assert!(
        tokio::time::timeout(Duration::from_millis(50), code.lock(51735))
            .await
            .is_err()
    );
    drop((waiting, other));
    std::fs::remove_dir_all(directory).unwrap();
}
