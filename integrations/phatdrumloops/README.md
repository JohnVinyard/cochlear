# phatdrumloops.com

[The beats page](https://www.phatdrumloops.com/beats.php) lists 558 drum
breaks sampled from records, each with a hand-written entry: title, artist,
sometimes the drummer, original album and compilations, an upload date, and
a paragraph or two about the break. The 196 in the site's `/audio/wav/`
directory are mirrored at
`https://phat-drum-loops.s3.us-east-1.amazonaws.com/audio/wav/{file}`, with a
low-quality MP3 of each at `low-quality/audio/wav/{name}.mp3`. Those 196 are
what this imports. The ACM and ADPCM entries aren't mirrored, so they're
skipped.

| Annotation | Schema | Per break |
|---|---|---|
| The page's entry: `file`, `title`, `artist`, `drummer`, `original_album`, `comps`, `uploaded`, `description`. A field the entry doesn't have is left out. | `phatdrumloops-metadata@1` (kv, whole sound) | 1 |
| `drums` | `tags@1` (whole sound) | 1 |

Each sound has two **formats**
([`docs/sound-formats.md`](../../docs/sound-formats.md)): the original
`audio/wav` (`sample_rate`, `channels`, `bit_depth`, `sample_format`,
`size_bytes`), and the mirror's `audio/mpeg` (`size_bytes`). Most are 11 kHz,
mono, 16-bit.

The page is hand-written HTML, so scraping it is best effort. Entries are
split on the `<hr size=1 width=475>` between them, and the fields are read
with BeautifulSoup from where they usually are. On the current page every
entry yields a title, artist, date and description.

Exact durations come from each WAV's header, read with a ranged GET of its
first 64 KB. The mirror's bucket listing says which entries are mirrored.

**License:** `all-rights-reserved`. These are excerpts of commercial
recordings, and the site says it can't grant any rights to them.

## Running it

```bash
.venv/bin/pip install -e clients/python -r integrations/phatdrumloops/requirements.txt   # once
export COCHLEA_API_KEY=$(docker compose exec -T api yarn -s cli create-bot phatdrumloops \
    --about "Imports the drum breaks from phatdrumloops.com" --info-url https://www.phatdrumloops.com/beats.php)

.venv/bin/python integrations/phatdrumloops/phatdrumloops.py
```

| Option | |
|---|---|
| `--page` | the beats page, as a URL or a saved copy; default `https://www.phatdrumloops.com/beats.php` |
| `--api-url` (env `COCHLEA_API_URL`) | default `http://localhost:8080/v1` |
| `--api-key` (env `COCHLEA_API_KEY`) | the bot's key |
| `--audio-base-url` | the mirror's bucket; default `https://phat-drum-loops.s3.us-east-1.amazonaws.com` |
| `--files 8counts.wav,number1.wav`, `--limit N` | a subset |
| `--access public\|private` | default `public` |
| `--dry-run` | scrape and map everything, but don't call the API |

Locally, a run takes about a minute, and a re-run creates nothing. The bot's
annotations on each sound are kept to exactly the two above
(`sync_annotations(prune=True)`). If the page changes, or the scraper gets
better, a re-run replaces the old metadata annotation instead of adding a
second one.

## Some queries

```bash
H="Authorization: Bearer $COCHLEA_API_KEY"
curl -H "$H" "localhost:8080/v1/sounds?created_by=<bot id>"
curl -H "$H" "localhost:8080/v1/annotations?created_by=<bot id>&tags=drums"
curl -H "$H" "localhost:8080/v1/annotations?schema=phatdrumloops-metadata@1"
```
