# Meeting workflow screenshots

These unedited DSH Web screenshots show the published plugin 0.1.2 on DSH
0.2.0-rc.2, Node.js 24.18.0 and Apple Silicon macOS 26.7, captured on 2026-10-08.

The example is a fictional product meeting generated with macOS speech synthesis.
The 56.6-second WAV was imported and transcribed by the plugin, producing 22
segments and two speaker labels. A separate DSH conversation selected the meeting
with `@`, read the complete transcript and used a configured DeepSeek model to
summarize decisions, action items and open questions. No real meeting data is shown.

This demonstrates the import and meeting-reference workflow. It is not an accuracy
benchmark or a new live-recording permission test. Audio inference runs locally;
the referenced transcript is sent to the LLM provider configured in DSH for summary.

## Meeting summary / 会议总结

![DSH reads the referenced meeting and summarizes its decisions](meeting-summary.jpg)

## Action items / 行动项

![Owners, tasks, deadlines and unresolved questions from the demo meeting](meeting-action-items.jpg)

## Meeting reference / 会议引用

![The @ picker lists the completed demo meeting](meeting-reference.jpg)

## Model preparation / 模型准备

![Base models, punctuation models and local inference components are ready](models-ready.jpg)
