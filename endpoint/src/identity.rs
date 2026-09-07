//! The `identity` interface family: the identity resource plus its
//! constructor interfaces (`identity-generate`, `identity-from-keys`, and
//! `identity-from-seed` when the `guest-ed25519-signing` feature is on).
//! Construction validates, so an `identity` in hand is valid by
//! construction; the resource is reusable across any number of
//! `endpoint-options`.

use std::rc::Rc;

use iroh_endpoint_core::crypto::sign::Identity as CoreIdentity;

use crate::bindings::exports::polymorph::iroh::identity::{Guest as IdentityGuest, GuestIdentity};
use crate::bindings::exports::polymorph::iroh::identity_from_keys::{
    Guest as FromKeysGuest, Identity, SigningKey, VerifyingKey,
};
#[cfg(feature = "guest-ed25519-signing")]
use crate::bindings::exports::polymorph::iroh::identity_from_seed::Guest as FromSeedGuest;
use crate::bindings::exports::polymorph::iroh::identity_generate::Guest as GenerateGuest;
use crate::bindings::polymorph::iroh::types::Error;
use crate::Component;

/// The exported `identity` resource: a validated key pair, shared by
/// reference-count with every `endpoint-options` built from it.
pub struct IdentityRes {
    pub inner: Rc<CoreIdentity>,
}

impl IdentityGuest for Component {
    type Identity = IdentityRes;
}

impl GuestIdentity for IdentityRes {
    fn endpoint_id(&self) -> Vec<u8> {
        self.inner.endpoint_id.to_vec()
    }
}

impl GenerateGuest for Component {
    async fn generate() -> Result<Identity, Error> {
        let core = CoreIdentity::generate()
            .await
            .map_err(|e| Error::Other(format!("generate identity: {e}")))?;
        Ok(Identity::new(IdentityRes {
            inner: Rc::new(core),
        }))
    }
}

impl FromKeysGuest for Component {
    async fn from_keys(signing: SigningKey, verifying: VerifyingKey) -> Result<Identity, Error> {
        let core = CoreIdentity::from_injected(signing.into(), verifying.into())
            .await
            .map_err(Error::InvalidArgument)?;
        Ok(Identity::new(IdentityRes {
            inner: Rc::new(core),
        }))
    }
}

#[cfg(feature = "guest-ed25519-signing")]
impl FromSeedGuest for Component {
    fn from_seed(seed: Vec<u8>) -> Result<Identity, Error> {
        let core = CoreIdentity::from_seed(&seed).map_err(Error::InvalidArgument)?;
        Ok(Identity::new(IdentityRes {
            inner: Rc::new(core),
        }))
    }
}
