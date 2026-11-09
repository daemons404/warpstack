//! Gasless key registration (FIP-272): the three EIP-712 structs a custody address signs in
//! Snapchain's own `Farcaster KeyAdd` domain, and the ABI-encoded `SignedKeyRequest` metadata a
//! `KEY_ADD` carries. The structs are declared once with alloy's `sol!`, which derives the type
//! strings, hashing and ABI encoding; the typehashes and digests are checked against the same
//! vectors as `protocol/src/gasless.ts`. None of these structs exists in the IdRegistry's
//! domain, so no signature made from them can transfer the FID or change its recovery address.

use alloy_primitives::{Address, Bytes, B256, U256};
use alloy_sol_types::{eip712_domain, sol, Eip712Domain, SolStruct, SolValue};

sol! {
    struct KeyAdd {
        uint256 fid;
        bytes key;
        uint32 keyType;
        uint32[] scopes;
        uint32 ttl;
        uint32 nonce;
        uint256 deadline;
    }

    struct KeyRemove {
        uint256 fid;
        bytes key;
        uint32 nonce;
        uint256 deadline;
    }

    struct SignedKeyRequest {
        uint256 requestFid;
        bytes key;
        uint256 deadline;
    }

    struct SignedKeyRequestMetadata {
        uint256 requestFid;
        address requestSigner;
        bytes signature;
        uint256 deadline;
    }
}

/// The domain is a constant: no request can swap in another contract or chain.
const DOMAIN: Eip712Domain =
    eip712_domain! { name: "Farcaster KeyAdd", version: "1", chain_id: 1, };

pub fn key_add_digest(
    fid: u64,
    key: &[u8; 32],
    scopes: &[u32],
    ttl: u32,
    nonce: u32,
    deadline: u32,
) -> B256 {
    KeyAdd {
        fid: U256::from(fid),
        key: Bytes::copy_from_slice(key),
        keyType: 1,
        scopes: scopes.to_vec(),
        ttl,
        nonce,
        deadline: U256::from(deadline),
    }
    .eip712_signing_hash(&DOMAIN)
}

pub fn key_remove_digest(fid: u64, key: &[u8; 32], nonce: u32, deadline: u32) -> B256 {
    KeyRemove {
        fid: U256::from(fid),
        key: Bytes::copy_from_slice(key),
        nonce,
        deadline: U256::from(deadline),
    }
    .eip712_signing_hash(&DOMAIN)
}

pub fn signed_key_request_digest(request_fid: u64, key: &[u8; 32], deadline: u32) -> B256 {
    SignedKeyRequest {
        requestFid: U256::from(request_fid),
        key: Bytes::copy_from_slice(key),
        deadline: U256::from(deadline),
    }
    .eip712_signing_hash(&DOMAIN)
}

/// `abi.encode(SignedKeyRequestMetadata)`, the layout `KEY_ADD.metadata` carries.
pub fn signed_key_request_metadata(
    request_fid: u64,
    request_signer: Address,
    signature: &[u8; 65],
    deadline: u32,
) -> Vec<u8> {
    SignedKeyRequestMetadata {
        requestFid: U256::from(request_fid),
        requestSigner: request_signer,
        signature: Bytes::copy_from_slice(signature),
        deadline: U256::from(deadline),
    }
    .abi_encode()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }

    // Reference vectors (sealed core): the values gasless.test.ts pins from Snapchain's
    // `core::validations::key` and checks against viem.
    #[test]
    fn typehashes_and_domain_match_snapchain() {
        assert_eq!(
            hex(DOMAIN.separator().as_slice()),
            "707019aeb448daaaf80d91a73d5f686b66e14a1a69ba6bf4ed39331d72d9ac2a"
        );
        let zero = [0u8; 32];
        let add = KeyAdd {
            fid: U256::ZERO,
            key: Bytes::copy_from_slice(&zero),
            keyType: 1,
            scopes: vec![],
            ttl: 0,
            nonce: 0,
            deadline: U256::ZERO,
        };
        assert_eq!(
            hex(add.eip712_type_hash().as_slice()),
            "877e76191c085cf949012706bb292ce3315d25bf6a49bef6eb74755eef39caa7"
        );
        let remove = KeyRemove {
            fid: U256::ZERO,
            key: Bytes::new(),
            nonce: 0,
            deadline: U256::ZERO,
        };
        assert_eq!(
            hex(remove.eip712_type_hash().as_slice()),
            "c6ce600cc73c69d40a81bb838c7641c348328b963a032ce30dc45b254f9ea5cd"
        );
        let request = SignedKeyRequest {
            requestFid: U256::ZERO,
            key: Bytes::new(),
            deadline: U256::ZERO,
        };
        assert_eq!(
            hex(request.eip712_type_hash().as_slice()),
            "16be47f1f1f50a66a48db64eba3fd35c21439c23622e513aab5b902018aec438"
        );
    }
}
