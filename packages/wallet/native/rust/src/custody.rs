//! The transient vault (M1.5 on the phone): from the recovery phrase it derives the accounts on
//! m/44'/60'/0'/0/{0..9}, finds the one that is the FID's custody address, signs one gasless key
//! operation that passed the policy here, and drops everything. It keeps nothing between calls.
//!
//! It can sign only this phone's own app key into existence, with fixed posting scopes and a
//! fixed TTL, or remove a key. The scopes and TTL are constants here, not inputs, so nothing
//! JavaScript passes can widen them.

use alloy_primitives::{Address, B256};
use alloy_signer::SignerSync;
use alloy_signer_local::{coins_bip39::English, MnemonicBuilder, PrivateKeySigner};
use zeroize::Zeroizing;

use crate::gasless::{
    key_add_digest, key_remove_digest, signed_key_request_digest, signed_key_request_metadata,
};
use crate::message::POSTING_TYPES;
use crate::VaultError;

/// Accounts searched on the standard Ethereum path. The Farcaster app uses index 0.
pub const ACCOUNTS_SEARCHED: u32 = 10;
/// The app key lives 30 days from its last use (sliding), well under the protocol's 90.
pub const APP_KEY_TTL: u32 = 30 * 86_400;
/// How far ahead a request's deadline may be.
pub const REQUEST_WINDOW: u32 = 60 * 60;

fn refused(reason: &str) -> VaultError {
    VaultError::Refused {
        reason: reason.to_owned(),
    }
}

/// The phrase as BIP-39 wants it: lowercase ASCII words joined by single spaces. Any Unicode
/// whitespace separates words (a paste can carry no-break spaces); anything else that isn't an
/// ASCII letter is refused rather than normalized, since the English wordlist is ASCII.
fn normalize(phrase: &[u8]) -> Result<Zeroizing<String>, VaultError> {
    let text = std::str::from_utf8(phrase).map_err(|_| VaultError::InvalidPhrase)?;
    let mut out = Zeroizing::new(String::with_capacity(phrase.len()));
    let mut gap = false;
    for c in text.chars() {
        if c.is_whitespace() {
            gap = !out.is_empty();
        } else if c.is_ascii_alphabetic() {
            if gap {
                out.push(' ');
                gap = false;
            }
            out.push(c.to_ascii_lowercase());
        } else {
            return Err(VaultError::InvalidPhrase);
        }
    }
    Ok(out)
}

/// The accounts m/44'/60'/0'/0/i share one parent, derived once from the phrase.
fn parent_key(phrase: &[u8]) -> Result<alloy_signer_local::MnemonicKey, VaultError> {
    let words = normalize(phrase)?;
    MnemonicBuilder::<English>::default()
        .phrase(words.as_str())
        .build_parent_key()
        .map_err(|_| VaultError::InvalidPhrase)
}

/// Whether the phrase is a valid English BIP-39 phrase, for the entry field's feedback.
pub fn phrase_is_valid(phrase: &[u8]) -> bool {
    normalize(phrase).is_ok_and(|p| {
        alloy_signer_local::coins_bip39::Mnemonic::<English>::new_from_phrase(p.as_str()).is_ok()
    })
}

/// r ‖ s ‖ v with v of 27 or 28, the form Snapchain recovers, checked by recovering it.
fn sign(signer: &PrivateKeySigner, digest: B256) -> Result<[u8; 65], VaultError> {
    let sig = signer
        .sign_hash_sync(&digest)
        .map_err(|_| refused("signing failed"))?;
    if sig.recover_address_from_prehash(&digest).ok() != Some(signer.address()) {
        return Err(refused("a signature failed to recover"));
    }
    Ok(sig.as_bytes())
}

/// Runs `f` with the account whose address is `custody`, or reports that none matched.
fn with_custody<T>(
    phrase: &[u8],
    custody: Address,
    f: impl FnOnce(&PrivateKeySigner, u32) -> Result<T, VaultError>,
) -> Result<T, VaultError> {
    let parent = parent_key(phrase)?;
    for index in 0..ACCOUNTS_SEARCHED {
        let signer = parent
            .child(index)
            .map_err(|_| refused("key derivation failed"))?
            .signer();
        if signer.address() == custody {
            return f(&signer, index);
        }
    }
    Err(VaultError::NoMatchingAccount)
}

fn check_window(deadline: u32, now: u32) -> Result<(), VaultError> {
    if deadline <= now {
        return Err(refused("The request has expired. Start again."));
    }
    if deadline > now.saturating_add(REQUEST_WINDOW) {
        return Err(refused(
            "The request lasts longer than an hour, which the vault refuses.",
        ));
    }
    Ok(())
}

pub struct KeyAddApproval {
    pub custody_signature: [u8; 65],
    pub metadata: Vec<u8>,
    pub index: u32,
}

/// Approves `key` (this phone's app key) for `fid`: the `SignedKeyRequest`, since the FID
/// requests its own key, then the `KeyAdd`, with the posting scopes and TTL fixed above.
/// `now` is Farcaster time from the native clock.
pub fn approve_key_add(
    phrase: &[u8],
    fid: u64,
    key: &[u8; 32],
    custody: Address,
    nonce: u32,
    deadline: u32,
    now: u32,
) -> Result<KeyAddApproval, VaultError> {
    if fid == 0 {
        return Err(refused("bad FID"));
    }
    check_window(deadline, now)?;
    with_custody(phrase, custody, |signer, index| {
        let request_sig = sign(signer, signed_key_request_digest(fid, key, deadline))?;
        let metadata = signed_key_request_metadata(fid, custody, &request_sig, deadline);
        let custody_signature = sign(
            signer,
            key_add_digest(fid, key, &POSTING_TYPES, APP_KEY_TTL, nonce, deadline),
        )?;
        Ok(KeyAddApproval {
            custody_signature,
            metadata,
            index,
        })
    })
}

/// Approves the removal of `key` from `fid`.
pub fn approve_key_remove(
    phrase: &[u8],
    fid: u64,
    key: &[u8; 32],
    custody: Address,
    nonce: u32,
    deadline: u32,
    now: u32,
) -> Result<([u8; 65], u32), VaultError> {
    if fid == 0 {
        return Err(refused("bad FID"));
    }
    check_window(deadline, now)?;
    with_custody(phrase, custody, |signer, index| {
        Ok((
            sign(signer, key_remove_digest(fid, key, nonce, deadline))?,
            index,
        ))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const DEV: &[u8] = b"test test test test test test test test test test test junk";
    // The development phrase's accounts 0 and 3.
    const ACCOUNT_0: Address = Address::new(hex20("f39fd6e51aad88f6f4ce6ab8827279cfffb92266"));
    const ACCOUNT_3: Address = Address::new(hex20("90f79bf6eb2c4f870365e785982e1f101e93b906"));

    const fn nibble(c: u8) -> u8 {
        if c >= b'a' {
            c - b'a' + 10
        } else {
            c - b'0'
        }
    }

    const fn hex20(s: &str) -> [u8; 20] {
        let b = s.as_bytes();
        let mut out = [0u8; 20];
        let mut i = 0;
        while i < 20 {
            out[i] = nibble(b[2 * i]) << 4 | nibble(b[2 * i + 1]);
            i += 1;
        }
        out
    }

    #[test]
    fn finds_the_custody_account_and_refuses_others() {
        let key = [0x5a; 32];
        let a = approve_key_add(DEV, 1234, &key, ACCOUNT_3, 3, 1_000, 900).unwrap();
        assert_eq!(a.index, 3);
        assert!(matches!(
            approve_key_add(DEV, 1234, &key, Address::repeat_byte(1), 3, 1_000, 900),
            Err(VaultError::NoMatchingAccount)
        ));
        assert_eq!(
            approve_key_remove(DEV, 1234, &key, ACCOUNT_0, 3, 1_000, 900)
                .unwrap()
                .1,
            0
        );
    }

    #[test]
    fn accepts_messy_spacing_and_case_but_not_bad_phrases() {
        let messy =
            "  Test test\ttest test\n test\u{a0}test test test test test test JUNK ".as_bytes();
        assert!(approve_key_add(messy, 1234, &[0x5a; 32], ACCOUNT_0, 3, 1_000, 900).is_ok());
        assert!(!phrase_is_valid(
            b"test test test test test test test test test test test test"
        ));
        assert!(!phrase_is_valid(
            "test test test test test test test test test test test jünk".as_bytes()
        ));
        assert!(phrase_is_valid(DEV));
    }

    #[test]
    fn refuses_expired_and_far_deadlines() {
        let r = |deadline| approve_key_add(DEV, 1234, &[0x5a; 32], ACCOUNT_0, 3, deadline, 1_000);
        assert!(r(1_000).is_err());
        assert!(r(1_000 + REQUEST_WINDOW + 1).is_err());
        assert!(r(1_000 + REQUEST_WINDOW).is_ok());
    }
}
