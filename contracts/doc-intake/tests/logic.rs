use serde_json::json;
use z_doc_intake::logic::*;

const DAY: u64 = 86_400;
/// 2026-10-21T00:00:00Z
const NOW: u64 = 20_747 * DAY;

fn submission() -> serde_json::Value {
    json!({
        "schema": "pde.submission/v1",
        "request_id": "req_0123456789",
        "documents": [
            { "doc_type": "passport", "fields": {
                "document_number": { "value": "SPECI2021", "source": "mrz", "validated": true, "validated_by": ["mrz.check_digits"], "user_edited": false },
                "date_of_birth":   { "value": "1990-03-10", "source": "mrz", "validated": true, "validated_by": ["mrz.check_digits"], "user_edited": false },
                "date_of_expiry":  { "value": "2031-08-02", "source": "mrz", "validated": true, "validated_by": ["mrz.check_digits"], "user_edited": false },
                "nationality":     { "value": "NLD", "source": "mrz", "validated": true, "validated_by": ["mrz.vocabulary"], "user_edited": false }
            }, "checks": [{ "id": "mrz.check_digits", "ok": true }] },
            { "doc_type": "payslip", "fields": {
                "gross_pay":        { "value": "5000.00", "source": "text_layer", "validated": true, "validated_by": ["payslip.gross_minus_deductions_equals_net"], "user_edited": false },
                "total_deductions": { "value": "1000.00", "source": "text_layer", "validated": true, "validated_by": [], "user_edited": false },
                "net_pay":          { "value": "4000.00", "source": "text_layer", "validated": true, "validated_by": [], "user_edited": false }
            } },
            { "doc_type": "bank_statement", "fields": {
                "iban":            { "value": "GB82WEST12345698765432", "source": "text_layer", "validated": true, "user_edited": false },
                "opening_balance": { "value": "1000.00", "source": "text_layer", "validated": false, "user_edited": false },
                "total_credits":   { "value": "2500.00", "source": "text_layer", "validated": false, "user_edited": false },
                "total_debits":    { "value": "200.00", "source": "text_layer", "validated": false, "user_edited": false },
                "closing_balance": { "value": "3300.00", "source": "user", "validated": false, "user_edited": true }
            } }
        ],
        "client": { "name": "private-doc-scanner", "version": "0.1.0", "engine": "web" },
        "created_at": "2026-10-21T00:00:00Z"
    })
}

fn record() -> Record {
    let s = parse_submission(&serde_json::to_vec(&submission()).unwrap()).unwrap();
    let checks = server_checks(&s, NOW);
    Record { owner: hex::encode([7u8; 20]), received_at: NOW, submission: s, server_checks: checks }
}

#[test]
fn civil_dates() {
    assert_eq!(today(NOW), (2026, 10, 21));
    assert_eq!(civil_from_days(0), (1970, 1, 1));
    assert_eq!(parse_iso_date("2024-02-29"), Some((2024, 2, 29)));
    assert_eq!(parse_iso_date("2025-02-29"), None);
    assert_eq!(age_years((1990, 3, 10), (2026, 3, 9)), 35);
    assert_eq!(age_years((1990, 3, 10), (2026, 3, 10)), 36);
}

#[test]
fn money_and_iban() {
    assert_eq!(parse_cents("4000.00"), Some(400_000));
    assert_eq!(parse_cents("-12.5"), Some(-1_250));
    assert_eq!(parse_cents("1,000.00"), None);
    assert!(iban_ok("GB82 WEST 1234 5698 7654 32"));
    assert!(!iban_ok("GB82WEST12345698765433"));
}

#[test]
fn validates_the_submission_shape() {
    let mut bad = submission();
    bad["schema"] = json!("other");
    assert_eq!(parse_submission(&serde_json::to_vec(&bad).unwrap()), Err(IngestError::WrongSchema));
    let mut bad = submission();
    bad["request_id"] = json!("short");
    assert_eq!(parse_submission(&serde_json::to_vec(&bad).unwrap()), Err(IngestError::BadRequestId));
    let mut bad = submission();
    bad["documents"][0]["doc_type"] = json!("selfie");
    assert!(matches!(parse_submission(&serde_json::to_vec(&bad).unwrap()), Err(IngestError::UnknownDocType(_))));
}

#[test]
fn re_runs_deterministic_checks_in_the_enclave() {
    let r = record();
    let ok = |id: &str| r.server_checks.iter().find(|c| c.id == id).unwrap().ok;
    assert_eq!(ok("payslip.gross_minus_deductions_equals_net"), Some(true));
    assert_eq!(ok("iban.mod97"), Some(true));
    assert_eq!(ok("statement.opening_plus_in_minus_out_equals_closing"), Some(true));
    assert_eq!(ok("document.not_expired"), Some(true));
}

#[test]
fn only_the_data_subject_ingests_and_owns_a_request() {
    let me = [7u8; 20];
    let other = hex::encode([9u8; 20]);
    assert_eq!(check_ingest_caller(Some(&me), false, None), Ok(hex::encode(me)));
    assert_eq!(check_ingest_caller(Some(&me), true, None), Err(IngestError::NotTheDataSubject));
    assert_eq!(check_ingest_caller(None, false, None), Err(IngestError::NotTheDataSubject));
    assert_eq!(check_ingest_caller(Some(&me), false, Some(&other)), Err(IngestError::RequestOwnedByAnotherUser));
}

#[test]
fn read_access_is_owner_delegate_or_listed_agent() {
    let r = record();
    let owner = [7u8; 20];
    let agent = [3u8; 20];
    let stranger = [5u8; 20];
    // The owner, or an agent acting under the owner's grant (calling user = owner).
    assert_eq!(check_read_access(Some(&r), Some(&owner), Some(&agent), &[]), Ok(()));
    // A tenant-listed agent.
    assert_eq!(check_read_access(Some(&r), Some(&agent), Some(&agent), &[hex::encode(agent)]), Ok(()));
    assert_eq!(check_read_access(Some(&r), Some(&stranger), Some(&stranger), &[]), Err(AccessError::Forbidden));
    assert_eq!(check_read_access(None, Some(&owner), Some(&owner), &[]), Err(AccessError::NotFound));
    assert_eq!(AccessError::NotFound.to_string(), AccessError::Forbidden.to_string());
}

#[test]
fn status_never_contains_values() {
    let r = record();
    let v = status_view("req_0123456789", Some(&r));
    let text = v.to_string();
    for secret in ["SPECI2021", "1990-03-10", "4000.00", "GB82WEST", "3300.00", "NLD"] {
        assert!(!text.contains(secret), "status leaked {secret}");
    }
    assert_eq!(v["received"], json!(true));
    assert_eq!(v["documents"][2]["fields_edited_by_user"], json!(["closing_balance"]));
}

#[test]
fn evaluate_answers_yes_no_without_values() {
    let r = record();
    let rules: Rules = serde_json::from_value(json!({
        "min_net_pay": "3500.00", "min_age": 18, "document_not_expired": true, "nationality_in": ["NLD", "DEU"],
        "min_closing_balance": "3000.00"
    }))
    .unwrap();
    let v = evaluate(&r, &rules, NOW);
    assert_eq!(v["all_pass"], json!(true));
    assert_eq!(v["results"]["min_net_pay"], json!({ "pass": true, "basis": "verified" }));
    assert_eq!(v["results"]["min_closing_balance"]["basis"], json!("self_attested"));
    assert!(!v.to_string().contains("4000"));

    // Self-attested inputs fail when the requester demands verified data.
    let strict: Rules = serde_json::from_value(json!({ "min_closing_balance": "3000.00", "require_verified": true })).unwrap();
    assert_eq!(evaluate(&r, &strict, NOW)["all_pass"], json!(false));

    let high: Rules = serde_json::from_value(json!({ "min_net_pay": "4500.00" })).unwrap();
    assert_eq!(evaluate(&r, &high, NOW)["results"]["min_net_pay"]["pass"], json!(false));
}
