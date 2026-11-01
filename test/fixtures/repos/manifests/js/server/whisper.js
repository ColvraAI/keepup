class OpenAiWhisper {
  constructor() {
    this.model = "whisper-1";
    this.bedrock = "us.anthropic.claude-3-5-haiku-20241022-v1:0";
    this.routed = "anthropic/claude-3-opus-20240229";
    this.reasoning = "o3-mini";
    // Mentions of Claude Sonnet 4.5 in prose or claude-code are not model ids.
    this.notAModel = "claude-code";
  }
}
