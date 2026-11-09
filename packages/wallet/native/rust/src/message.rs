//! The app key's check on what it signs ("decode, don't rebuild").
//! JavaScript hands over `MessageData` bytes; this decodes their top level strictly, checks the
//! type, FID and network against the purpose the caller named, and the key operations' bodies
//! against the key itself, then the caller hashes exactly the bytes it received. Duplicate or
//! unknown top-level fields are refused, so the bytes can mean only one thing to Snapchain.

pub const MAX_DATA_BYTES: usize = 2_048;
const FARCASTER_MAINNET: u64 = 1;

pub const KEY_ADD: u64 = 16;
pub const KEY_REMOVE: u64 = 17;
/// What an app key may sign: casts, reactions, follows and profile edits. Never keys,
/// verifications or storage. The same list as `POSTING_SCOPES` in `protocol`.
pub const POSTING_TYPES: [u32; 7] = [1, 2, 3, 4, 5, 6, 11];

/// The `MessageData` field that carries each type's body.
fn body_field(message_type: u64) -> Option<u32> {
    match message_type {
        1 => Some(5),
        2 => Some(6),
        3 | 4 => Some(7),
        5 | 6 => Some(14),
        11 => Some(12),
        16 => Some(19),
        17 => Some(20),
        _ => None,
    }
}

enum Value<'a> {
    Varint(u64),
    Bytes(&'a [u8]),
}

/// The top-level fields of a protobuf message. `None` on anything malformed, including wire
/// types this format never uses.
fn fields(b: &[u8]) -> Option<Vec<(u32, Value<'_>)>> {
    let mut out = Vec::new();
    let mut i = 0usize;
    let varint = |i: &mut usize| -> Option<u64> {
        let mut n: u64 = 0;
        for shift in (0..64).step_by(7) {
            let x = *b.get(*i)?;
            *i += 1;
            if shift == 63 && x > 1 {
                return None;
            }
            n |= u64::from(x & 0x7f) << shift;
            if x < 0x80 {
                return Some(n);
            }
        }
        None
    };
    while i < b.len() {
        let key = varint(&mut i)?;
        let field = u32::try_from(key >> 3).ok().filter(|f| *f >= 1)?;
        match key & 7 {
            0 => out.push((field, Value::Varint(varint(&mut i)?))),
            2 => {
                let len = usize::try_from(varint(&mut i)?).ok()?;
                let end = i.checked_add(len).filter(|e| *e <= b.len())?;
                out.push((field, Value::Bytes(&b[i..end])));
                i = end;
            }
            _ => return None,
        }
    }
    Some(out)
}

pub struct Decoded<'a> {
    pub message_type: u64,
    pub fid: u64,
    pub body: &'a [u8],
}

/// The top of `MessageData`: exactly one each of type, FID, timestamp, network and the type's
/// own body, and nothing else.
pub fn decode(data: &[u8]) -> Result<Decoded<'_>, &'static str> {
    if data.is_empty() || data.len() > MAX_DATA_BYTES {
        return Err("message size");
    }
    let fs = fields(data).ok_or("malformed message")?;
    let (mut t, mut fid, mut ts, mut net, mut body) = (None, None, None, None, None);
    for (i, (field, v)) in fs.iter().enumerate() {
        if fs[..i].iter().any(|(f, _)| f == field) {
            return Err("duplicate field");
        }
        match (field, v) {
            (1, Value::Varint(n)) => t = Some(*n),
            (2, Value::Varint(n)) => fid = Some(*n),
            (3, Value::Varint(n)) => ts = Some(*n),
            (4, Value::Varint(n)) => net = Some(*n),
            (_, Value::Bytes(b)) if body.is_none() => body = Some((*field, *b)),
            _ => return Err("unexpected field"),
        }
    }
    let message_type = t.ok_or("no type")?;
    let fid = fid.filter(|f| *f > 0).ok_or("no FID")?;
    ts.filter(|t| *t > 0 && *t <= u64::from(u32::MAX))
        .ok_or("bad timestamp")?;
    if net != Some(FARCASTER_MAINNET) {
        return Err("not a mainnet message");
    }
    let (field, body) = body.ok_or("no body")?;
    if body_field(message_type) != Some(field) {
        return Err("body does not match type");
    }
    Ok(Decoded {
        message_type,
        fid,
        body,
    })
}

/// The fields of a `KeyAddBody` or `KeyRemoveBody` the app key checks: the key (field 1) and,
/// for a removal, the signature type (field 3). Duplicates are refused.
pub fn key_body(body: &[u8]) -> Result<(&[u8], Option<u64>), &'static str> {
    let fs = fields(body).ok_or("malformed body")?;
    let (mut key, mut sig_type) = (None, None);
    for (i, (field, v)) in fs.iter().enumerate() {
        if fs[..i].iter().any(|(f, _)| f == field) {
            return Err("duplicate field");
        }
        match (field, v) {
            (1, Value::Bytes(b)) => key = Some(*b),
            (3, Value::Varint(n)) => sig_type = Some(*n),
            _ => {}
        }
    }
    Ok((key.ok_or("no key")?, sig_type))
}

#[cfg(test)]
mod tests {
    use super::*;

    // fid 1234, CAST_ADD, text "hi": the bytes `encodeMessageData` produces.
    fn cast(extra: &[u8]) -> Vec<u8> {
        let mut v = vec![
            0x08, 0x01, 0x10, 0xd2, 0x09, 0x18, 0x01, 0x20, 0x01, 0x2a, 0x04, 0x22, 0x02, b'h',
            b'i',
        ];
        v.extend_from_slice(extra);
        v
    }

    #[test]
    fn decodes_a_cast() {
        let bytes = cast(&[]);
        let d = decode(&bytes).unwrap();
        assert_eq!((d.message_type, d.fid), (1, 1234));
    }

    #[test]
    fn refuses_duplicates_unknown_wire_types_and_other_networks() {
        assert!(decode(&cast(&[0x10, 0x01])).is_err()); // a second FID
        assert!(decode(&cast(&[0x2a, 0x00])).is_err()); // a second body
        assert!(decode(&cast(&[0x0d, 0, 0, 0, 0])).is_err()); // fixed32
        let mut testnet = cast(&[]);
        testnet[8] = 0x02;
        assert!(decode(&testnet).is_err());
        assert!(decode(&cast(&[0x32, 0x00])).is_err()); // a body of another type
        let mut first = vec![0x32, 0x00];
        first.extend_from_slice(&cast(&[]));
        assert!(decode(&first).is_err()); // ...before the real one
        assert!(
            decode(&[0x08, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f]).is_err()
        );
        assert!(decode(&cast(&[0x2a, 0x05])).is_err()); // truncated
    }
}
