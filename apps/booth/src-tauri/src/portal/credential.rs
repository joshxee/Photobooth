//! The device credential on disk: its own file in app-private storage, mode 0600 where the
//! platform has modes, written atomically. Never in the settings JSON, never logged, never sent
//! to the WebView (DESIGN §10 item 1; Keystore wrapping is post-MVP).

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use super::types::DeviceCredential;

const FORMAT: u32 = 1;

/// What enrolment left behind. The credential is bound to `portal_url`: the client sends it
/// only to that origin.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredCredential {
    /// The portal's origin (`scheme://host[:port]`), as enrolled.
    pub portal_url: String,
    pub device_id: String,
    pub device_name: String,
    pub credential: DeviceCredential,
}

#[derive(Serialize, Deserialize)]
struct CredentialFile {
    format: u32,
    #[serde(flatten)]
    stored: StoredCredential,
}

#[derive(Debug, Error)]
pub enum CredentialError {
    #[error("credential file I/O failed: {0}")]
    Io(#[from] io::Error),
    #[error("credential file is unreadable")]
    Corrupt,
}

/// Reads, writes and deletes the credential file at a fixed path.
#[derive(Clone, Debug)]
pub struct CredentialStore {
    path: PathBuf,
}

impl CredentialStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    #[cfg(test)]
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// `None` when the booth isn't enrolled. A damaged file is an error, not "not enrolled",
    /// so the operator sees it and can unenrol (which deletes it).
    pub fn load(&self) -> Result<Option<StoredCredential>, CredentialError> {
        let bytes = match fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.into()),
        };
        // The serde error could quote the file, so it is dropped.
        let file: CredentialFile =
            serde_json::from_slice(&bytes).map_err(|_| CredentialError::Corrupt)?;
        if file.format != FORMAT || !file.stored.credential.is_well_formed() {
            return Err(CredentialError::Corrupt);
        }
        Ok(Some(file.stored))
    }

    /// Writes a temp file (0600), `fsync`s it and renames it over the target.
    pub fn save(&self, stored: &StoredCredential) -> Result<(), CredentialError> {
        if let Some(dir) = self.path.parent() {
            fs::create_dir_all(dir)?;
        }
        let mut tmp = self.path.clone().into_os_string();
        tmp.push(".tmp");
        let tmp = PathBuf::from(tmp);
        let json = serde_json::to_vec(&CredentialFile {
            format: FORMAT,
            stored: stored.clone(),
        })
        .map_err(io::Error::other)?;
        {
            let mut file = private_file(&tmp)?;
            file.write_all(&json)?;
            file.sync_all()?;
        }
        fs::rename(&tmp, &self.path)?;
        Ok(())
    }

    /// Removes the file; already absent is fine.
    pub fn delete(&self) -> Result<(), CredentialError> {
        match fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        }
    }
}

/// Creates (or truncates) `path` readable and writable by this app's user only.
#[cfg(unix)]
fn private_file(path: &Path) -> io::Result<fs::File> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    // `mode` applies only when the file is created; a leftover temp file keeps its old mode.
    file.set_permissions(fs::Permissions::from_mode(0o600))?;
    Ok(file)
}

/// Windows has no modes; the app data directory is per user already.
#[cfg(not(unix))]
fn private_file(path: &Path) -> io::Result<fs::File> {
    fs::File::create(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(crate) const SECRET: &str = "c2VjcmV0LWNyZWRlbnRpYWwtZm9yLXRlc3RzLTAwMDA";

    fn stored() -> StoredCredential {
        StoredCredential {
            portal_url: "https://photos.example.invalid".into(),
            device_id: "019a0b60-1a2b-7c3d-8e4f-5a6b7c8d9e0f".into(),
            device_name: "Booth 1".into(),
            credential: DeviceCredential::new(SECRET),
        }
    }

    #[test]
    fn absent_means_not_enrolled() {
        let dir = tempfile::tempdir().unwrap();
        let store = CredentialStore::new(dir.path().join("portal-credential.json"));
        assert_eq!(store.load().unwrap(), None);
        store.delete().unwrap();
    }

    #[test]
    fn save_load_and_delete_round_trip_without_a_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let store = CredentialStore::new(dir.path().join("portal-credential.json"));
        store.save(&stored()).unwrap();
        assert_eq!(store.load().unwrap(), Some(stored()));
        assert!(fs::read_to_string(store.path()).unwrap().contains(SECRET));
        assert!(!dir.path().join("portal-credential.json.tmp").exists());
        store.delete().unwrap();
        assert_eq!(store.load().unwrap(), None);
    }

    #[cfg(unix)]
    #[test]
    fn the_file_is_private_to_the_app() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let store = CredentialStore::new(dir.path().join("portal-credential.json"));
        // A leftover temp file with loose permissions doesn't loosen the new one.
        fs::write(dir.path().join("portal-credential.json.tmp"), b"x").unwrap();
        fs::set_permissions(
            dir.path().join("portal-credential.json.tmp"),
            fs::Permissions::from_mode(0o644),
        )
        .unwrap();
        store.save(&stored()).unwrap();
        let mode = fs::metadata(store.path()).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn a_damaged_file_is_an_error_that_does_not_quote_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("portal-credential.json");
        let store = CredentialStore::new(&path);
        fs::write(&path, format!("{{\"credential\":\"{SECRET}\"")).unwrap();
        let err = store.load().unwrap_err();
        assert!(matches!(err, CredentialError::Corrupt));
        assert!(!err.to_string().contains(SECRET));

        // Well-formed JSON with a malformed credential is damaged too.
        let mut bad = stored();
        bad.credential = DeviceCredential::new("nope");
        store.save(&bad).unwrap();
        assert!(matches!(store.load(), Err(CredentialError::Corrupt)));
    }

    #[test]
    fn debug_output_redacts_the_secret() {
        assert!(!format!("{:?}", stored()).contains(SECRET));
    }
}
