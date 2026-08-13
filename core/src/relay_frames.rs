//! Wire framing for iroh's relay protocol (`iroh-relay` websocket frames):
//! the client-side subset this endpoint speaks — handshake frames, datagram
//! send/recv, ping/pong.
//!
//! One frame is one binary websocket message: a QUIC-varint frame type
//! followed by the frame payload. Handshake payloads are postcard-encoded
//! structs, serialized with `postcard` over mirrors of upstream's types;
//! datagram payloads are byte-level layouts upstream specifies directly
//! (32-byte endpoint ID, ECN byte, optional u16 segment size for batches,
//! contents), assembled here. The known-answer tests mirror
//! `iroh-relay`'s own snapshot vectors.

/// Frame type tags (`iroh-relay`'s `FrameType`).
pub mod tag {
    pub const SERVER_CHALLENGE: u64 = 0;
    pub const CLIENT_AUTH: u64 = 1;
    pub const SERVER_CONFIRMS_AUTH: u64 = 2;
    pub const SERVER_DENIES_AUTH: u64 = 3;
    pub const CLIENT_TO_RELAY_DATAGRAM: u64 = 4;
    pub const CLIENT_TO_RELAY_DATAGRAM_BATCH: u64 = 5;
    pub const RELAY_TO_CLIENT_DATAGRAM: u64 = 6;
    pub const RELAY_TO_CLIENT_DATAGRAM_BATCH: u64 = 7;
    pub const ENDPOINT_GONE: u64 = 8;
    pub const PING: u64 = 9;
    pub const PONG: u64 = 10;
    pub const HEALTH: u64 = 11;
    pub const RESTARTING: u64 = 12;
    pub const STATUS: u64 = 13;
}

/// The domain-separation string for the handshake challenge signature:
/// the client signs `blake3::derive_key(CHALLENGE_DOMAIN, challenge)`.
pub const CHALLENGE_DOMAIN: &str = "iroh-relay handshake v1 challenge signature";

/// The websocket subprotocols this client offers, newest first.
pub const SUBPROTOCOLS: [&str; 2] = ["iroh-relay-v2", "iroh-relay-v1"];

/// The URL path serving the relay protocol.
pub const RELAY_PATH: &str = "/relay";

/// Split the QUIC-varint frame type off the front of a frame.
pub fn split_tag(frame: &[u8]) -> Option<(u64, &[u8])> {
    let first = *frame.first()?;
    let len = 1usize << (first >> 6);
    if frame.len() < len {
        return None;
    }
    let mut value = u64::from(first & 0x3f);
    for byte in &frame[1..len] {
        value = (value << 8) | u64::from(*byte);
    }
    Some((value, &frame[len..]))
}

/// One decoded relayed datagram: the sender and one datagram's contents.
#[derive(Debug, PartialEq, Eq)]
pub struct Datagram {
    pub source: [u8; 32],
    pub payload: Vec<u8>,
}

/// Encode a `client-to-relay-datagram` frame (single datagram, ECN 0).
pub fn encode_client_datagram(dst: &[u8; 32], payload: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(1 + 32 + 1 + payload.len());
    frame.push(tag::CLIENT_TO_RELAY_DATAGRAM as u8);
    frame.extend_from_slice(dst);
    frame.push(0); // ECN
    frame.extend_from_slice(payload);
    frame
}

/// `iroh-relay`'s `ClientAuth` handshake payload. The signature is a
/// length-prefixed byte sequence on the wire; postcard's seq-of-`u8`
/// encoding (varint length, raw bytes) is byte-identical to upstream's
/// `serde_bytes` form.
#[derive(serde::Serialize)]
struct ClientAuth<'a> {
    public_key: &'a [u8; 32],
    signature: &'a [u8],
}

/// Encode a `client-auth` handshake frame: the postcard encoding of
/// [`ClientAuth`].
pub fn encode_client_auth(public_key: &[u8; 32], signature: &[u8; 64]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(1 + 32 + 1 + 64);
    frame.push(tag::CLIENT_AUTH as u8);
    postcard::to_extend(
        &ClientAuth {
            public_key,
            signature,
        },
        frame,
    )
    .expect("Vec-backed postcard serialization cannot fail")
}

/// Encode a `pong` frame echoing `payload`.
pub fn encode_pong(payload: &[u8; 8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(1 + 8);
    frame.push(tag::PONG as u8);
    frame.extend_from_slice(payload);
    frame
}

/// Decode a `relay-to-client-datagram` or `-batch` payload (the bytes
/// after the frame type) into individual datagrams.
pub fn decode_relay_datagrams(payload: &[u8], batch: bool) -> Option<Vec<Datagram>> {
    let source: [u8; 32] = payload.get(..32)?.try_into().ok()?;
    let rest = &payload[32..];
    if batch {
        let segment_size = usize::from(u16::from_be_bytes(rest.get(1..3)?.try_into().ok()?));
        if segment_size == 0 {
            return None;
        }
        let contents = &rest[3..];
        Some(
            contents
                .chunks(segment_size)
                .map(|chunk| Datagram {
                    source,
                    payload: chunk.to_vec(),
                })
                .collect(),
        )
    } else {
        let contents = rest.get(1..)?;
        Some(vec![Datagram {
            source,
            payload: contents.to_vec(),
        }])
    }
}

/// Decode a `server-denies-auth` payload's postcard `reason` string,
/// best-effort (diagnostics only): a payload that does not decode as a
/// postcard string is taken lossily whole.
pub fn decode_denial_reason(payload: &[u8]) -> String {
    postcard::from_bytes::<String>(payload)
        .unwrap_or_else(|_| String::from_utf8_lossy(payload).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The public key of `SecretKey::from_bytes(&[42u8; 32])`, as used by
    /// `iroh-relay`'s own frame snapshot tests.
    const KEY: [u8; 32] = [
        0x19, 0x7f, 0x6b, 0x23, 0xe1, 0x6c, 0x85, 0x32, 0xc6, 0xab, 0xc8, 0x38, 0xfa, 0xcd, 0x5e,
        0xa7, 0x89, 0xbe, 0x0c, 0x76, 0xb2, 0x92, 0x03, 0x34, 0x03, 0x9b, 0xfa, 0x8b, 0x3d, 0x36,
        0x8d, 0x61,
    ];

    /// `iroh-relay`'s client→relay single-datagram snapshot, with ECN
    /// zeroed (this client never sets ECN).
    #[test]
    fn client_datagram_matches_upstream_snapshot() {
        let frame = encode_client_datagram(&KEY, b"Hello World!");
        let mut expected = vec![0x04];
        expected.extend_from_slice(&KEY);
        expected.push(0x00);
        expected.extend_from_slice(b"Hello World!");
        assert_eq!(frame, expected);
    }

    /// `iroh-relay`'s relay→client snapshots: the single-datagram frame
    /// (`06`, ECN 3) and the batch frame (`07`, segment size 6).
    #[test]
    fn relay_datagram_decodes_upstream_snapshots() {
        let mut single = vec![0x06];
        single.extend_from_slice(&KEY);
        single.push(0x03);
        single.extend_from_slice(b"Hello World!");
        let (tag, payload) = split_tag(&single).unwrap();
        assert_eq!(tag, tag::RELAY_TO_CLIENT_DATAGRAM);
        let datagrams = decode_relay_datagrams(payload, false).unwrap();
        assert_eq!(
            datagrams,
            vec![Datagram {
                source: KEY,
                payload: b"Hello World!".to_vec()
            }]
        );

        let mut batch = vec![0x07];
        batch.extend_from_slice(&KEY);
        batch.push(0x03);
        batch.extend_from_slice(&[0x00, 0x06]);
        batch.extend_from_slice(b"Hello World!");
        let (tag, payload) = split_tag(&batch).unwrap();
        assert_eq!(tag, tag::RELAY_TO_CLIENT_DATAGRAM_BATCH);
        let datagrams = decode_relay_datagrams(payload, true).unwrap();
        assert_eq!(
            datagrams,
            vec![
                Datagram {
                    source: KEY,
                    payload: b"Hello ".to_vec()
                },
                Datagram {
                    source: KEY,
                    payload: b"World!".to_vec()
                },
            ]
        );
    }

    /// Ping/pong framing from the upstream snapshots.
    #[test]
    fn ping_pong_frames() {
        assert_eq!(
            encode_pong(&[42; 8]),
            vec![0x0a, 42, 42, 42, 42, 42, 42, 42, 42]
        );
        let ping = [0x09, 42, 42, 42, 42, 42, 42, 42, 42];
        let (tag, payload) = split_tag(&ping).unwrap();
        assert_eq!(tag, tag::PING);
        assert_eq!(payload, [42; 8]);
    }

    /// The client-auth frame is `01` + postcard of
    /// `{ public_key: [u8;32], signature: serde_bytes [u8;64] }` — the
    /// hand-checked layout the postcard serialization must keep producing.
    #[test]
    fn client_auth_layout() {
        let frame = encode_client_auth(&KEY, &[7; 64]);
        assert_eq!(frame.len(), 1 + 32 + 1 + 64);
        assert_eq!(frame[0], 0x01);
        assert_eq!(&frame[1..33], &KEY);
        assert_eq!(frame[33], 64);
        assert_eq!(&frame[34..], &[7; 64][..]);
    }

    /// Denial reasons decode exactly at every length: the short form (a
    /// one-byte varint) and the >127-byte form (a two-byte varint the old
    /// hand decoder could only take lossily).
    #[test]
    fn denial_reason_decodes_at_every_length() {
        let short = postcard::to_allocvec(&"not authorized").unwrap();
        assert_eq!(decode_denial_reason(&short), "not authorized");

        let long = "x".repeat(200);
        let encoded = postcard::to_allocvec(&long).unwrap();
        assert_eq!(encoded[0] & 0x80, 0x80, "two-byte varint length");
        assert_eq!(decode_denial_reason(&encoded), long);

        // Garbage still renders, lossily.
        assert_eq!(decode_denial_reason(&[0xff, 0x00]), "\u{fffd}\u{0}");
    }
}
