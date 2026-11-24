# Annotation conventions

The API validates an annotation's kind and, if its schema has a
`json_schema`, its `data`. Beyond that, these conventions let tools make
sense of annotations without knowing their schemas.

## Time series blobs

A **blob** annotation whose blob is an `.npz` (`application/x-npz`) holding
a time series, e.g. frame-level features, describes it in
`data.timeseries`:

```json
{
  "schema": "featurebot-chroma@2",
  "blob": { "url": "https://…", "content_type": "application/x-npz" },
  "data": {
    "timeseries": {
      "array": "chroma",
      "frame_rate": 43.06640625,
      "start_seconds": 0,
      "rows": ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"],
      "range": [0, 1],
      "normalize": "global"
    }
  }
}
```

- **Time is the last axis.** A 1-d array is `(frames,)`; a 2-d array is
  `(rows, frames)`, e.g. `(12, frames)` for chroma. Arrays with more axes
  aren't covered (yet).
- `frame_rate` (required): frames per second. Frame *i* is at
  `start_seconds + i / frame_rate`.
- `start_seconds` (default 0): when frame 0 is, relative to the
  annotation's own start, or to the start of the sound for whole-sound
  annotations. Use it when frames are offset (e.g. analysis windows that
  aren't centred).
- `array`: the array's name in the `.npz`. It may be left out when there's
  only one.
- `rows`: labels for the rows of a 2-d array, first row first. Viewers draw
  row 0 at the bottom, like a spectrogram.
- `range`: the values to map to the ends of the colour scale. The default is
  the data's own minimum and maximum.
- `normalize`: `"global"` (the default) uses one scale for everything;
  `"rows"` scales each row on its own, which suits features whose rows have
  very different ranges, such as MFCCs.

Arrays may be any numeric dtype numpy writes, compressed
(`np.savez_compressed`) or not (`np.savez`). For features, **float16 with
`np.savez_compressed`** is a good default: about 2.8× smaller than float32,
which compresses poorly (its low mantissa bits are noise), with more
precision than features carry.

In TypeScript the convention is `TimeseriesData`, and `timeseriesOf(annotation)`
returns it when an annotation follows it (`@cochlea/shared`). The web app's
sound page draws every such annotation under the waveform, with
`<timeseries-view>`.

Writing one in Python:

```python
import io, numpy as np

buf = io.BytesIO()
np.savez_compressed(buf, chroma=chroma.astype(np.float16))   # (12, frames)
url = client.upload_blob(buf.getvalue(), "application/x-npz")
annotation = {
    "schema": "my-chroma@1",
    "blob": {"url": url, "content_type": "application/x-npz"},
    "data": {"timeseries": {"array": "chroma", "frame_rate": sr / hop_length}},
}
```
