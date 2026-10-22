//! The booth's side of the guest portal (DESIGN §8, §10): the device API's types, the HTTP
//! client, the stored credential, and enrolment and event selection.

pub mod client;
pub mod credential;
#[cfg(test)]
mod test_server;
pub mod types;
