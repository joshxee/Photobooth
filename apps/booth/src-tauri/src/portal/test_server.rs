//! A tiny HTTP/1.1 server on localhost for the portal client's tests: it records every request
//! and answers from a handler. Hand-rolled (about 100 lines) rather than a mock-server crate,
//! which would add a dependency tree for tests that need one request at a time.

use std::sync::{Arc, Mutex};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// One request as the server saw it. Header names are lowercase.
#[derive(Clone, Debug)]
pub struct Recorded {
    pub method: String,
    /// Path and query.
    pub target: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Recorded {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, v)| v.as_str())
    }

    pub fn json(&self) -> serde_json::Value {
        serde_json::from_slice(&self.body).expect("JSON body")
    }
}

/// The answer to one request.
#[derive(Clone, Debug)]
pub struct Canned {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Canned {
    pub fn json(status: u16, body: &str) -> Self {
        Self {
            status,
            headers: vec![("Content-Type".into(), "application/json".into())],
            body: body.as_bytes().to_vec(),
        }
    }

    pub fn with_header(mut self, name: &str, value: &str) -> Self {
        self.headers.push((name.into(), value.into()));
        self
    }
}

type Handler = dyn Fn(&Recorded) -> Canned + Send + Sync;

pub struct MockPortal {
    pub base: String,
    requests: Arc<Mutex<Vec<Recorded>>>,
}

impl MockPortal {
    /// Listens on 127.0.0.1 (a free port) and answers every request with `handler`.
    pub async fn start(handler: impl Fn(&Recorded) -> Canned + Send + Sync + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let handler: Arc<Handler> = Arc::new(handler);
        let log = requests.clone();
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let handler = handler.clone();
                let log = log.clone();
                tokio::spawn(async move { serve(stream, &handler, &log).await });
            }
        });
        Self { base, requests }
    }

    pub fn requests(&self) -> Vec<Recorded> {
        self.requests.lock().unwrap().clone()
    }
}

/// Reads one request, records it, answers it and closes the connection. `None` when the
/// client went away first.
async fn serve(
    mut stream: TcpStream,
    handler: &Arc<Handler>,
    log: &Mutex<Vec<Recorded>>,
) -> Option<()> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    let head_end = loop {
        let n = stream.read(&mut chunk).await.ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i;
        }
    };
    let head = String::from_utf8(buf[..head_end].to_vec()).ok()?;
    let mut lines = head.split("\r\n");
    let mut request_line = lines.next()?.split(' ');
    let method = request_line.next()?.to_owned();
    let target = request_line.next()?.to_owned();
    let headers: Vec<(String, String)> = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(n, v)| (n.trim().to_ascii_lowercase(), v.trim().to_owned()))
        .collect();
    let length: usize = headers
        .iter()
        .find(|(n, _)| n == "content-length")
        .and_then(|(_, v)| v.parse().ok())
        .unwrap_or(0);
    let mut body = buf[head_end + 4..].to_vec();
    while body.len() < length {
        let n = stream.read(&mut chunk).await.ok()?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n]);
    }
    let request = Recorded {
        method,
        target,
        headers,
        body,
    };
    let canned = handler(&request);
    log.lock().unwrap().push(request);

    let mut response = format!("HTTP/1.1 {} X\r\n", canned.status);
    for (name, value) in &canned.headers {
        response.push_str(&format!("{name}: {value}\r\n"));
    }
    response.push_str(&format!(
        "Content-Length: {}\r\nConnection: close\r\n\r\n",
        canned.body.len()
    ));
    stream.write_all(response.as_bytes()).await.ok()?;
    stream.write_all(&canned.body).await.ok()?;
    stream.shutdown().await.ok()?;
    Some(())
}
