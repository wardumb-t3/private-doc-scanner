//! `z:<tenant>:doc-intake` — receives `pde.submission/v1` from the
//! Private Doc Scanner app and keeps it inside the enclave.
//!
//! Maps (created by `deploy.ts`, readable/writable only by this contract):
//! - `intake`: `req:<request_id>` → stored record (owner DID, values, checks)
//! - `config`: `agents` → JSON list of hex agent DIDs allowed to read status
//!   and run `evaluate` for any request (set by the tenant via control plane)

extern crate alloc;

pub mod logic;

#[cfg(target_arch = "wasm32")]
mod guest {
    use super::logic::{self, AccessError, EvaluateInput, Record};
    use alloc::format;
    use alloc::string::{String, ToString};
    use alloc::vec::Vec;

    wit_bindgen::generate!({
        world: "doc-intake",
        path: "wit",
        generate_all,
    });

    use exports::z::doc_intake::contracts::{GenericInput, Guest};
    use host::interfaces::{kv_store, logging};
    use host::tenant::tenant_context;

    fn map(tail: &str) -> String {
        format!("z:{}:{tail}", hex::encode(tenant_context::tenant_did()))
    }

    fn load(request_id: &str) -> Result<Option<Record>, String> {
        match kv_store::get(&map("intake"), &logic::record_key(request_id))? {
            None => Ok(None),
            Some(bytes) => serde_json::from_slice(&bytes).map(Some).map_err(|e| format!("corrupt record: {e}")),
        }
    }

    fn allowed_agents() -> Vec<String> {
        kv_store::get(&map("config"), b"agents")
            .ok()
            .flatten()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    fn input(req: &GenericInput) -> Result<&[u8], String> {
        req.input.as_deref().ok_or_else(|| "missing input".to_string())
    }

    fn request_id_of(bytes: &[u8]) -> Result<String, String> {
        #[derive(serde::Deserialize)]
        struct R {
            request_id: String,
        }
        let r: R = serde_json::from_slice(bytes).map_err(|e| format!("invalid input: {e}"))?;
        if !logic::valid_request_id(&r.request_id) {
            return Err(AccessError::NotFound.to_string());
        }
        Ok(r.request_id)
    }

    fn read_checked(request_id: &str) -> Result<Record, String> {
        let record = load(request_id)?;
        logic::check_read_access(
            record.as_ref(),
            tenant_context::calling_user_did().as_deref(),
            tenant_context::authenticated_did().as_deref(),
            &allowed_agents(),
        )
        .map_err(|e| e.to_string())?;
        Ok(record.expect("checked above"))
    }

    struct Component;

    impl Guest for Component {
        fn ingest(req: GenericInput) -> Result<Vec<u8>, String> {
            let submission = logic::parse_submission(input(&req)?).map_err(|e| e.to_string())?;
            let request_id = submission.request_id.clone().expect("validated");
            let existing = load(&request_id)?;
            let owner = logic::check_ingest_caller(
                tenant_context::calling_user_did().as_deref(),
                tenant_context::is_delegated(),
                existing.as_ref().map(|r| r.owner.as_str()),
            )
            .map_err(|e| e.to_string())?;
            let now = tenant_context::cluster_timestamp_secs();
            let server_checks = logic::server_checks(&submission, now);
            let record = Record { owner, received_at: now, submission, server_checks };
            let bytes = serde_json::to_vec(&record).map_err(|e| e.to_string())?;
            kv_store::put(&map("intake"), &logic::record_key(&request_id), &bytes)?;
            // Never log values — only that a request arrived.
            let _ = logging::info(&format!("ingest: request stored ({} documents)", record.submission.documents.len()));
            serde_json::to_vec(&logic::ingest_receipt(&request_id, &record)).map_err(|e| e.to_string())
        }

        fn status(req: GenericInput) -> Result<Vec<u8>, String> {
            let request_id = request_id_of(input(&req)?)?;
            let record = read_checked(&request_id)?;
            serde_json::to_vec(&logic::status_view(&request_id, Some(&record))).map_err(|e| e.to_string())
        }

        fn evaluate(req: GenericInput) -> Result<Vec<u8>, String> {
            let body: EvaluateInput = serde_json::from_slice(input(&req)?).map_err(|e| format!("invalid input: {e}"))?;
            let record = read_checked(&body.request_id)?;
            let out = logic::evaluate(&record, &body.rules, tenant_context::cluster_timestamp_secs());
            serde_json::to_vec(&out).map_err(|e| e.to_string())
        }
    }

    export!(Component);
}
