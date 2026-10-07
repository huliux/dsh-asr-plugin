# Synthetic audio fixture

`alternating-stereo.mp3` contains two seconds of deterministic synthetic audio.
The first second uses the left channel at 440 Hz; the second uses the right
channel at 660 Hz. It contains no speech or personal data.

The fixture was generated with FFmpeg 8.0 and `libmp3lame`.
Its SHA-256 is
`399f859d65955d838b4d94a29324f319ad78e7d0b726bf4156ca16ccbbbad708`.

```sh
node tests/fixtures/audio/build.mjs
```

Set `FFMPEG=/absolute/path/to/ffmpeg` to select an executable.
The builder replaces the fixture atomically only when the output matches the
recorded hash. Other encoder versions can be used for semantic comparison but
do not replace the fixture.

The test checks channel content preservation during stereo-to-mono import.
The fixture is not a product asset.
