//! The shared reference vectors (`wallet/vectors/native.json`), which
//! `wallet/src/native/vectors.test.ts` rebuilds from viem, @farcaster/core and noble: the
//! native core must sign exactly the same bytes.

use serde_json::Value;
use std::sync::Arc;

use warpstack_vault::{
    app_key_public_key, app_key_sign, app_key_sign_session, approve_key_add, approve_key_remove,
    PhraseBuffer, SignPurpose,
};

fn hex(s: &Value) -> Vec<u8> {
    let s = s.as_str().unwrap().trim_start_matches("0x");
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

fn vectors() -> Value {
    serde_json::from_str(include_str!("../../../vectors/native.json")).unwrap()
}

#[test]
fn custody_signatures_match_typescript() {
    let v = vectors();
    // The phrase reaches the core as the sheet gives it: pasted into its buffer.
    let phrase = Arc::new(PhraseBuffer::new(24));
    phrase.paste(0, v["phrase"].as_str().unwrap().as_bytes().to_vec());
    assert!(phrase.is_valid());
    let now = v["now"].as_u64().unwrap() as u32;
    let a = &v["keyAdd"];
    let got = approve_key_add(
        phrase.clone(),
        hex(&v["appKey"]),
        a["fid"].as_u64().unwrap(),
        hex(&a["custody"]),
        a["nonce"].as_u64().unwrap() as u32,
        a["deadline"].as_u64().unwrap() as u32,
        now,
    )
    .unwrap();
    assert_eq!(got.custody_signature, hex(&a["custodySignature"]));
    assert_eq!(got.metadata, hex(&a["metadata"]));
    assert_eq!(
        u64::from(got.account_index),
        a["accountIndex"].as_u64().unwrap()
    );

    let r = &v["keyRemove"];
    let got = approve_key_remove(
        phrase,
        r["fid"].as_u64().unwrap(),
        hex(&r["key"]),
        hex(&r["custody"]),
        r["nonce"].as_u64().unwrap() as u32,
        r["deadline"].as_u64().unwrap() as u32,
        now,
    )
    .unwrap();
    assert_eq!(got.signature, hex(&r["signature"]));
}

#[test]
fn app_key_signatures_match_typescript() {
    let v = vectors();
    let seed = hex(&v["appKeySeed"]);
    assert_eq!(app_key_public_key(seed.clone()).unwrap(), hex(&v["appKey"]));
    for m in v["messages"].as_array().unwrap() {
        let fid = m["fid"].as_u64().unwrap();
        let purpose = match m["purpose"].as_str().unwrap() {
            "posting" => SignPurpose::Posting { fid },
            "ownKeyAdd" => SignPurpose::OwnKeyAdd { fid },
            "selfRemove" => SignPurpose::SelfRemove { fid },
            "custodyRemove" => SignPurpose::CustodyRemove { fid },
            p => panic!("unknown purpose {p}"),
        };
        let got = app_key_sign(seed.clone(), purpose, hex(&m["data"])).unwrap();
        assert_eq!(got.hash, hex(&m["hash"]));
        assert_eq!(got.signature, hex(&m["signature"]));
        // The same bytes under any other purpose are refused.
        let wrong = match m["purpose"].as_str().unwrap() {
            "posting" => SignPurpose::SelfRemove { fid },
            _ => SignPurpose::Posting { fid },
        };
        assert!(app_key_sign(seed.clone(), wrong, hex(&m["data"])).is_err());
    }
}

#[test]
fn session_signatures_match_typescript() {
    let v = vectors();
    let seed = hex(&v["appKeySeed"]);
    let sessions = v["sessions"].as_array().unwrap();
    assert!(!sessions.is_empty());
    for s in sessions {
        let origin = s["origin"].as_str().unwrap().to_owned();
        let got = app_key_sign_session(seed.clone(), origin, hex(&s["nonce"])).unwrap();
        assert_eq!(got, hex(&s["signature"]));
    }
    for s in v["sessionRefusals"].as_array().unwrap() {
        let origin = s["origin"].as_str().unwrap().to_owned();
        assert!(
            app_key_sign_session(seed.clone(), origin.clone(), hex(&s["nonce"])).is_err(),
            "{origin}"
        );
    }
}
