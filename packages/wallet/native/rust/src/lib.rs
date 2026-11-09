//! Warpstack's native vault core (sealed). The Swift layer calls these functions through
//! uniffi; JavaScript never does. Inputs are typed fields and byte buffers, outputs are
//! signatures: no function takes a hash to sign or returns key material other than the app
//! key's public key.

mod app_key;
mod custody;
mod gasless;
mod message;
mod phrase;

use std::sync::Arc;

use zeroize::Zeroizing;

pub use phrase::{PhraseBuffer, Typed, WordStatus};

uniffi::setup_scaffolding!();

#[derive(Debug, uniffi::Error)]
pub enum VaultError {
    /// The request broke the policy; `reason` is for the person.
    Refused {
        reason: String,
    },
    InvalidPhrase,
    NoMatchingAccount,
}

impl std::fmt::Display for VaultError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            VaultError::Refused { reason } => f.write_str(reason),
            VaultError::InvalidPhrase => f.write_str("That isn't a valid recovery phrase."),
            VaultError::NoMatchingAccount => {
                f.write_str("This phrase doesn't hold the account's custody address.")
            }
        }
    }
}

impl std::error::Error for VaultError {}

fn array<const N: usize>(v: &[u8]) -> Result<[u8; N], VaultError> {
    v.try_into().map_err(|_| VaultError::Refused {
        reason: format!("expected {N} bytes"),
    })
}

fn address(v: &[u8]) -> Result<alloy_primitives::Address, VaultError> {
    Ok(alloy_primitives::Address::new(array::<20>(v)?))
}

/// The seed, copied into a buffer that is wiped on drop. The caller's copy is the platform's.
fn seed(v: &[u8]) -> Result<Zeroizing<[u8; 32]>, VaultError> {
    Ok(Zeroizing::new(array::<32>(v)?))
}

#[derive(uniffi::Record)]
pub struct KeyAddApproval {
    pub custody_signature: Vec<u8>,
    pub metadata: Vec<u8>,
    pub scopes: Vec<u32>,
    pub ttl: u32,
    pub account_index: u32,
}

#[derive(uniffi::Record)]
pub struct KeyRemoveApproval {
    pub signature: Vec<u8>,
    pub account_index: u32,
}

#[derive(uniffi::Record)]
pub struct SignedMessage {
    pub hash: Vec<u8>,
    pub signature: Vec<u8>,
}

#[derive(uniffi::Enum)]
pub enum SignPurpose {
    Posting { fid: u64 },
    OwnKeyAdd { fid: u64 },
    SelfRemove { fid: u64 },
    CustodyRemove { fid: u64 },
}

/// Signs the gasless `SignedKeyRequest` and `KeyAdd` for the app key `app_key` (its public
/// key; the vault never sees the app key's seed). The Swift layer passes the public key it
/// stored with the pending sign-in, so the vault adds only this phone's own key. `now` is
/// Farcaster time from the native clock. The phrase is read from the sheet's buffer, so it
/// never crosses back to the platform.
#[uniffi::export]
pub fn approve_key_add(
    phrase: Arc<PhraseBuffer>,
    app_key: Vec<u8>,
    fid: u64,
    custody: Vec<u8>,
    nonce: u32,
    deadline: u32,
    now: u32,
) -> Result<KeyAddApproval, VaultError> {
    let phrase = phrase.phrase();
    let a = custody::approve_key_add(
        &phrase,
        fid,
        &array(&app_key)?,
        address(&custody)?,
        nonce,
        deadline,
        now,
    )?;
    Ok(KeyAddApproval {
        custody_signature: a.custody_signature.to_vec(),
        metadata: a.metadata,
        scopes: message::POSTING_TYPES.to_vec(),
        ttl: custody::APP_KEY_TTL,
        account_index: a.index,
    })
}

/// Signs the gasless `KeyRemove` of `key` from `fid`.
#[uniffi::export]
pub fn approve_key_remove(
    phrase: Arc<PhraseBuffer>,
    fid: u64,
    key: Vec<u8>,
    custody: Vec<u8>,
    nonce: u32,
    deadline: u32,
    now: u32,
) -> Result<KeyRemoveApproval, VaultError> {
    let phrase = phrase.phrase();
    let (signature, index) = custody::approve_key_remove(
        &phrase,
        fid,
        &array(&key)?,
        address(&custody)?,
        nonce,
        deadline,
        now,
    )?;
    Ok(KeyRemoveApproval {
        signature: signature.to_vec(),
        account_index: index,
    })
}

#[uniffi::export]
pub fn app_key_public_key(seed_bytes: Vec<u8>) -> Result<Vec<u8>, VaultError> {
    let seed_bytes = Zeroizing::new(seed_bytes);
    Ok(app_key::public_key(&*seed(&seed_bytes)?).to_vec())
}

/// Signs a session challenge: Rust builds the preimage from `origin` and the 32-byte `nonce`
/// (`"warpstack-session-v1" ‖ u16be(len) ‖ origin ‖ nonce`), so the caller never chooses the
/// bytes signed. Returns the 64-byte Ed25519 signature.
#[uniffi::export]
pub fn app_key_sign_session(
    seed_bytes: Vec<u8>,
    origin: String,
    nonce: Vec<u8>,
) -> Result<Vec<u8>, VaultError> {
    let seed_bytes = Zeroizing::new(seed_bytes);
    Ok(app_key::sign_session(&*seed(&seed_bytes)?, &origin, &nonce)?.to_vec())
}

/// Signs `data` (`MessageData` bytes) with the app key after checking it against `purpose`.
#[uniffi::export]
pub fn app_key_sign(
    seed_bytes: Vec<u8>,
    purpose: SignPurpose,
    data: Vec<u8>,
) -> Result<SignedMessage, VaultError> {
    let seed_bytes = Zeroizing::new(seed_bytes);
    let purpose = match purpose {
        SignPurpose::Posting { fid } => app_key::Purpose::Posting { fid },
        SignPurpose::OwnKeyAdd { fid } => app_key::Purpose::OwnKeyAdd { fid },
        SignPurpose::SelfRemove { fid } => app_key::Purpose::SelfRemove { fid },
        SignPurpose::CustodyRemove { fid } => app_key::Purpose::CustodyRemove { fid },
    };
    let (hash, signature) = app_key::sign(&*seed(&seed_bytes)?, purpose, &data)?;
    Ok(SignedMessage {
        hash: hash.to_vec(),
        signature: signature.to_vec(),
    })
}
