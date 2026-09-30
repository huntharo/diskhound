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
    Bridge {
        http: Client::builder()
            .no_proxy()
            .redirect(Policy::none())
            .build()
            .unwrap(),
        port: Url::parse(&origin).unwrap().port().unwrap(),
        origin,
        token: Some(format!("dhmcp_{}", "a".repeat(43))),
        credentials: None,
        version: "2025-03-26".into(),
    }
}

// Tiny loopback peer: record the actual wire request and serve one response.
async fn peer(status: &str, response: Value) -> (String, tokio::task::JoinHandle<String>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let body = response.to_string();
    let reply = format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
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
    let first = saved.lock(51733).await.unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(50), saved.lock(51733))
            .await
            .is_err()
    );
    drop(first);
    let second = tokio::time::timeout(Duration::from_secs(1), saved.lock(51733))
        .await
        .unwrap()
        .unwrap();
    drop(second);
    std::fs::remove_dir_all(directory).unwrap();
}
