//! The phone's app key: an Ed25519 key whose 32-byte seed the platform
//! layer keeps in the Keychain. Every signature names its purpose, and the `MessageData` bytes
//! are decoded and checked against that purpose before the exact bytes received are hashed and
//! signed. There is no way to sign a bare hash.

use ed25519_dalek::{Signer, SigningKey};

use crate::message::{decode, key_body, KEY_ADD, KEY_REMOVE, POSTING_TYPES};
use crate::VaultError;

pub enum Purpose {
    /// A cast, reaction, follow or profile edit by the key's own FID.
    Posting { fid: u64 },
    /// This key's own `KEY_ADD` for the FID it is being added to, which proves possession.
    /// The platform layer allows it only while the key is unregistered, for its pending sign-in.
    OwnKeyAdd { fid: u64 },
    /// This key revoking itself.
    SelfRemove { fid: u64 },
    /// The envelope of a custody-signed removal of another of the FID's keys.
    CustodyRemove { fid: u64 },
}

fn refused(reason: &str) -> VaultError {
    VaultError::Refused {
        reason: reason.to_owned(),
    }
}

pub fn public_key(seed: &[u8; 32]) -> [u8; 32] {
    SigningKey::from_bytes(seed).verifying_key().to_bytes()
}

/// The BLAKE3 message hash Snapchain verifies, and the key's signature over it.
pub fn sign(
    seed: &[u8; 32],
    purpose: Purpose,
    data: &[u8],
) -> Result<([u8; 20], [u8; 64]), VaultError> {
    let key = SigningKey::from_bytes(seed);
    let own = key.verifying_key().to_bytes();
    let m = decode(data).map_err(refused)?;
    let allowed = match purpose {
        Purpose::Posting { fid } => {
            m.fid == fid
                && POSTING_TYPES
                    .iter()
                    .any(|t| u64::from(*t) == m.message_type)
        }
        Purpose::OwnKeyAdd { fid } => {
            m.fid == fid && m.message_type == KEY_ADD && key_body(m.body).map_err(refused)?.0 == own
        }
        Purpose::SelfRemove { fid } => {
            m.fid == fid
                && m.message_type == KEY_REMOVE
                && key_body(m.body).map_err(refused)? == (&own[..], Some(2))
        }
        Purpose::CustodyRemove { fid } => {
            let (k, sig_type) = if m.message_type == KEY_REMOVE {
                key_body(m.body).map_err(refused)?
            } else {
                (&own[..], None)
            };
            m.fid == fid && k != own && k.len() == 32 && sig_type == Some(1)
        }
    };
    if !allowed {
        return Err(refused("The app key doesn't sign this message."));
    }
    let mut hash = [0u8; 20];
    hash.copy_from_slice(&blake3::hash(data).as_bytes()[..20]);
    Ok((hash, key.sign(&hash).to_bytes()))
}

/// The session challenge's fixed prefix (`protocol/src/session.ts`).
pub const SESSION_PREFIX: &[u8] = b"warpstack-session-v1";
pub const SESSION_NONCE_BYTES: usize = 32;
pub const MAX_ORIGIN_BYTES: usize = 255;

fn valid_label(l: &[u8]) -> bool {
    !l.is_empty()
        && l.len() <= 63
        && l.iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
        && l[0] != b'-'
        && l[l.len() - 1] != b'-'
}

fn valid_port(p: &[u8]) -> bool {
    !p.is_empty()
        && p.len() <= 5
        && p[0] != b'0'
        && p.iter().all(u8::is_ascii_digit)
        && std::str::from_utf8(p)
            .ok()
            .and_then(|s| s.parse::<u32>().ok())
            .is_some_and(|n| n <= 65_535)
}

/// The same origin rules as `parseSessionOrigin`: `https://host[:port]`, or `http://localhost`
/// or `http://127.0.0.1` with an optional port, lowercase, no path, at most 255 bytes. The store
/// can't know which deployment it talks to, so the deployment checks the origin is its own.
pub fn valid_origin(origin: &str) -> bool {
    let o = origin.as_bytes();
    if o.len() > MAX_ORIGIN_BYTES {
        return false;
    }
    let (rest, local_only) = if let Some(r) = o.strip_prefix(b"https://") {
        (r, false)
    } else if let Some(r) = o.strip_prefix(b"http://") {
        (r, true)
    } else {
        return false;
    };
    let (host, port) = match rest.iter().position(|c| *c == b':') {
        Some(i) => (&rest[..i], Some(&rest[i + 1..])),
        None => (rest, None),
    };
    if port.is_some_and(|p| !valid_port(p)) {
        return false;
    }
    if local_only {
        return host == b"localhost" || host == b"127.0.0.1";
    }
    host.split(|c| *c == b'.').all(valid_label)
}

/// `"warpstack-session-v1" ‖ u16be(len(origin)) ‖ origin ‖ nonce`, built here from the two
/// fields so no caller can choose the bytes the key signs. It is never 20 bytes long.
pub fn session_preimage(origin: &str, nonce: &[u8]) -> Result<Vec<u8>, VaultError> {
    if !valid_origin(origin) {
        return Err(refused(
            "The app key doesn't sign a session for that origin.",
        ));
    }
    if nonce.len() != SESSION_NONCE_BYTES {
        return Err(refused("A session nonce is 32 bytes."));
    }
    let len = origin.len() as u16;
    let mut out = Vec::with_capacity(SESSION_PREFIX.len() + 2 + origin.len() + nonce.len());
    out.extend_from_slice(SESSION_PREFIX);
    out.extend_from_slice(&len.to_be_bytes());
    out.extend_from_slice(origin.as_bytes());
    out.extend_from_slice(nonce);
    Ok(out)
}

/// The key's signature over a session challenge for `origin`.
pub fn sign_session(seed: &[u8; 32], origin: &str, nonce: &[u8]) -> Result<[u8; 64], VaultError> {
    let preimage = session_preimage(origin, nonce)?;
    Ok(SigningKey::from_bytes(seed).sign(&preimage).to_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SEED: [u8; 32] = [7; 32];

    #[test]
    fn session_preimage_matches_protocol() {
        let nonce: Vec<u8> = (0..32).collect();
        let p = session_preimage("https://test-warpstack.ngrok.io", &nonce).unwrap();
        let hex: String = p.iter().map(|x| format!("{x:02x}")).collect();
        assert_eq!(hex, "77617270737461636b2d73657373696f6e2d7631001f68747470733a2f2f746573742d77617270737461636b2e6e67726f6b2e696f000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
        let sig = sign_session(&SEED, "https://test-warpstack.ngrok.io", &nonce).unwrap();
        let vk = SigningKey::from_bytes(&SEED).verifying_key();
        assert!(vk
            .verify_strict(&p, &ed25519_dalek::Signature::from_bytes(&sig))
            .is_ok());
        assert!(sign_session(&SEED, "https://test-warpstack.ngrok.io", &nonce[..31]).is_err());
    }

    #[test]
    fn session_origins_match_protocol() {
        for o in [
            "https://warpstack.xyz",
            "https://a.b-c.example:8443",
            "http://localhost",
            "http://localhost:8787",
            "http://127.0.0.1:8787",
        ] {
            assert!(valid_origin(o), "{o}");
        }
        let long = format!("https://{}.xyz", "a".repeat(250));
        for o in [
            "http://warpstack.xyz",
            "https://warpstack.xyz/",
            "https://Warpstack.xyz",
            "https://warpstack.xyz/path",
            "https://user@warpstack.xyz",
            "https://-a.example",
            "https://a..example",
            "https://warpstack.xyz:0",
            "https://warpstack.xyz:65536",
            "http://192.168.1.2:8787",
            "http://localhost.evil.com",
            " https://test-warpstack.ngrok.io",
            long.as_str(),
            "",
            "https://",
            "https://a.example:",
        ] {
            assert!(!valid_origin(o), "{o}");
        }
    }

    fn data(message_type: u8, fid: u8, body_field: u8, body: &[u8]) -> Vec<u8> {
        let tag = u16::from(body_field) << 3 | 2;
        let mut v = vec![0x08, message_type, 0x10, fid, 0x18, 0x01, 0x20, 0x01];
        if tag < 0x80 {
            v.push(tag as u8);
        } else {
            v.extend_from_slice(&[(tag as u8) | 0x80, (tag >> 7) as u8]);
        }
        v.push(body.len() as u8);
        v.extend_from_slice(body);
        v
    }

    fn key_remove(key: &[u8; 32], sig_type: u8) -> Vec<u8> {
        let mut b = vec![0x0a, 32];
        b.extend_from_slice(key);
        b.extend_from_slice(&[0x18, sig_type]);
        data(17, 9, 20, &b)
    }

    #[test]
    fn signs_posting_for_its_own_fid_only() {
        let cast = data(1, 9, 5, &[0x22, 0x02, b'h', b'i']);
        assert!(sign(&SEED, Purpose::Posting { fid: 9 }, &cast).is_ok());
        assert!(sign(&SEED, Purpose::Posting { fid: 8 }, &cast).is_err());
        assert!(sign(
            &SEED,
            Purpose::Posting { fid: 9 },
            &key_remove(&public_key(&SEED), 2)
        )
        .is_err());
    }

    #[test]
    fn signs_a_matching_hash() {
        let cast = data(1, 9, 5, &[0x22, 0x02, b'h', b'i']);
        let (hash, sig) = sign(&SEED, Purpose::Posting { fid: 9 }, &cast).unwrap();
        assert_eq!(&hash[..], &blake3::hash(&cast).as_bytes()[..20]);
        let vk = SigningKey::from_bytes(&SEED).verifying_key();
        assert!(vk
            .verify_strict(&hash, &ed25519_dalek::Signature::from_bytes(&sig))
            .is_ok());
    }

    #[test]
    fn key_operations_name_the_right_key() {
        let own = public_key(&SEED);
        let other = [3u8; 32];
        assert!(sign(&SEED, Purpose::SelfRemove { fid: 9 }, &key_remove(&own, 2)).is_ok());
        assert!(sign(
            &SEED,
            Purpose::SelfRemove { fid: 9 },
            &key_remove(&other, 2)
        )
        .is_err());
        assert!(sign(&SEED, Purpose::SelfRemove { fid: 9 }, &key_remove(&own, 1)).is_err());
        assert!(sign(
            &SEED,
            Purpose::CustodyRemove { fid: 9 },
            &key_remove(&other, 1)
        )
        .is_ok());
        assert!(sign(
            &SEED,
            Purpose::CustodyRemove { fid: 9 },
            &key_remove(&own, 1)
        )
        .is_err());
        assert!(sign(
            &SEED,
            Purpose::CustodyRemove { fid: 9 },
            &key_remove(&other, 2)
        )
        .is_err());
        let mut add = vec![0x0a, 32];
        add.extend_from_slice(&own);
        assert!(sign(&SEED, Purpose::OwnKeyAdd { fid: 9 }, &data(16, 9, 19, &add)).is_ok());
        // Only for the FID the sign-in is for.
        assert!(sign(
            &SEED,
            Purpose::OwnKeyAdd { fid: 10 },
            &data(16, 9, 19, &add)
        )
        .is_err());
        add[2..].copy_from_slice(&other);
        assert!(sign(&SEED, Purpose::OwnKeyAdd { fid: 9 }, &data(16, 9, 19, &add)).is_err());
    }
}
