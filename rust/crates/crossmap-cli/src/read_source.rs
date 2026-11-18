//! Reading the text a command-line argument names: standard input for `-`, a URL when the argument starts with a
//! scheme, otherwise a file path.

use std::io::Read as _;
use std::time::Duration;

use base64::Engine as _;
use percent_encoding::percent_decode_str;

use crate::argument::{STDIN, SUPPORTED_SCHEMES, scheme_of};

/// How long one remote read may take, from sending the request to the last byte of the body. A command has no one
/// watching a progress indicator, so a server that accepts the connection and then stalls would otherwise hang it for
/// as long as the socket stays open. Generous enough for a slow link to deliver a document within
/// [`MAX_RESPONSE_BYTES`].
pub const FETCH_TIMEOUT: Duration = Duration::from_secs(30);

const BYTES_PER_MIB: u64 = 1024 * 1024;

/// The most bytes a remote body may hold: 64 MiB. The body is buffered whole and then parsed as one JSON text, so the
/// peak memory is a multiple of its size, and a server (or a redirect to one) that streams without end would otherwise
/// grow the process until it is killed. A crosswalk is a few kilobytes and a document or sample set is data a person
/// chose to apply it to, so the bound sits well above any plausible input.
pub const MAX_RESPONSE_BYTES: u64 = 64 * BYTES_PER_MIB;

/// The bounds on a remote read.
#[derive(Clone, Copy, Debug)]
pub struct ReadLimits {
    /// The time one read may take.
    pub timeout: Duration,
    /// The most bytes a body may hold.
    pub max_bytes: u64,
}

impl Default for ReadLimits {
    fn default() -> Self {
        ReadLimits {
            timeout: FETCH_TIMEOUT,
            max_bytes: MAX_RESPONSE_BYTES,
        }
    }
}

/// Reads the text an argument names. `http:` and `https:` are fetched, following redirects, within `limits`;
/// `data:` is decoded; `file:` is turned into a path and read as paths are. Any other scheme is refused.
///
/// # Errors
///
/// The reason the source is unreadable, unsupported, slow or larger than the cap. The message does not repeat the
/// argument; the caller names it.
pub fn read_source(argument: &str, limits: ReadLimits) -> Result<String, String> {
    if argument == STDIN {
        let mut bytes = Vec::new();
        std::io::stdin()
            .read_to_end(&mut bytes)
            .map_err(|error| error.to_string())?;
        return Ok(String::from_utf8_lossy(&bytes).into_owned());
    }
    let Some(scheme) = scheme_of(argument) else {
        return read_file(argument);
    };
    let scheme = scheme.to_ascii_lowercase();
    match scheme.as_str() {
        "file" => read_file(&file_url_path(argument)?),
        "data" => read_data_url(argument),
        "http" | "https" => fetch_text(argument, limits),
        _ => {
            let supported: Vec<String> = SUPPORTED_SCHEMES
                .iter()
                .map(|name| format!("{name}:"))
                .collect();
            Err(format!(
                "unsupported scheme {scheme}: (supported: {}, plain paths and -)",
                supported.join(", ")
            ))
        }
    }
}

/// A file's text, with invalid UTF-8 replaced as Node's `readFileSync(path, "utf8")` replaces it.
fn read_file(path: &str) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|error| error.to_string())?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// The path a `file:` URL names. The host must be empty or `localhost`, and the path is percent-decoded.
fn file_url_path(url: &str) -> Result<String, String> {
    let rest = &url["file:".len()..];
    let Some(after) = rest.strip_prefix("//") else {
        return decode_path(rest);
    };
    let (host, path) = after
        .find('/')
        .map_or((after, ""), |slash| after.split_at(slash));
    if !host.is_empty() && !host.eq_ignore_ascii_case("localhost") {
        return Err(format!(
            "File URL host must be \"localhost\" or empty on this platform: {host}"
        ));
    }
    if path.is_empty() {
        return Err("File URL path must be absolute".to_owned());
    }
    decode_path(path)
}

fn decode_path(path: &str) -> Result<String, String> {
    let path = path.split(['?', '#']).next().unwrap_or("");
    if path.contains("%2F") || path.contains("%2f") {
        return Err("File URL path must not include encoded / characters".to_owned());
    }
    percent_decode_str(path)
        .decode_utf8()
        .map(|decoded| decoded.into_owned())
        .map_err(|error| error.to_string())
}

/// The body of a `data:` URL, as `fetch` decodes it: percent-decoded, then base64-decoded when the media type ends in
/// `;base64`.
fn read_data_url(url: &str) -> Result<String, String> {
    let rest = &url["data:".len()..];
    let Some((meta, body)) = rest.split_once(',') else {
        return Err("invalid data: URL, no comma".to_owned());
    };
    let body = body.split('#').next().unwrap_or("");
    let bytes: Vec<u8> = percent_decode_str(body).collect();
    let is_base64 = meta
        .rsplit(';')
        .next()
        .is_some_and(|last| last.trim().eq_ignore_ascii_case("base64"));
    let bytes = if is_base64 {
        let compact: Vec<u8> = bytes
            .into_iter()
            .filter(|byte| !byte.is_ascii_whitespace())
            .collect();
        base64::engine::general_purpose::STANDARD
            .decode(&compact)
            .or_else(|_| base64::engine::general_purpose::STANDARD_NO_PAD.decode(&compact))
            .map_err(|error| format!("invalid base64 in data: URL ({error})"))?
    } else {
        bytes
    };
    String::from_utf8(bytes).map_err(|error| format!("the data is not UTF-8 ({error})"))
}

fn fetch_text(url: &str, limits: ReadLimits) -> Result<String, String> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(limits.timeout))
        .http_status_as_error(false)
        .proxy(None)
        .build()
        .into();
    let mut response = agent.get(url).call().map_err(|error| match error {
        ureq::Error::Timeout(_) => format!("no response within {} ms", limits.timeout.as_millis()),
        other => other.to_string(),
    })?;
    let status = response.status();
    if !status.is_success() {
        let reason = status.canonical_reason().unwrap_or("");
        return Err(format!("HTTP {} {reason}", status.as_u16())
            .trim_end()
            .to_owned());
    }
    let declared = response
        .headers()
        .get("content-length")
        .and_then(|length| length.to_str().ok())
        .and_then(|length| length.trim().parse::<u64>().ok());
    if let Some(declared) = declared
        && declared > limits.max_bytes
    {
        return Err(format!(
            "the response is {declared} bytes, over the {} byte limit",
            limits.max_bytes
        ));
    }
    let bytes = response
        .body_mut()
        .with_config()
        .limit(limits.max_bytes)
        .read_to_vec()
        .map_err(|error| match error {
            ureq::Error::Timeout(_) => format!(
                "the body was not complete within {} ms",
                limits.timeout.as_millis()
            ),
            ureq::Error::BodyExceedsLimit(_) => {
                format!("the response is over the {} byte limit", limits.max_bytes)
            }
            other => other.to_string(),
        })?;
    String::from_utf8(bytes).map_err(|error| format!("the response is not UTF-8 ({error})"))
}
