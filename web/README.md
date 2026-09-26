# Tessitura: voice trainer powered by Praat

An in-browser voice training app built on [Praat](https://www.praat.org)'s analysis code, compiled to WebAssembly.
Nothing is uploaded: the microphone signal, the analysis and all saved sessions stay on the user's device.

**Live site:** https://l1n.github.io/praat.github.io/ (published by `.github/workflows/voice-trainer.yml` on every push to `master` or `claude/brave-pascal-1f9q7q`)

## What it does

- **Live**: real-time pitch trace against a target range, note name and cents, a vowel (F1/F2) chart with
  reference vowels, and running session statistics. You can record and send takes to Analyze.
- **Practice**: guided exercises with scores:
  - *Pitch match*: hear a note and hold it.
  - *Glide along*: follow a moving curve through your range.
  - *Steady vowel*: a Praat voice report (jitter, shimmer, HNR, CPPS).
  - *Read aloud*: speaking pitch, range, intonation and formants over a passage.
- **Analyze**: record or open any audio file and get waveform, pitch, spectrogram with formant tracks, and
  intensity. Hover to read values, drag to select a part, click to play from a point, pinch or ctrl+scroll to zoom.
  It also shows summary statistics and a voice-quality report for the whole file or the selection.
- **Progress**: trends across sessions (median pitch, time in target, resonance, exercise scores, HNR),
  replay and re-analyse saved recordings, and export or import your data as JSON.
- **Settings**: target range presets or a custom range, Praat analysis parameters (pitch floor/ceiling,
  formant ceiling, noise gate), input device, theme, and data management.

The app works offline after the first visit (service worker) and can be installed as a PWA.

## How it works

```
microphone ─► AudioWorklet ─► main thread ─► Web Worker ─► Praat (WebAssembly)
                                   │                          │
                                   └── recording              ├─ pw_live:  pitch + formants of the last 160 ms, every 25 ms
                                                              └─ pw_pitch / pw_formants / pw_spectrogram / … on whole recordings
```

- `wasm/praat_web.cpp`: a small C API (`pw_*` functions) around Praat's own analysis functions:
  `Sound_to_Pitch_rawAc` / `Sound_to_Pitch_filteredAc`, `Sound_to_Formant_burg`, `Sound_to_Intensity`,
  `Sound_to_Harmonicity_ac`, `Sound_to_Spectrogram_e`, `Sound_Pitch_to_PointProcess_cc`, the jitter and shimmer
  functions of `VoiceAnalysis`, and `PowerCepstrogram_getCPPS`.
- `wasm/Makefile`: compiles the Praat libraries (`melder`, `kar`, `sys`, `dwsys`, `stat`, `fon`, `LPC`, `dwtools`,
  `foned`, `external/gsl`, `external/clapack`, `external/zlib`) with Emscripten. It uses the object lists from
  Praat's own Makefiles and the barren build settings (`-DNO_GRAPHICS`, no audio, no GUI). Objects go to
  `wasm/build/`, so the Praat source tree stays clean. The output is `public/wasm/praat.{mjs,wasm}`
  (about 5 MB, 1.1 MB gzipped).
- `wasm/include/zconf.h`: zlib's configuration header. Praat's bundled zlib relies on the system copy, which
  Emscripten doesn't have.
- `public/`: the static site (plain ES modules, no bundler or runtime dependencies).
- `test/`: Node tests that run the WebAssembly module on synthetic vowels with known pitch and formants.

Recordings are resampled to 22.05 kHz before the detailed analyses. To stay responsive without threads, the
voice report places glottal pulses using the filtered-autocorrelation pitch (instead of raw cross-correlation)
and computes HNR with the autocorrelation method. Both are documented in `praat_web.cpp`.

## Building locally

```sh
# once: install the Emscripten SDK (CI uses 6.0.10)
git clone https://github.com/emscripten-core/emsdk.git && cd emsdk
./emsdk install 6.0.10 && ./emsdk activate 6.0.10 && source ./emsdk_env.sh && cd -

make -C web/wasm -j8              # build Praat → web/public/wasm/ (≈3 min the first time)
node --test web/test/*.test.mjs   # check the module
python3 -m http.server -d web/public 8000   # then open http://localhost:8000
```

Microphone access needs `localhost` or HTTPS.

## Deployment

`.github/workflows/voice-trainer.yml` builds and tests on every pull request, and on pushes to `master` it
deploys `web/public` to GitHub Pages. In the repository settings, set **Pages → Build and deployment → Source**
to **GitHub Actions**. Because the repository is named `praat.github.io` (not `l1n.github.io`), the site is served
at `https://l1n.github.io/praat.github.io/`. All paths in the app are relative, so it also works at a domain root
or in any subfolder.

## License

GPL v3 or later, like Praat. Reference vowel formants are from Hillenbrand, Getty, Clark & Wheeler (1995),
*Acoustic characteristics of American English vowels*, JASA 97(5).
