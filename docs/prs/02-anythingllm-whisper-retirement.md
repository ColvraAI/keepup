# PR 02 · AnythingLLM: keep audio uploads working after 26 Feb 2027

| | |
| --- | --- |
| Fork | `<demo-org>/anything-llm` |
| Base | bbefbc7f (31 Aug 2026 22:25 UTC, the last upstream commit before 1 Sep in UTC; D23) |
| Branch | `keepup/2026-09-01-whisper-retirement` |
| Opened in the replay | 1 Sep 2026, at install. The deprecation was announced on 26 Aug. |

## What keepup saw

collector/utils/WhisperProviders/OpenAiWhisper.js:11 sets `this.model = "whisper-1"`. OpenAI shuts down whisper-1 on 26 Feb 2027, and its named successors are gpt-transcribe and gpt-live-transcribe.

The same shutdown also reaches server/utils/SpeechToText/openAi/index.js:8 and frontend/src/components/SpeechToText/OpenAiOptions/index.jsx:76, which default to whisper-1 for voice input, and the fallback list at server/utils/helpers/customModels.js:306. This pull request doesn't cover those, and says so in its risks.

## The change

- **Use gpt-transcribe for file uploads.** Check its request and response shape in the current OpenAI transcription guide; don't write it from memory.
- **Make the model a setting** with gpt-transcribe as the default, so the next change is a config edit.
- **Update** the provider's settings in the frontend. They say "Whisper Large" and "Whisper-large", not whisper-1 (TranscriptionSelection/OpenAiOptions:35, TranscriptionPreference:24): the disabled field becomes the real setting.
- **Tests.** The provider sends the configured model, and an unknown model returns a clear error.

## The lab: lab/02-whisper

**Test set.** Three short public-domain recordings from LibriVox, each with its published text. Save their URLs and licence notes in lab/02-whisper/testset.md.

**Measure.** Transcribe each with whisper-1 and gpt-transcribe through the real API. Record word error rate against the published text, time to the result, and the price per minute from the OpenAI pricing page (dated).

**Output.** lab/02-whisper/result.md.

**Title.** "Keep audio uploads working after 26 Feb 2027 · whisper-1 → gpt-transcribe". Add the measured word error rate if it's better.

## The pull request

- **Proof:** the vendor's deprecation notice, plus the lab table.
- **Risks:** a different output shape or price. Both are checked in the lab.
- **Rollback:** set the model setting back to whisper-1 until 26 Feb 2027.

## Sources

https://developers.openai.com/api/docs/changelog (26 Aug entry)
