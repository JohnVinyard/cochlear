
At a high level, the API exists to allow clients to describe audio on the internet via "annotations". An annotation points at a `sound` resource, along with an optional time slice/segment (when absent, the annotation applies to the sound in its entirety).  Examples of supported annotations:

-  a text/prose description of the sound in its entirety
- a tag or tags describing the sound in its entirety
- A text/prose description of a segment of the sound
- a tag or tags describing a segment of the sound
-  A time-series feature describing a sound in its entirety (e.g., chroma or mfcc features)
- A single vector summarizing the sound in its entirety
- A vector summarizing a segment of the sound

The API will be RESTful and be described by an Open API specification.  Authentication will happen either via scoped API keys for "direct" API access, or via firebase auth tokens for access via a web app.  Both will be sent in the `Authorization` header and validated by the backend server.  The API will lean heavily on links/HATEOS (more on this later).

It's important to note that the goal of this app is not to _store_ audio, rather, its intent is to _describe_ audio on the internet that is, as much as possible, `GET`-able by anonymous users.  

Since some integrations/annotator-bots may "watch" for new sounds and/or annotations, `sounds` and `annotations` resources act as a "feed" by default, returning items in the chronological order they were created, from oldest-to-newest.  Many bots/integrations will act like a stream consumer, maintaining their offset (as the last seen id)  in order to poll for new data to process.  For example, an integration that computes time-series chroma, mfcc, etc. features might poll for every new sound and create the annotations.

## Example Integrations

- a bot (Python script) that ingests the MusicNet dataset, with all its annotations (these individual files will need to be "mirrored" somewhere, since this dataset is only published as a ZIP file, but that's outside the scope of the bot's responsibilities)
- Many other data set ingestion scripts, looking much like the MusicNet one
- a bot (Python script) that creates annotations for many "classic" audio features, using `librosa`, for example
## API Resources

[This](https://github.com/JohnVinyard/annotate-api/tree/master) will be our jumping-off point, with some significant changes, but it captures the larger scale structure of the API we're going to build.

### Users

Roles: `[SOUND_READER, ANNOTATION_READER, ANNOTATION_SCHEMA_READER, SOUND_EDITOR, ANNOTATION EDITOR, ANNOTATION_SCHEMA_CREATOR, API_KEY_CREATOR]`

Note that only users authenticated via firebase will have the `API_KEY_CREATOR` role, i.e., api keys can only be created by users in the web context.

### Integrations

create and manage API keys.  This should follow the basic shape of ~/workspace/monorepo/api/apiKeys.  Users may only create API keys with a subset of permissions they already have themselves (except, of course, for `API_KEY_CREATOR`, which can never be granted to an integration)

### Annotation Schema

Describes the different types of annotation that are possible.  These should be referenced when creating new concrete annotations.  Schemas may only be created by a select few users.  New annotations must declare the schema they adhere to;  unknown schemas are rejected.

### Annotations

#### `POST /sounds/{sound_id}/annotations`

```json
{
	"schema": "tags",
	"tags": ["piano", "bright"],
	"access": "null | * | 1234,5678"
}
```

When creating annotations, an `access` field determines who may see them.  Annotations are private by default.  `*` means that the annotation is public.  An array of user ids indicates which users my see the annotations.

Annotations are immutable, and may only be deleted by their original creators.

## Web App

Vite, react (with react router) served as a static app, deployed to firebase.  The structure of the web app should match the structure of the API resources as closely as possible.  The 

## API Client

The API client will be an important part of this project, and will use `conjure` (see ~/workspace conjure and/or https://github.com/JohnVinyard/conjure) for local caching

## Implementation Details

### Tests

Test coverage is highly important.  Coverage will focus heavily on full-stack API integration tests, exercising as much of the app as possible.  Where appropriate, unit tests for business logic in the domain will also be used.  The full-stack API tests will be run against a local, `docker-compose`-run instance, which will be started by the developer, and not by the test scripts themselves

### API Server

Express, Typescript, using clean/screaming/onion architecture, in the style of ~/workspace/monorepo/api (note the clean arch dirs in the dependency cruiser files).

We'll try to use the type system to its fullest potential to avoid "unrepresentable" types, e.g., using branded types for integer ids to differentiate a `UserId` from a plain integer, and a `SoundId` from a user ID.  

Initial validation will happen in the API adapter using JSON schema.  More complex "business-logic" decision will be made in the domain, but may still bubble up to the API layer as `400 Bad Request` errors, for example.  

### Data Store

Postgres, with the pg vector extension
database should be versioned using sequential database upgrade scripts
We'll have selective indices over the annotations table for
- tags
- text/prose
- vectors
- key/value pairs (stored as JSON) (e.g. `{ "instrument": "piano" }`)

blobs (typically, this will be binary data stored in the [npz](https://numpy.org/devdocs/reference/generated/numpy.lib.npyio.NpzFile.html) format, describing time-varying features like mfcc, chroma, loudness, etc.) will be stored, and may provide the basis for other features, but will not be indexed directly.  As an example, imagine an integration that "follows" a feed of beat-tracking/segment `annotations`, grabs the corresponding chroma features from that time slice, and then summarizes them as a new annotation, which is the mean chroma value for that beat/segment.

Indices over different columns of the `annotations` table will be created by hand, for now.  We'll support tag searches, full-text searches, and vector searches for different features, as they become available.

## Local Development

We will use docker compose for local dev, for all services:

- postgres database (mounted from host, for persistent data across sessions)
- api server (source mounted from host, for ease of development, hot-reloads, etc.)
- static frontend (source mounted from host....)
- Firebase auth emulatorr

We should use terraform to deploy to Google Cloud, using Cloud SQL for the Postgres database, Cloud Run for the API server,


## Audio Codec

The audio codec described below is a standalone piece of technology, but will be a perfect companion to the API described above.

[wiggle](https://github.com/JohnVinyard/wiggle) Python library
[sequencer and sampler](https://github.com/JohnVinyard/pattern-app/blob/7d1815d0d2d56de5f97c125aa604b74651c59542/webapp/domain/synth.ts)

The basic idea here is an audio codec whose _encoded_ state is somewhat human readable and interpretable.  It is a (possibly nested) JSON structure, describing parameters of a pluggable/extensible decoder.  The _encoding_ side here is of less concern at the moment, but a simple example would be a matching pursuit algorithm that decomposes a sound, stores its atom dictionary on the internet, and then describes the source sound via timed invocations of the `sampler`.  To start, the core decoder will consist of a `sampler` module (it plays a sound URI, with some optional, minimal processing) and a `sequencer` module, which can describe samples and their times of occurrence, and/or other `sequencer` instances.  Times are, by default, expressed in terms of _seconds_, but each `sequencer` instance, including nested instances, can describe a speed/scaling parameter, thus dilating or contracting its ancestors.

One key draw of this approach is that audio files can be _transformed_ via something like [`JSONata`](https://jsonata.org/), or really any programming environment that can read and manipulate nested data structures.  This is intentionally meant to blur the line between a traditional audio codec and something like a DAW or tracker.

### Questions/Concerns

- Is this just a (poor) re-invention of VST?  Are there other/better standards that already exist.  A **sparse, human readable and manipulatable** encoding is my primary aim here
- The primary target is in-browser.  Should the first "decoder" implementation be written using Web Audio, or written in something like Rust and compiled to WASM as a `AudioWorkletProcessor`,  so that desktop/CLI apps are also immediately possible?