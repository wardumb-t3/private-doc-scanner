//! Pure contract logic — no host calls, so it is unit-tested natively.
//!
//! Values arrive already reviewed by the user on their device. This module
//! (1) validates the `pde.submission/v1` shape, (2) re-runs the deterministic
//! checks that do not need the original document (IBAN mod-97, payslip and
//! statement arithmetic, date sanity, expiry against cluster time), and
//! (3) answers yes/no questions over the stored values so callers learn a
//! decision, never the data.

use alloc::collections::BTreeMap;
use alloc::format;
use alloc::string::{String, ToString};
use alloc::vec::Vec;
use core::fmt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const SCHEMA: &str = "pde.submission/v1";
const MAX_DOCUMENTS: usize = 10;
const MAX_FIELDS: usize = 64;
const MAX_VALUE_LEN: usize = 512;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SubmittedField {
    pub value: String,
    pub source: String,
    pub validated: bool,
    #[serde(default)]
    pub validated_by: Vec<String>,
    #[serde(default)]
    pub user_edited: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SubmittedCheck {
    pub id: String,
    pub ok: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SubmittedDocument {
    pub doc_type: String,
    pub fields: BTreeMap<String, SubmittedField>,
    #[serde(default)]
    pub checks: Vec<SubmittedCheck>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Submission {
    pub schema: String,
    pub request_id: Option<String>,
    pub documents: Vec<SubmittedDocument>,
    #[serde(default)]
    pub client: Value,
    #[serde(default)]
    pub created_at: String,
}

/// A check re-run inside the enclave. `ok: None` = not applicable (inputs absent).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ServerCheck {
    pub doc: usize,
    pub id: String,
    pub ok: Option<bool>,
}

/// What is stored under `req:<request_id>` in the `intake` map.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Record {
    /// Hex of the data subject's DID bytes.
    pub owner: String,
    pub received_at: u64,
    pub submission: Submission,
    pub server_checks: Vec<ServerCheck>,
}

#[derive(Debug, PartialEq)]
pub enum IngestError {
    BadJson(String),
    WrongSchema,
    MissingRequestId,
    BadRequestId,
    NoDocuments,
    TooManyDocuments,
    UnknownDocType(String),
    TooManyFields,
    ValueTooLong(String),
    NotTheDataSubject,
    RequestOwnedByAnotherUser,
}

impl fmt::Display for IngestError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::BadJson(e) => write!(f, "invalid submission JSON: {e}"),
            Self::WrongSchema => write!(f, "schema must be {SCHEMA}"),
            Self::MissingRequestId => write!(f, "request_id is required"),
            Self::BadRequestId => write!(f, "request_id must be 8-128 chars of [A-Za-z0-9_-]"),
            Self::NoDocuments => write!(f, "submission has no documents"),
            Self::TooManyDocuments => write!(f, "at most {MAX_DOCUMENTS} documents per submission"),
            Self::UnknownDocType(t) => write!(f, "unknown doc_type: {t}"),
            Self::TooManyFields => write!(f, "at most {MAX_FIELDS} fields per document"),
            Self::ValueTooLong(k) => write!(f, "field {k} exceeds {MAX_VALUE_LEN} chars"),
            Self::NotTheDataSubject => write!(f, "ingest must be called by the user themselves, not a delegate"),
            Self::RequestOwnedByAnotherUser => write!(f, "this request_id belongs to another user"),
        }
    }
}

#[derive(Debug, PartialEq)]
pub enum AccessError {
    NotFound,
    Forbidden,
}

impl fmt::Display for AccessError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            // Same message for both so callers cannot probe for request ids.
            Self::NotFound | Self::Forbidden => write!(f, "request not found or not permitted"),
        }
    }
}

pub fn valid_request_id(id: &str) -> bool {
    (8..=128).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

pub fn parse_submission(bytes: &[u8]) -> Result<Submission, IngestError> {
    let s: Submission = serde_json::from_slice(bytes).map_err(|e| IngestError::BadJson(e.to_string()))?;
    if s.schema != SCHEMA {
        return Err(IngestError::WrongSchema);
    }
    let id = s.request_id.as_deref().ok_or(IngestError::MissingRequestId)?;
    if !valid_request_id(id) {
        return Err(IngestError::BadRequestId);
    }
    if s.documents.is_empty() {
        return Err(IngestError::NoDocuments);
    }
    if s.documents.len() > MAX_DOCUMENTS {
        return Err(IngestError::TooManyDocuments);
    }
    for d in &s.documents {
        if !matches!(d.doc_type.as_str(), "passport" | "id_card" | "payslip" | "bank_statement" | "generic") {
            return Err(IngestError::UnknownDocType(d.doc_type.clone()));
        }
        if d.fields.len() > MAX_FIELDS {
            return Err(IngestError::TooManyFields);
        }
        for (k, f) in &d.fields {
            if f.value.len() > MAX_VALUE_LEN || k.len() > 64 {
                return Err(IngestError::ValueTooLong(k.clone()));
            }
        }
    }
    Ok(s)
}

/// Ingest rules: only the data subject, acting for themselves, may store a
/// submission; an existing request id may only be overwritten by its owner.
pub fn check_ingest_caller(
    calling_user: Option<&[u8]>,
    is_delegated: bool,
    existing_owner: Option<&str>,
) -> Result<String, IngestError> {
    let user = calling_user.ok_or(IngestError::NotTheDataSubject)?;
    if is_delegated {
        return Err(IngestError::NotTheDataSubject);
    }
    let owner = hex::encode(user);
    match existing_owner {
        Some(o) if o != owner => Err(IngestError::RequestOwnedByAnotherUser),
        _ => Ok(owner),
    }
}

/// Read access to a record (status / evaluate): the data subject, an agent
/// acting under the subject's delegation grant (calling user = subject), or
/// an agent DID the tenant listed in `config/agents`.
pub fn check_read_access(
    record: Option<&Record>,
    calling_user: Option<&[u8]>,
    authenticated: Option<&[u8]>,
    allowed_agents: &[String],
) -> Result<(), AccessError> {
    let record = record.ok_or(AccessError::NotFound)?;
    if calling_user.map(hex::encode).as_deref() == Some(record.owner.as_str()) {
        return Ok(());
    }
    if let Some(a) = authenticated {
        if allowed_agents.iter().any(|x| x.eq_ignore_ascii_case(&hex::encode(a))) {
            return Ok(());
        }
    }
    Err(AccessError::Forbidden)
}

// ── deterministic checks ──────────────────────────────────────────────

/// "4000.00" / "-12.5" → cents. Submissions carry normalised decimals.
pub fn parse_cents(s: &str) -> Option<i64> {
    let s = s.trim();
    let (neg, digits) = match s.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, s),
    };
    let (int, frac) = match digits.split_once('.') {
        Some((i, f)) => (i, f),
        None => (digits, ""),
    };
    if int.is_empty() || frac.len() > 2 || !int.bytes().all(|b| b.is_ascii_digit()) || !frac.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let mut cents: i64 = int.parse::<i64>().ok()?.checked_mul(100)?;
    if !frac.is_empty() {
        let f: i64 = frac.parse().ok()?;
        cents = cents.checked_add(if frac.len() == 1 { f * 10 } else { f })?;
    }
    Some(if neg { -cents } else { cents })
}

pub fn iban_ok(iban: &str) -> bool {
    let clean: String = iban.chars().filter(|c| !c.is_whitespace()).collect::<String>().to_ascii_uppercase();
    if clean.len() < 15 || clean.len() > 34 || !clean.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return false;
    }
    let (head, tail) = clean.split_at(4);
    let mut rem: u32 = 0;
    for ch in tail.chars().chain(head.chars()) {
        let v = if ch.is_ascii_digit() { ch as u32 - '0' as u32 } else { ch as u32 - 'A' as u32 + 10 };
        if v >= 10 {
            rem = (rem * 100 + v) % 97;
        } else {
            rem = (rem * 10 + v) % 97;
        }
    }
    rem == 1
}

/// ISO `YYYY-MM-DD` → (y, m, d) if it is a real calendar date.
pub fn parse_iso_date(s: &str) -> Option<(i64, u32, u32)> {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let y: i64 = s[0..4].parse().ok()?;
    let m: u32 = s[5..7].parse().ok()?;
    let d: u32 = s[8..10].parse().ok()?;
    if !(1..=12).contains(&m) || d == 0 || d > days_in_month(y, m) {
        return None;
    }
    Some((y, m, d))
}

fn days_in_month(y: i64, m: u32) -> u32 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 => 29,
        _ => 28,
    }
}

/// Civil date from days since 1970-01-01 (H. Hinnant's algorithm).
pub fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    (y, m, d)
}

pub fn today(now_secs: u64) -> (i64, u32, u32) {
    civil_from_days((now_secs / 86_400) as i64)
}

pub fn age_years(birth: (i64, u32, u32), on: (i64, u32, u32)) -> i64 {
    let mut age = on.0 - birth.0;
    if (on.1, on.2) < (birth.1, birth.2) {
        age -= 1;
    }
    age
}

fn field<'a>(d: &'a SubmittedDocument, k: &str) -> Option<&'a str> {
    d.fields.get(k).map(|f| f.value.as_str())
}

pub fn server_checks(s: &Submission, now_secs: u64) -> Vec<ServerCheck> {
    let mut out = Vec::new();
    let now = today(now_secs);
    for (i, d) in s.documents.iter().enumerate() {
        let mut push = |id: &str, ok: Option<bool>| out.push(ServerCheck { doc: i, id: id.to_string(), ok });
        match d.doc_type.as_str() {
            "passport" | "id_card" => {
                let dob = field(d, "date_of_birth").map(parse_iso_date);
                push("dates.date_of_birth_valid", dob.map(|x| x.is_some()));
                let exp = field(d, "date_of_expiry").map(parse_iso_date);
                push("dates.date_of_expiry_valid", exp.map(|x| x.is_some()));
                push("document.not_expired", exp.flatten().map(|e| e >= now));
                push("document.birth_before_today", dob.flatten().map(|b| b < now));
            }
            "payslip" => {
                let g = field(d, "gross_pay").and_then(parse_cents);
                let t = field(d, "total_deductions").and_then(parse_cents);
                let n = field(d, "net_pay").and_then(parse_cents);
                push("payslip.gross_minus_deductions_equals_net", match (g, t, n) {
                    (Some(g), Some(t), Some(n)) => Some((g - t - n).abs() <= 1),
                    _ => None,
                });
            }
            "bank_statement" => {
                if let Some(iban) = field(d, "iban") {
                    push("iban.mod97", Some(iban_ok(iban)));
                }
                let o = field(d, "opening_balance").and_then(parse_cents);
                let c = field(d, "closing_balance").and_then(parse_cents);
                let cr = field(d, "total_credits").and_then(parse_cents);
                let db = field(d, "total_debits").and_then(parse_cents);
                push("statement.opening_plus_in_minus_out_equals_closing", match (o, c, cr, db) {
                    (Some(o), Some(c), Some(cr), Some(db)) => Some((o + cr - db - c).abs() <= 1),
                    _ => None,
                });
            }
            _ => {}
        }
    }
    out
}

// ── read views ────────────────────────────────────────────────────────

/// Status for the requester: which documents and fields arrived and how
/// they were checked. Never any value.
pub fn status_view(request_id: &str, r: Option<&Record>) -> Value {
    let Some(r) = r else {
        return json!({ "request_id": request_id, "received": false });
    };
    let docs: Vec<Value> = r
        .submission
        .documents
        .iter()
        .enumerate()
        .map(|(i, d)| {
            let present: Vec<&str> = d.fields.keys().map(|k| k.as_str()).collect();
            let verified: Vec<&str> = d.fields.iter().filter(|(_, f)| f.validated && !f.user_edited).map(|(k, _)| k.as_str()).collect();
            let edited: Vec<&str> = d.fields.iter().filter(|(_, f)| f.user_edited).map(|(k, _)| k.as_str()).collect();
            let checks: Vec<Value> = r
                .server_checks
                .iter()
                .filter(|c| c.doc == i)
                .map(|c| json!({ "id": c.id, "ok": c.ok }))
                .collect();
            json!({
                "doc_type": d.doc_type,
                "fields_present": present,
                "fields_verified_on_device": verified,
                "fields_edited_by_user": edited,
                "enclave_checks": checks,
            })
        })
        .collect();
    json!({ "request_id": request_id, "received": true, "received_at": r.received_at, "documents": docs })
}

#[derive(Debug, Default, Deserialize)]
pub struct Rules {
    pub min_net_pay: Option<String>,
    pub min_age: Option<u32>,
    pub document_not_expired: Option<bool>,
    pub nationality_in: Option<Vec<String>>,
    pub min_closing_balance: Option<String>,
    /// Treat self-attested (unverified or user-edited) values as failing.
    #[serde(default)]
    pub require_verified: bool,
}

#[derive(Debug, Deserialize)]
pub struct EvaluateInput {
    pub request_id: String,
    pub rules: Rules,
}

fn find<'a>(r: &'a Record, types: &[&str], key: &str) -> Option<&'a SubmittedField> {
    r.submission.documents.iter().filter(|d| types.contains(&d.doc_type.as_str())).find_map(|d| d.fields.get(key))
}

fn basis(f: Option<&SubmittedField>) -> &'static str {
    match f {
        None => "missing",
        Some(f) if f.validated && !f.user_edited => "verified",
        Some(_) => "self_attested",
    }
}

/// Yes/no answers over the stored values. The response carries only the
/// outcome and how trustworthy its inputs were — never the inputs.
pub fn evaluate(r: &Record, rules: &Rules, now_secs: u64) -> Value {
    let mut results = serde_json::Map::new();
    let mut all = true;
    let mut put = |name: &str, f: Option<&SubmittedField>, pass: Option<bool>| {
        let b = basis(f);
        let pass = match pass {
            Some(_) if rules.require_verified && b != "verified" => false,
            Some(p) => p,
            None => false,
        };
        all &= pass;
        results.insert(name.to_string(), json!({ "pass": pass, "basis": b }));
    };
    let now = today(now_secs);

    if let Some(min) = rules.min_net_pay.as_deref().and_then(parse_cents) {
        let f = find(r, &["payslip"], "net_pay");
        put("min_net_pay", f, f.and_then(|f| parse_cents(&f.value)).map(|v| v >= min));
    }
    if let Some(min_age) = rules.min_age {
        let f = find(r, &["passport", "id_card"], "date_of_birth");
        put("min_age", f, f.and_then(|f| parse_iso_date(&f.value)).map(|b| age_years(b, now) >= min_age as i64));
    }
    if rules.document_not_expired == Some(true) {
        let f = find(r, &["passport", "id_card"], "date_of_expiry");
        put("document_not_expired", f, f.and_then(|f| parse_iso_date(&f.value)).map(|e| e >= now));
    }
    if let Some(list) = &rules.nationality_in {
        let f = find(r, &["passport", "id_card"], "nationality");
        put("nationality_in", f, f.map(|f| list.iter().any(|n| n.eq_ignore_ascii_case(&f.value))));
    }
    if let Some(min) = rules.min_closing_balance.as_deref().and_then(parse_cents) {
        let f = find(r, &["bank_statement"], "closing_balance");
        put("min_closing_balance", f, f.and_then(|f| parse_cents(&f.value)).map(|v| v >= min));
    }
    json!({ "request_id": r.submission.request_id, "results": Value::Object(results), "all_pass": all })
}

pub fn ingest_receipt(request_id: &str, r: &Record) -> Value {
    let checks: Vec<Value> = r.server_checks.iter().map(|c| json!({ "doc": c.doc, "id": c.id, "ok": c.ok })).collect();
    json!({ "reference": request_id, "received_at": r.received_at, "enclave_checks": checks })
}

pub fn record_key(request_id: &str) -> Vec<u8> {
    format!("req:{request_id}").into_bytes()
}
