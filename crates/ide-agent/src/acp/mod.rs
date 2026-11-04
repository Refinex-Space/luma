//! The ACP dialect an agent speaks: v1, or the v2 draft (`claude-agent-acp` serves v2
//! to clients that ask for it). The rest of the crate speaks v1; this layer negotiates
//! the version in `initialize` and translates v2 in both directions:
//!
//! - `initialize`: one request that both versions accept ([`initialize_params`]); the
//!   response's shape tells which one the agent chose ([`Negotiated`]).
//! - Requests ([`Conn::request`]): `session/load` becomes `session/resume` without a
//!   replay (the task keeps its own history), `authenticate` becomes `auth/login`, a
//!   select config value gets its `type: "id"` tag, and the commands that v2 puts in
//!   setup responses arrive as the v1 `available_commands_update`.
//! - Turns: a v2 `session/prompt` answers once the prompt is taken in, and the turn ends
//!   with an `idle` `state_update`; [`Conn::request`] resolves `session/prompt` there,
//!   with the v1 response (`stopReason`) or the turn's error.
//! - Agent → client ([`Dialect`]): `session/update`s are normalized ([`normalize`]) and
//!   permission requests get the v1 `toolCall`.
//! - Startup notes: an agent may announce what it loaded (its version, skills, prompts,
//!   extensions) as an agent message right after `session/new`, outside any turn (`pi-acp`
//!   does, and names the text in the answer's `_meta.piAcp.startupInfo`). That message
//!   is dropped, so it does not read as the reply to the first prompt; see [`Setups`].

mod normalize;

use ide_jsonrpc::{Handler, Peer, RpcError, codes};
use normalize::Normalizer;
use parking_lot::Mutex;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicU8, Ordering};
use tokio::sync::oneshot;

/// The capabilities this client offers, in v1 form.
fn client_capabilities() -> Value {
    json!({
        "fs": { "readTextFile": false, "writeTextFile": false },
        "terminal": false,
        // Subagents as sessions of their own (ACP subagents RFD; v2 baseline).
        "subagents": {},
    })
}

/// The `initialize` request for either version: v2's `protocolVersion`, `info` and
/// `capabilities`, plus v1's `clientCapabilities` and `clientInfo`. A v1 agent answers
/// with version 1 and reads the v1 fields; a v2 agent ignores them.
/// `client_info` is `{ name, version }`.
pub(crate) fn initialize_params(client_info: &Value) -> Value {
    json!({
        "protocolVersion": 2,
        "info": client_info,
        "capabilities": {},
        "clientCapabilities": client_capabilities(),
        "clientInfo": client_info,
    })
}

/// What `initialize` settled: the protocol generation and the agent's capabilities in
/// v1 form (`agentCapabilities`), whichever version it speaks.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Negotiated {
    /// 1 or 2.
    pub generation: u8,
    /// v1 `agentCapabilities`: `loadSession`, `promptCapabilities`, `mcpCapabilities`,
    /// `sessionCapabilities`, `_meta`.
    pub capabilities: Value,
    /// v1 `agentInfo`.
    pub agent_info: Option<Value>,
    /// v1 `authMethods` (`{ id, name, description?, type? }`).
    pub auth_methods: Vec<Value>,
    /// The response's top-level `_meta`.
    pub meta: Option<Value>,
}

impl Negotiated {
    /// Reads an `initialize` response. The shape decides, not `protocolVersion`: some v1
    /// agents report version 2 with v1 fields (`agentInfo`, `agentCapabilities`); only a
    /// v2 response has `info`.
    pub fn from_initialize(response: &Value) -> Self {
        let meta = response.get("_meta").filter(|m| m.is_object()).cloned();
        if response.get("info").is_none_or(Value::is_null) {
            return Self {
                generation: 1,
                capabilities: response.get("agentCapabilities").cloned().unwrap_or_else(|| json!({})),
                agent_info: response.get("agentInfo").filter(|v| !v.is_null()).cloned(),
                auth_methods: response.get("authMethods").and_then(Value::as_array).cloned().unwrap_or_default(),
                meta,
            };
        }
        let caps = response.get("capabilities");
        let session = caps.and_then(|c| c.get("session")).filter(|s| s.is_object());
        // v2 capabilities are objects: present (`{}`) means supported, absent or `null` not.
        let has = |v: Option<&Value>, key: &str| v.and_then(|v| v.get(key)).is_some_and(|c| !c.is_null());
        let prompt = session.and_then(|s| s.get("prompt"));
        let mcp = session.and_then(|s| s.get("mcp"));
        let mut capabilities = json!({
            // The session baseline includes `session/resume`, which stands in for `session/load`.
            "loadSession": session.is_some(),
            "promptCapabilities": {
                "image": has(prompt, "image"),
                "audio": has(prompt, "audio"),
                "embeddedContext": has(prompt, "embeddedContext"),
            },
            "mcpCapabilities": { "http": has(mcp, "http"), "sse": false },
        });
        if session.is_some() {
            let mut sc = json!({ "list": {}, "resume": {}, "close": {} });
            for key in ["fork", "delete", "additionalDirectories"] {
                if has(session, key) {
                    sc[key] = json!({});
                }
            }
            capabilities["sessionCapabilities"] = sc;
        }
        if let Some(m) = caps.and_then(|c| c.get("_meta")).filter(|m| m.is_object()) {
            capabilities["_meta"] = m.clone();
        }
        let auth_methods = response
            .get("authMethods")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|m| {
                let mut v1 = m.as_object()?.clone();
                let id = v1.remove("methodId")?;
                v1.insert("id".into(), id);
                Some(Value::Object(v1))
            })
            .collect();
        Self { generation: 2, capabilities, agent_info: response.get("info").cloned(), auth_methods, meta }
    }

    /// Whether a saved session can be reopened (`session/load` on v1, `session/resume` on v2).
    pub fn load_session(&self) -> bool {
        self.capabilities.get("loadSession").and_then(Value::as_bool) == Some(true)
    }

    /// `promptCapabilities.<name>` (`image`, `audio`, `embeddedContext`).
    pub fn prompt(&self, name: &str) -> bool {
        self.capabilities.pointer(&format!("/promptCapabilities/{name}")).and_then(Value::as_bool) == Some(true)
    }

    /// `sessionCapabilities.<name>` (`fork`, `resume`, `close`, `list`, `delete`).
    pub fn session(&self, name: &str) -> bool {
        self.capabilities.pointer(&format!("/sessionCapabilities/{name}")).is_some_and(|v| !v.is_null())
    }

    /// `agentCapabilities._meta` at `pointer` (e.g. `/luma/rollback`).
    pub fn meta(&self, pointer: &str) -> Option<&Value> {
        self.capabilities.get("_meta")?.pointer(pointer)
    }
}

/// The client side of one agent connection: wraps the task's [`Handler`] and, once
/// `initialize` has chosen v2, translates what the agent sends.
pub(crate) struct Dialect {
    inner: Arc<dyn Handler>,
    /// 0 until `initialize` answers; then 1 or 2.
    generation: AtomicU8,
    normalizer: Mutex<Normalizer>,
    /// Running v2 prompts, by session id.
    turns: Mutex<HashMap<String, Turn>>,
    setups: Mutex<Setups>,
}

/// Session setups under way, and what waits for them.
///
/// An agent can send its startup note right after answering `session/new` (`pi-acp` does,
/// on the next tick), so the note may be read before the request's caller sees the
/// answer and learns the text to drop. While a `session/new` is under way, updates for
/// sessions this connection does not know yet wait here, in order, until it is answered.
#[derive(Default)]
struct Setups {
    /// `session/new` requests not answered yet.
    running: usize,
    /// Sessions set up on this connection or named in a request.
    known: HashSet<String>,
    /// Waiting `session/update` params, in arrival order.
    held: Vec<(String, Value)>,
    /// The startup note each session's agent announced and has not sent yet.
    notes: HashMap<String, String>,
}

/// The startup note an agent names in a setup answer: `_meta.<agent>.startupInfo`.
fn startup_note(response: &Value) -> Option<String> {
    let meta = response.get("_meta")?.as_object()?;
    let text = meta.values().find_map(|v| v.get("startupInfo")?.as_str())?;
    (!text.trim().is_empty()).then(|| text.to_owned())
}

/// Whether `params` is the agent message `note`, whole.
fn is_note(params: &Value, note: &str) -> bool {
    let update = &params["update"];
    update["sessionUpdate"] == "agent_message_chunk"
        && update["content"]["type"] == "text"
        && update["content"]["text"].as_str().is_some_and(|t| t.trim() == note.trim())
}

struct Turn {
    done: oneshot::Sender<Result<Value, RpcError>>,
    /// The agent took the prompt in (`user_message`) or reported the turn working.
    /// Before that an `idle` without a stop reason is a stale state snapshot.
    started: bool,
}

impl Dialect {
    pub fn wrap(inner: Arc<dyn Handler>) -> Arc<Self> {
        Arc::new(Self {
            inner,
            generation: AtomicU8::new(0),
            normalizer: Mutex::new(Normalizer::default()),
            turns: Mutex::new(HashMap::new()),
            setups: Mutex::new(Setups::default()),
        })
    }

    pub fn generation(&self) -> u8 {
        self.generation.load(Ordering::Acquire)
    }

    fn v2(&self) -> bool {
        self.generation() == 2
    }

    /// Feeds a v1 update to the wrapped handler as if the agent had sent it.
    fn deliver(&self, session: &str, update: Value) {
        self.inner.on_notification("session/update", json!({ "sessionId": session, "update": update }));
    }

    /// Settles the running prompt of `session` on a v2 `state_update`.
    fn on_state(&self, session: &str, update: &Value) {
        let mut turns = self.turns.lock();
        let Some(turn) = turns.get_mut(session) else { return };
        let stop = update.get("stopReason").and_then(Value::as_str);
        match update.get("state").and_then(Value::as_str) {
            Some("idle") if turn.started || stop.is_some() => {}
            Some("idle") => return,
            Some(_) => {
                turn.started = true;
                return;
            }
            None => return,
        }
        let Some(turn) = turns.remove(session) else { return };
        let error = update.get("error").filter(|e| e.is_object());
        let result = match error {
            e if e.is_some() || stop == Some("error") => Err(RpcError::Server {
                code: e.and_then(|e| e.get("code")).and_then(Value::as_i64).unwrap_or(codes::INTERNAL_ERROR),
                message: e
                    .and_then(|e| e.get("message"))
                    .and_then(Value::as_str)
                    .unwrap_or("The agent stopped with an error.")
                    .to_owned(),
                data: e.and_then(|e| e.get("data")).cloned(),
            }),
            _ => {
                let mut v = json!({ "stopReason": stop.unwrap_or("end_turn") });
                if let Some(u) = update.get("usage").filter(|u| !u.is_null()) {
                    v["usage"] = u.clone();
                }
                Ok(v)
            }
        };
        let _ = turn.done.send(result);
    }

    /// A session named in a request (`session/load`, `session/prompt`…): known from now on.
    fn know(&self, session: &str) {
        let mut setups = self.setups.lock();
        if !setups.known.contains(session) {
            setups.known.insert(session.to_owned());
        }
    }

    /// A `session/new` is about to be sent.
    fn begin_setup(&self) {
        self.setups.lock().running += 1;
    }

    /// A `session/new` was answered (`response`, or `None` when it failed): its session is
    /// known, its startup note is expected, and the updates that waited for it go on, in
    /// order (the note among them dropped). The lock stays held meanwhile, so updates
    /// read now queue behind them.
    fn end_setup(&self, response: Option<&Value>) {
        let mut setups = self.setups.lock();
        setups.running = setups.running.saturating_sub(1);
        if let Some(id) = response.and_then(|r| r.get("sessionId")).and_then(Value::as_str) {
            setups.known.insert(id.to_owned());
            if let Some(note) = response.and_then(startup_note) {
                setups.notes.insert(id.to_owned(), note);
            }
        }
        let held = std::mem::take(&mut setups.held);
        let (go, wait): (Vec<_>, Vec<_>) =
            held.into_iter().partition(|(s, _)| setups.running == 0 || setups.known.contains(s));
        setups.held = wait;
        for (session, params) in go {
            if setups.notes.get(&session).is_some_and(|note| is_note(&params, note)) {
                setups.notes.remove(&session);
                continue;
            }
            self.forward("session/update", params);
        }
    }

    /// A v2 setup response (`session/new`, `resume`, `fork`): its commands become the
    /// `available_commands_update` a v1 agent sends after it.
    fn on_setup(&self, session: Option<&str>, response: &Value) {
        let (Some(session), Some(commands)) = (session, response.get("availableCommands").filter(|c| c.is_array()))
        else {
            return;
        };
        let update = json!({ "sessionUpdate": "available_commands_update", "availableCommands": commands });
        let updates = self.normalizer.lock().normalize(session, &update);
        for u in updates {
            self.deliver(session, u);
        }
    }
}

impl Handler for Dialect {
    fn on_notification(&self, method: &str, params: Value) {
        if method == "session/update"
            && let Some(session) = params.get("sessionId").and_then(Value::as_str)
        {
            let mut setups = self.setups.lock();
            if setups.running > 0 && !setups.known.contains(session) {
                setups.held.push((session.to_owned(), params));
                return;
            }
            if setups.notes.get(session).is_some_and(|note| is_note(&params, note)) {
                setups.notes.remove(session);
                return;
            }
        }
        self.forward(method, params);
    }

    fn on_request(&self, method: &str, params: Value) -> Result<Value, (i64, String)> {
        if self.v2() && method == "session/request_permission" {
            return self.inner.on_request(method, v1_permission_request(params));
        }
        self.inner.on_request(method, params)
    }
}

impl Dialect {
    /// What the agent sent, on to the task: v2 updates normalized first.
    fn forward(&self, method: &str, params: Value) {
        if !self.v2() || method != "session/update" {
            return self.inner.on_notification(method, params);
        }
        let (Some(session), Some(update)) = (params.get("sessionId").and_then(Value::as_str), params.get("update"))
        else {
            return;
        };
        match update.get("sessionUpdate").and_then(Value::as_str) {
            Some("state_update") => return self.on_state(session, update),
            Some("user_message") => {
                if let Some(turn) = self.turns.lock().get_mut(session) {
                    turn.started = true;
                }
            }
            _ => {}
        }
        let updates = self.normalizer.lock().normalize(session, update);
        for u in updates {
            let mut p = params.clone();
            p["update"] = u;
            self.inner.on_notification(method, p);
        }
    }
}

/// A v2 permission request with the v1 `toolCall` (its subject's, titled with the request's title).
fn v1_permission_request(mut params: Value) -> Value {
    let subject = params.get("subject").cloned().unwrap_or(Value::Null);
    let mut tool = match subject.get("type").and_then(Value::as_str) {
        Some("tool_call") => subject.get("toolCall").cloned().unwrap_or_else(|| json!({})),
        _ => json!({ "toolCallId": subject.get("toolCallId").cloned().unwrap_or(Value::Null), "kind": "execute" }),
    };
    if let Some(content) = tool.get("content").and_then(Value::as_array) {
        tool["content"] = Value::Array(normalize::v1_content(content, &|_| None));
    }
    if let Some(title) = params.get("title").filter(|t| t.as_str().is_some_and(|t| !t.is_empty())) {
        tool["title"] = title.clone();
    }
    params["toolCall"] = tool;
    params
}

/// A connection to an agent, spoken in v1 whichever version the agent chose.
#[derive(Clone)]
pub(crate) struct Conn {
    peer: Peer,
    dialect: Arc<Dialect>,
}

impl std::ops::Deref for Conn {
    type Target = Peer;
    fn deref(&self) -> &Peer {
        &self.peer
    }
}

impl Conn {
    /// `peer` must deliver the agent's messages to `dialect`.
    pub fn new(peer: Peer, dialect: Arc<Dialect>) -> Self {
        Self { peer, dialect }
    }

    #[allow(dead_code)]
    pub fn generation(&self) -> u8 {
        self.dialect.generation()
    }

    /// Sends the negotiating `initialize` and settles the dialect.
    pub async fn initialize(&self, client_info: &Value) -> Result<Negotiated, RpcError> {
        let response: Value = self.peer.request("initialize", initialize_params(client_info), None).await?;
        let negotiated = Negotiated::from_initialize(&response);
        self.dialect.generation.store(negotiated.generation, Ordering::Release);
        Ok(negotiated)
    }

    /// A v1 request, sent in the agent's dialect; the response comes back in v1 form.
    pub async fn request<P: Serialize, R: DeserializeOwned>(
        &self,
        method: &str,
        params: P,
        cancel: Option<ide_core::CancellationToken>,
    ) -> Result<R, RpcError> {
        let params = serde_json::to_value(params).map_err(|e| RpcError::Protocol(e.to_string()))?;
        if let Some(session) = params.get("sessionId").and_then(Value::as_str) {
            self.dialect.know(session);
        }
        // Settled however the request ends, cancelled (dropped) too.
        let mut setup = (method == "session/new").then(|| {
            self.dialect.begin_setup();
            Setup { dialect: &self.dialect, answer: None }
        });
        let value = if self.dialect.v2() {
            self.request_v2(method, params, cancel).await
        } else {
            self.peer.request(method, params, cancel).await
        };
        if let (Some(setup), Ok(answer)) = (setup.as_mut(), &value) {
            setup.answer = Some(answer.clone());
        }
        drop(setup);
        serde_json::from_value(value?).map_err(|e| RpcError::Protocol(format!("{method}: {e}")))
    }

    async fn request_v2(
        &self,
        method: &str,
        mut params: Value,
        cancel: Option<ide_core::CancellationToken>,
    ) -> Result<Value, RpcError> {
        let session = params.get("sessionId").and_then(Value::as_str).map(str::to_owned);
        match method {
            "session/prompt" => return self.prompt_v2(params, cancel).await,
            // The task keeps its history: resumed without a replay.
            "session/load" | "session/resume" | "session/fork" => {
                let method = if method == "session/load" { "session/resume" } else { method };
                let response: Value = self.peer.request(method, params, cancel).await?;
                let id = response.get("sessionId").and_then(Value::as_str).map(str::to_owned).or(session);
                self.dialect.on_setup(id.as_deref(), &response);
                return Ok(response);
            }
            "session/new" => {
                let response: Value = self.peer.request(method, params, cancel).await?;
                self.dialect.on_setup(response.get("sessionId").and_then(Value::as_str), &response);
                return Ok(response);
            }
            // v2 tags the value's type.
            "session/set_config_option" if params.get("type").is_none() => {
                params["type"] =
                    json!(if params.get("value").is_some_and(Value::is_boolean) { "boolean" } else { "id" });
            }
            _ => {}
        }
        let method = match method {
            "authenticate" => "auth/login",
            "logout" => "auth/logout",
            m => m,
        };
        self.peer.request(method, params, cancel).await
    }

    /// A v2 prompt: answered once taken in; the turn ends with the session's `idle`.
    async fn prompt_v2(&self, params: Value, cancel: Option<ide_core::CancellationToken>) -> Result<Value, RpcError> {
        let session = params.get("sessionId").and_then(Value::as_str).unwrap_or_default().to_owned();
        let (done, ended) = oneshot::channel();
        // Before sending: the turn can end before the response is read.
        self.dialect.turns.lock().insert(session.clone(), Turn { done, started: false });
        let turns = &self.dialect.turns;
        let _forget = Forget(|| {
            turns.lock().remove(&session);
        });
        match self.peer.request::<_, Value>("session/prompt", params, cancel.clone()).await {
            Ok(_) => {}
            // Cancelled while queued, before the agent took it in (`-32800`).
            Err(RpcError::Cancelled) if !cancel.as_ref().is_some_and(|t| t.is_cancelled()) => {
                return Ok(json!({ "stopReason": "cancelled" }));
            }
            Err(e) => return Err(e),
        }
        let cancelled = async {
            match &cancel {
                Some(t) => t.cancelled().await,
                None => std::future::pending().await,
            }
        };
        tokio::select! {
            biased;
            r = ended => r.unwrap_or(Err(RpcError::Closed)),
            _ = self.peer.closed() => Err(RpcError::Closed),
            _ = cancelled => Err(RpcError::Cancelled),
        }
    }
}

/// A `session/new` under way: ends the setup when dropped, with the answer if one came.
struct Setup<'a> {
    dialect: &'a Dialect,
    answer: Option<Value>,
}

impl Drop for Setup<'_> {
    fn drop(&mut self) {
        self.dialect.end_setup(self.answer.as_ref());
    }
}

/// Runs its closure when dropped.
struct Forget<F: FnMut()>(F);

impl<F: FnMut()> Drop for Forget<F> {
    fn drop(&mut self) {
        (self.0)();
    }
}

#[cfg(test)]
mod e2e;
#[cfg(test)]
mod tests;
