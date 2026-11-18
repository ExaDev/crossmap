//! The errors crossmap defines. Every failure the library reports is a [`CrossmapError`], so a caller handles the
//! family with one match, and each variant carries what its message is built from.

use std::fmt::Write as _;

/// One reason a crosswalk document or a path string failed its schema or grammar: a message naming the offending
/// value, prefixed with the dotted path of the field it concerns (`(root)` for the document itself).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SyntaxIssue {
    /// The message.
    pub message: String,
}

/// One structural defect of a crosswalk that parses: which rule (two-way rules first, then one-way rules, continuing
/// the count; negative when the defect lies between rules) and what is wrong.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CrosswalkIssue {
    /// The rule the defect belongs to, or a negative number when it lies between rules.
    pub rule_index: i64,
    /// What is wrong.
    pub message: String,
}

/// An error crossmap reports.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum CrossmapError {
    /// A crosswalk document or a path string fails its schema or grammar. Every issue found is carried, not just the
    /// first, so one failed parse reports the whole document.
    #[error("crosswalk syntax error: {}", syntax_message(.issues))]
    Syntax {
        /// Every issue, in the order the document's fields were read.
        issues: Vec<SyntaxIssue>,
    },
    /// A crosswalk parses but its rule list cannot execute as written. Carries every issue `validate_crosswalk`
    /// reports.
    #[error("crosswalk structure error: {}", structure_message(.issues))]
    Structure {
        /// Every issue.
        issues: Vec<CrosswalkIssue>,
    },
    /// A rule cannot be applied to a document: its read path is absent, a value does not fit the operation, or two
    /// destinations conflict. `rule_index` numbers two-way rules first, then one-way rules, and is negative when the
    /// failure belongs to no single rule (an output array element no rule wrote).
    #[error("{}", rule_application_message(*.rule_index, .path, .detail))]
    RuleApplication {
        /// The rule that failed, or a negative number when no single rule owns the failure.
        rule_index: i64,
        /// The path or paths the failure concerns, as the crosswalk spells them.
        path: String,
        /// What went wrong, without the rule and path prefix the message adds.
        detail: String,
    },
    /// `decode(encode(sample))` differs from the sample on a path the crosswalk promises to preserve.
    #[error("sample {sample_index} ({path}): {detail}")]
    RoundTripMismatch {
        /// The position of the sample in the list given.
        sample_index: usize,
        /// The first differing location, in the path grammar's canonical spelling (empty for the root).
        path: String,
        /// How the two values differ.
        detail: String,
    },
    /// A `when` predicate could not be evaluated at all, as opposed to being indeterminate: it names a collection that
    /// is absent or not an array of records, or uses a `lookup` node, which crosswalks do not support. It is outside
    /// the codec's error classes (the npm package throws a plain `Error` and the Python package a `ValueError`), so
    /// [`CrossmapError::class_name`] reports it as `Error`.
    #[error("{message}")]
    WhenEvaluation {
        /// Why the predicate could not be evaluated.
        message: String,
    },
}

impl CrossmapError {
    /// The name of the error's class in the npm and Python packages and in the conformance corpus:
    /// `CrosswalkSyntaxError`, `CrosswalkStructureError`, `RuleApplicationError`, `RoundTripMismatchError`, or `Error`
    /// for [`CrossmapError::WhenEvaluation`].
    pub fn class_name(&self) -> &'static str {
        match self {
            Self::Syntax { .. } => "CrosswalkSyntaxError",
            Self::Structure { .. } => "CrosswalkStructureError",
            Self::RuleApplication { .. } => "RuleApplicationError",
            Self::RoundTripMismatch { .. } => "RoundTripMismatchError",
            Self::WhenEvaluation { .. } => "Error",
        }
    }

    /// A rule application failure of `rule_index` at `path`.
    pub(crate) fn rule(
        rule_index: usize,
        path: impl Into<String>,
        detail: impl Into<String>,
    ) -> Self {
        Self::RuleApplication {
            rule_index: i64::try_from(rule_index).unwrap_or(i64::MAX),
            path: path.into(),
            detail: detail.into(),
        }
    }

    /// A syntax error with one issue.
    pub(crate) fn syntax(message: impl Into<String>) -> Self {
        Self::Syntax {
            issues: vec![SyntaxIssue {
                message: message.into(),
            }],
        }
    }
}

fn syntax_message(issues: &[SyntaxIssue]) -> String {
    let parts: Vec<&str> = issues.iter().map(|issue| issue.message.as_str()).collect();
    parts.join("; ")
}

fn structure_message(issues: &[CrosswalkIssue]) -> String {
    let mut text = String::new();
    for (position, issue) in issues.iter().enumerate() {
        if position > 0 {
            text.push_str("; ");
        }
        if issue.rule_index < 0 {
            text.push_str(&issue.message);
        } else {
            let _ = write!(text, "rule {}: {}", issue.rule_index, issue.message);
        }
    }
    text
}

fn rule_application_message(rule_index: i64, path: &str, detail: &str) -> String {
    if rule_index < 0 {
        format!("{path}: {detail}")
    } else {
        format!("rule {rule_index} ({path}): {detail}")
    }
}
