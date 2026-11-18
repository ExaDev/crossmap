//! What a command-line argument names, decided from its text alone: standard input, a URL or a path. Nothing here
//! reads anything, so the decision is the same wherever the reading is done (the native reader in `read_source`, or a
//! host such as the npm package's Node shim).

/// The argument that stands for standard input.
pub const STDIN: &str = "-";

/// The URL schemes the command reads, in the order the error for any other scheme lists them.
pub const SUPPORTED_SCHEMES: [&str; 4] = ["http", "https", "data", "file"];

/// Whether an argument names a URL: it starts with a scheme of two or more characters (a letter, then letters,
/// digits, `+`, `-` or `.`, as RFC 3986 allows) and a colon. Two characters at least, so a Windows drive path such as
/// `C:\x.json` stays a path; the character set admits `s3:` and `git+ssh:`, which are reported as unsupported rather
/// than read as file names.
pub fn is_url(argument: &str) -> bool {
    scheme_of(argument).is_some()
}

/// The scheme an argument starts with, as written (not lower-cased), when it names a URL.
pub fn scheme_of(argument: &str) -> Option<&str> {
    let colon = argument.find(':')?;
    let scheme = &argument[..colon];
    let mut characters = scheme.chars();
    let first = characters.next()?;
    let valid = first.is_ascii_alphabetic()
        && scheme.len() >= 2
        && characters.all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '+' | '.' | '-')
        });
    valid.then_some(scheme)
}
