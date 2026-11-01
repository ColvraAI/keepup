---
lab: 02-whisper
status: not_run
needs: OPENAI_API_KEY
---
Running this lab sends each LibriVox recording through the fork's OpenAI provider with whisper-1 and with gpt-transcribe, then records word error rate against the published text, time to the result and the listed price per minute; it needs OPENAI_API_KEY.
