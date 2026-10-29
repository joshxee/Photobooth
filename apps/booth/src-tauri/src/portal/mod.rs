//! The booth's side of the guest portal (DESIGN §8, §10): the device API's types, the HTTP
//! client, the stored credential, enrolment and event selection, and the post-shoot QR code.

pub mod client;
pub mod credential;
pub mod gallery;
pub mod service;
#[cfg(test)]
pub(crate) mod test_server;
pub mod types;

pub use credential::CredentialStore;
pub use service::{PortalConfig, PortalService};
