pub const DEFAULT_MODEL: &str = "claude-sonnet-5-5";
pub const SHAPE: &str = "{ not a real block";

#[cfg(test)]
mod tests {
    const BASE: &str = r#"
[agent.llm]
model = "claude-3-sonnet-20240229"
"#;

    #[test]
    fn brace_in_a_char() {
        let open = '{';
        assert_eq!(open, '{');
    }
}

pub const AFTER_TESTS: &str = "claude-sonnet-4-5-20250929";
