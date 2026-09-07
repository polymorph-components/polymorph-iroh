//! The node identity: an Ed25519 signing key presented to rustls as a
//! `SigningKey`/`Signer` pair (iroh's raw public key shape).
//!
//! By default the key is a `polymorph:webcrypto` handle: the private key
//! material never enters guest memory, and `sign` crosses the WIT boundary
//! per handshake, not per packet. Under the `guest-ed25519-signing`
//! feature, `Identity::from_seed` instead holds an `ed25519-dalek` key in
//! guest memory and signs there.

use std::fmt;
use std::sync::Arc;

#[cfg(target_arch = "wasm32")]
use polymorph_webcrypto_guest::{ed25519, SigningKeyOptions};
use rustls::pki_types::{alg_id, SubjectPublicKeyInfoDer};
use rustls::sign::{public_key_to_spki, Signer, SigningKey};
use rustls::{Error, SignatureAlgorithm, SignatureScheme};

/// A node identity: the Ed25519 signing key plus its public half.
pub struct Identity {
    key: SignerKind,
    /// The raw 32-byte Ed25519 public key — iroh's `EndpointID`.
    pub endpoint_id: [u8; 32],
}

/// Where an identity's private key lives, and so which signer serves it.
enum SignerKind {
    #[cfg(target_arch = "wasm32")]
    Webcrypto(Arc<WebcryptoEd25519>),
    #[cfg(feature = "guest-ed25519-signing")]
    Guest(Arc<GuestEd25519>),
}

impl Identity {
    /// Generate a fresh identity. The signing key is minted
    /// non-extractable: the handle can sign, nothing can read it.
    #[cfg(target_arch = "wasm32")]
    pub async fn generate() -> Result<Self, String> {
        let (signing, verifying) = ed25519::generate_key(SigningKeyOptions {
            sign: true,
            extractable: false,
        })
        .await
        .map_err(|e| format!("generate identity: {e:?}"))?;
        let raw = verifying
            .export_key_raw()
            .await
            .map_err(|e| format!("export identity public key: {e:?}"))?;
        let endpoint_id: [u8; 32] = raw
            .as_slice()
            .try_into()
            .map_err(|_| format!("expected 32-byte Ed25519 public key, got {}", raw.len()))?;
        let spki = public_key_to_spki(&alg_id::ED25519, raw);
        Ok(Self {
            key: SignerKind::Webcrypto(Arc::new(WebcryptoEd25519 {
                key: Arc::new(signing),
                spki: spki.to_vec(),
            })),
            endpoint_id,
        })
    }

    /// Adopt an embedder-supplied identity: an Ed25519 signing/verifying
    /// pair as webcrypto handles.
    ///
    /// The pair is checked here — algorithm, sign permission, public-key
    /// shape, and a sign/verify probe of the halves against each other —
    /// so a bad pair fails at bind rather than as handshake failures
    /// against every peer.
    #[cfg(target_arch = "wasm32")]
    pub async fn from_injected(
        signing: polymorph_webcrypto_guest::SigningKey,
        verifying: polymorph_webcrypto_guest::VerifyingKey,
    ) -> Result<Self, String> {
        if signing.algorithm_name() != "Ed25519" {
            return Err(format!(
                "identity signing key is {}, not Ed25519",
                signing.algorithm_name()
            ));
        }
        if verifying.algorithm_name() != "Ed25519" {
            return Err(format!(
                "identity verifying key is {}, not Ed25519",
                verifying.algorithm_name()
            ));
        }
        if !signing.can_sign() {
            return Err("identity signing key does not permit sign".into());
        }
        let raw = verifying
            .export_key_raw()
            .await
            .map_err(|e| format!("export identity public key: {e}"))?;
        let endpoint_id: [u8; 32] = raw
            .as_slice()
            .try_into()
            .map_err(|_| format!("expected 32-byte Ed25519 public key, got {}", raw.len()))?;
        // The possession probe: the signature is verified locally and
        // discarded, never sent anywhere. The message is fixed and
        // matches no protocol's signing format (TLS CertificateVerify
        // and the relay challenge both frame their inputs), so the
        // probe cannot be confused with a protocol signature.
        const PROBE: &[u8] = b"polymorph:iroh endpoint identity possession probe";
        let sig = signing
            .sign(PROBE)
            .await
            .map_err(|e| format!("identity probe signature: {e}"))?;
        verifying.verify(PROBE, sig).await.map_err(|_| {
            "identity mismatch: the verifying key is not the signing key's public half".to_string()
        })?;
        let spki = public_key_to_spki(&alg_id::ED25519, raw);
        Ok(Self {
            key: SignerKind::Webcrypto(Arc::new(WebcryptoEd25519 {
                key: Arc::new(signing),
                spki: spki.to_vec(),
            })),
            endpoint_id,
        })
    }

    /// Mint an identity from an Ed25519 private-key seed: the 32-byte
    /// private key of RFC 8032 section 5.1.5, expanded to the signing
    /// scalar here. The key is held in guest memory for the identity's
    /// lifetime.
    #[cfg(feature = "guest-ed25519-signing")]
    pub fn from_seed(seed: &[u8]) -> Result<Self, String> {
        let seed: [u8; 32] = seed
            .try_into()
            .map_err(|_| format!("expected a 32-byte Ed25519 seed, got {}", seed.len()))?;
        let key = ed25519_dalek::SigningKey::from_bytes(&seed);
        let endpoint_id = key.verifying_key().to_bytes();
        let spki = public_key_to_spki(&alg_id::ED25519, endpoint_id);
        Ok(Self {
            key: SignerKind::Guest(Arc::new(GuestEd25519 {
                key,
                spki: spki.to_vec(),
            })),
            endpoint_id,
        })
    }

    /// The identity as a rustls signer, reporting the Ed25519 SPKI as
    /// its public key.
    pub fn signing_key(&self) -> Arc<dyn SigningKey> {
        match &self.key {
            #[cfg(target_arch = "wasm32")]
            SignerKind::Webcrypto(key) => key.clone(),
            #[cfg(feature = "guest-ed25519-signing")]
            SignerKind::Guest(key) => key.clone(),
        }
    }

    /// Sign `message` with the identity key (the relay handshake path;
    /// TLS signing goes through the rustls `Signer` instead).
    pub async fn sign(&self, message: &[u8]) -> Result<Vec<u8>, String> {
        match &self.key {
            #[cfg(target_arch = "wasm32")]
            SignerKind::Webcrypto(key) => key
                .key
                .sign(message)
                .await
                .map_err(|e| format!("webcrypto ed25519 sign: {e:?}")),
            #[cfg(feature = "guest-ed25519-signing")]
            SignerKind::Guest(key) => Ok(key.sign(message)),
        }
    }
}

#[cfg(target_arch = "wasm32")]
struct WebcryptoEd25519 {
    key: Arc<polymorph_webcrypto_guest::SigningKey>,
    spki: Vec<u8>,
}

#[cfg(target_arch = "wasm32")]
impl fmt::Debug for WebcryptoEd25519 {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("WebcryptoEd25519").finish_non_exhaustive()
    }
}

#[cfg(target_arch = "wasm32")]
impl SigningKey for WebcryptoEd25519 {
    fn choose_scheme(&self, offered: &[SignatureScheme]) -> Option<Box<dyn Signer>> {
        offered
            .contains(&SignatureScheme::ED25519)
            .then(|| Box::new(WebcryptoEd25519Signer(self.key.clone())) as Box<dyn Signer>)
    }

    fn public_key(&self) -> Option<SubjectPublicKeyInfoDer<'_>> {
        Some(SubjectPublicKeyInfoDer::from(&self.spki[..]))
    }

    fn algorithm(&self) -> SignatureAlgorithm {
        SignatureAlgorithm::ED25519
    }
}

#[cfg(target_arch = "wasm32")]
struct WebcryptoEd25519Signer(Arc<polymorph_webcrypto_guest::SigningKey>);

#[cfg(target_arch = "wasm32")]
impl fmt::Debug for WebcryptoEd25519Signer {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("WebcryptoEd25519Signer")
            .finish_non_exhaustive()
    }
}

#[cfg(target_arch = "wasm32")]
impl Signer for WebcryptoEd25519Signer {
    fn sign(&self, message: &[u8]) -> Result<Vec<u8>, Error> {
        wit_bindgen::block_on(async {
            self.0
                .sign(message)
                .await
                .map_err(|e| Error::General(format!("webcrypto ed25519 sign: {e:?}")))
        })
    }

    fn scheme(&self) -> SignatureScheme {
        SignatureScheme::ED25519
    }
}

/// An identity whose Ed25519 key is held, and signed with, in guest
/// memory (`guest-ed25519-signing`).
#[cfg(feature = "guest-ed25519-signing")]
struct GuestEd25519 {
    key: ed25519_dalek::SigningKey,
    spki: Vec<u8>,
}

#[cfg(feature = "guest-ed25519-signing")]
impl GuestEd25519 {
    fn sign(&self, message: &[u8]) -> Vec<u8> {
        use ed25519_dalek::Signer as _;
        self.key.sign(message).to_bytes().to_vec()
    }
}

#[cfg(feature = "guest-ed25519-signing")]
impl fmt::Debug for GuestEd25519 {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("GuestEd25519").finish_non_exhaustive()
    }
}

#[cfg(feature = "guest-ed25519-signing")]
impl SigningKey for GuestEd25519 {
    fn choose_scheme(&self, offered: &[SignatureScheme]) -> Option<Box<dyn Signer>> {
        offered
            .contains(&SignatureScheme::ED25519)
            .then(|| Box::new(GuestEd25519Signer(self.key.clone())) as Box<dyn Signer>)
    }

    fn public_key(&self) -> Option<SubjectPublicKeyInfoDer<'_>> {
        Some(SubjectPublicKeyInfoDer::from(&self.spki[..]))
    }

    fn algorithm(&self) -> SignatureAlgorithm {
        SignatureAlgorithm::ED25519
    }
}

#[cfg(feature = "guest-ed25519-signing")]
struct GuestEd25519Signer(ed25519_dalek::SigningKey);

#[cfg(feature = "guest-ed25519-signing")]
impl fmt::Debug for GuestEd25519Signer {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("GuestEd25519Signer").finish_non_exhaustive()
    }
}

#[cfg(feature = "guest-ed25519-signing")]
impl Signer for GuestEd25519Signer {
    fn sign(&self, message: &[u8]) -> Result<Vec<u8>, Error> {
        use ed25519_dalek::Signer as _;
        Ok(self.0.sign(message).to_bytes().to_vec())
    }

    fn scheme(&self) -> SignatureScheme {
        SignatureScheme::ED25519
    }
}

#[cfg(all(test, feature = "guest-ed25519-signing"))]
mod tests {
    use rustls::SignatureScheme;

    use super::Identity;

    /// The seed-to-identity mapping and the signature it produces must be
    /// RFC 8032's: a seed accepted here names the same public key, and
    /// signs the same bytes, as it does for every other Ed25519
    /// implementation. Test vector 1 of RFC 8032 section 7.1 (empty
    /// message).
    #[test]
    fn seed_to_identity_matches_rfc8032_vector_1() {
        let seed = hex::decode("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
            .unwrap();
        let public =
            hex::decode("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a")
                .unwrap();
        let signature = hex::decode(
            "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
        )
        .unwrap();

        let identity = Identity::from_seed(&seed).expect("32-byte seed is accepted");
        assert_eq!(identity.endpoint_id.as_slice(), public.as_slice());

        let signer = identity
            .signing_key()
            .choose_scheme(&[SignatureScheme::ED25519])
            .expect("the guest signer offers ED25519");
        assert_eq!(signer.sign(b"").unwrap(), signature);
    }

    /// A seed of the wrong length is rejected rather than padded or
    /// truncated into a different identity.
    #[test]
    fn short_seed_is_rejected() {
        assert!(Identity::from_seed(&[0u8; 31]).is_err());
    }
}
