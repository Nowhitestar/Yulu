# Changelog

All notable changes to Yulu are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.22.0](https://github.com/Nowhitestar/Yulu/compare/v0.21.0...v0.22.0) (2026-07-17)


### Features

* **audio:** decouple transcription engines from Agents ([c0cffe6](https://github.com/Nowhitestar/Yulu/commit/c0cffe62361b4021d85dec19838ef108aa01a572))

## [0.21.0](https://github.com/Nowhitestar/Yulu/compare/v0.20.0...v0.21.0) (2026-07-15)


### Features

* **captions:** redesign realtime subtitles and translation ([5dee237](https://github.com/Nowhitestar/Yulu/commit/5dee237d95b4f8065588b3f56c2386c35df78e2a))

## [0.20.0](https://github.com/Nowhitestar/Yulu/compare/v0.19.0...v0.20.0) (2026-07-14)


### Features

* **recordings:** keep capture and transcription continuous ([#97](https://github.com/Nowhitestar/Yulu/issues/97)) ([f1fabf9](https://github.com/Nowhitestar/Yulu/commit/f1fabf9a829f194f7810f64142d746d1e451a2bb))

## [0.19.0](https://github.com/Nowhitestar/Yulu/compare/v0.18.1...v0.19.0) (2026-07-13)


### Features

* **recordings:** restore atomic meeting actions ([#95](https://github.com/Nowhitestar/Yulu/issues/95)) ([1d783fa](https://github.com/Nowhitestar/Yulu/commit/1d783fad64598fc332c5f720be2725db888aa749))

## [0.18.1](https://github.com/Nowhitestar/Yulu/compare/v0.18.0...v0.18.1) (2026-07-11)


### Bug Fixes

* **installer:** align runtime dependency checks ([#91](https://github.com/Nowhitestar/Yulu/issues/91)) ([a8a7a7d](https://github.com/Nowhitestar/Yulu/commit/a8a7a7db04d6dc427ad5575051f301c306c2f4bc))

## [0.18.0](https://github.com/Nowhitestar/Yulu/compare/v0.17.0...v0.18.0) (2026-07-11)


### Features

* **agent:** delegate recording pipeline to Hermes ([#87](https://github.com/Nowhitestar/Yulu/issues/87)) ([62e6411](https://github.com/Nowhitestar/Yulu/commit/62e64114ec48e8471c70df1c4e616b8a7e3b17b1))

## [0.17.0](https://github.com/Nowhitestar/Yulu/compare/v0.16.1...v0.17.0) (2026-07-11)


### Features

* **ui:** apply Yulu brand system and streamline workflows ([#85](https://github.com/Nowhitestar/Yulu/issues/85)) ([5a07539](https://github.com/Nowhitestar/Yulu/commit/5a07539a83506beb2e1f91f0f23bd904b3f0b23e))

## [0.16.1](https://github.com/Nowhitestar/Yulu/compare/v0.16.0...v0.16.1) (2026-07-09)


### Bug Fixes

* **audio:** serialize recorder state ([edda3c0](https://github.com/Nowhitestar/Yulu/commit/edda3c061042eadce568f56c372d72baab2cca16))
* **ui:** preserve settings array drafts ([f4823c9](https://github.com/Nowhitestar/Yulu/commit/f4823c9eefb3f43ac9a83e23f86383e9ddd918ff))

## [Unreleased]

### Bug Fixes

* **settings:** preserve draft values when editing automation match arrays.
* **audio:** serialize recorder state and preserve resumed segment paths.

## [0.16.0](https://github.com/Nowhitestar/Yulu/compare/v0.15.0...v0.16.0) (2026-07-09)


### Features

* add Yulu HTTP MCP server ([2e6f450](https://github.com/Nowhitestar/Yulu/commit/2e6f450cdfb6947f940952738a68027243b969b1))

## [0.15.0](https://github.com/Nowhitestar/Yulu/compare/v0.14.0...v0.15.0) (2026-07-09)


### Features

* add voice input workflow and streamline agent console ([f20c585](https://github.com/Nowhitestar/Yulu/commit/f20c585d31d32b8365f4b504e8afa09f3f14f46a))


### Bug Fixes

* **stt:** use calendar attendees for speaker names ([51d095e](https://github.com/Nowhitestar/Yulu/commit/51d095ed7adb4947925b060c5370c878e6e6ce14))
* **transcription:** reuse live transcripts and glossary for summaries ([c7e7738](https://github.com/Nowhitestar/Yulu/commit/c7e7738bede80fa13290bb124ac2db78305f83f7))
* **ui:** keep recorder window in saving state after stop ([a98ed47](https://github.com/Nowhitestar/Yulu/commit/a98ed47f86220769a2446064015e16d8090826d9))

## [0.14.0](https://github.com/Nowhitestar/Yulu/compare/v0.13.0...v0.14.0) (2026-06-30)


### Features

* **stt:** support Hermes transcription provider ([a3c7c32](https://github.com/Nowhitestar/Yulu/commit/a3c7c32210efb3f1c371e7396dd172ae6d98691e))

## [0.13.0](https://github.com/Nowhitestar/Yulu/compare/v0.12.0...v0.13.0) (2026-06-26)


### Features

* **agent-console:** ship agent-native workspace ([0420ef3](https://github.com/Nowhitestar/Yulu/commit/0420ef328707f56435ca433b84835e22da35665b))

## [0.12.0](https://github.com/Nowhitestar/Yulu/compare/v0.11.4...v0.12.0) (2026-06-24)


### Features

* **ui:** add liquid glass redesign ([ca9bb04](https://github.com/Nowhitestar/Yulu/commit/ca9bb0444ec0615b65ac4a872e4768cd5cbe7908))

## [0.11.4](https://github.com/Nowhitestar/Yulu/compare/v0.11.3...v0.11.4) (2026-06-17)


### Bug Fixes

* recover recording reprocess flows ([dcad5d4](https://github.com/Nowhitestar/Yulu/commit/dcad5d42d44e243a403ca128b0e0c4f02f582437))

## [0.11.3](https://github.com/Nowhitestar/Yulu/compare/v0.11.2...v0.11.3) (2026-06-15)


### Bug Fixes

* harden dual-track post processing ([6df4d62](https://github.com/Nowhitestar/Yulu/commit/6df4d628e65e7b1c73d61ea7f1e7303a75d59ae3))
* play original recording audio by default ([d549fd8](https://github.com/Nowhitestar/Yulu/commit/d549fd8be221085ea22efd0e1547a34f369b5c1d))
* suppress delayed dual-track playback echo ([5747b3c](https://github.com/Nowhitestar/Yulu/commit/5747b3ca5e7e0f7974d351b06a3ab4847409f80e))

## [0.11.2](https://github.com/Nowhitestar/Yulu/compare/v0.11.1...v0.11.2) (2026-06-15)


### Bug Fixes

* improve echo cleanup and settings refresh ([11ee3b7](https://github.com/Nowhitestar/Yulu/commit/11ee3b7e6e8feaab548e1e4058e464e72f822a40))
* **install:** add agent-native install and uninstall plans ([#61](https://github.com/Nowhitestar/Yulu/issues/61)) ([c4fb18a](https://github.com/Nowhitestar/Yulu/commit/c4fb18a64e95212a2366cdf6c4cae199daed22c5))
* keep realtime chunks out of recordings ([33f1ce5](https://github.com/Nowhitestar/Yulu/commit/33f1ce5c3a5f30247c81d07ac0515be8026760b4))

## [Unreleased]

### Changed

* **mcp:** add token-protected Yulu HTTP MCP registration via `yulu mcp ...`; install/update now registers detected local agents non-fatally, and uninstall cleans up the Yulu MCP entry.
* **transcription:** reuse complete realtime transcripts for fast summaries, copy summary Markdown from the reader, and apply glossary canonical terms to summaries.
* **install:** add agent-readable install/uninstall plan JSON and run PKG upgrades through the provision ledger. Existing installs do not require manual migration; agents can inspect install plans with `release_installer.py install --plan --json` and uninstall plans with `yulu uninstall --dry-run --json`.

## [0.11.1](https://github.com/Nowhitestar/Yulu/compare/v0.11.0...v0.11.1) (2026-06-14)


### Bug Fixes

* prevent pkg installer postinstall hangs ([990fb14](https://github.com/Nowhitestar/Yulu/commit/990fb14acc96a3be74f3d370b80e9450df994001))

## [0.11.0](https://github.com/Nowhitestar/Yulu/compare/v0.10.7...v0.11.0) (2026-06-14)


### Features

* add AI connector integrations ([f200a37](https://github.com/Nowhitestar/Yulu/commit/f200a37e59d09b22f1c91d205ad53baa94f6144d))

## [0.10.7](https://github.com/Nowhitestar/Yulu/compare/v0.10.6...v0.10.7) (2026-06-13)


### Bug Fixes

* **doctor:** treat release installs with install metadata as healthy sources

## [0.10.6](https://github.com/Nowhitestar/Yulu/compare/v0.10.5...v0.10.6) (2026-06-13)


### Features

* **recordings:** allow one-off speaker count overrides when re-transcribing
* **release:** publish a macOS pkg installer alongside the runtime zip


### Bug Fixes

* **recording:** start realtime transcription for menu/manual recordings
* **recording:** stop realtime subscribers promptly when recordings end
* **status:** build and package the recorder floating-window helper
* **settings:** clarify realtime transcription versus post-recording processing

## [0.10.5](https://github.com/Nowhitestar/Yulu/compare/v0.10.4...v0.10.5) (2026-06-12)


### Bug Fixes

* **audio:** boost microphone capture while preserving system playback clarity
* **install:** compile the status agent during dev installs
* **recording:** allow back-to-back recordings while the previous meeting is transcribing
* **recording:** treat queued agent summaries as successful async processing
* **recordings:** defer audio player mounting for faster meeting switching

## [0.10.4](https://github.com/Nowhitestar/Yulu/compare/v0.10.3...v0.10.4) (2026-06-12)


### Bug Fixes

* **setup:** preserve macOS recording permissions during normal upgrades

## [0.10.3](https://github.com/Nowhitestar/Yulu/compare/v0.10.2...v0.10.3) (2026-06-12)


### Bug Fixes

* **setup:** reinstall yulu_ui dependencies when node_modules is incomplete or built for another Node ABI

## [0.10.2](https://github.com/Nowhitestar/Yulu/compare/v0.10.1...v0.10.2) (2026-06-12)


### Bug Fixes

* **audio:** preserve mic audio when the system audio tap stalls and serialize tap recovery
* **diarize:** reduce auto speaker over-splitting with a less-sensitive clustering default
* **recordings:** flag header-only WAV files as recording failures
* **summary:** skip broken Codex wrappers and send direct summaries an explicit summary prompt

## [0.10.1](https://github.com/Nowhitestar/Yulu/compare/v0.10.0...v0.10.1) (2026-06-11)


### Bug Fixes

* **calendar:** resolve `gog` from common Homebrew PATHs in the settings integration UI
* **health:** parse launchd state from the stable table output and show on-demand workers as idle
* **recording:** preserve crashed recording files when appending agent-queue events
* **recordings:** show recording/transcription/summary failure states and add item context actions

## [0.10.0](https://github.com/Nowhitestar/Yulu/compare/v0.9.0...v0.10.0) (2026-06-10)


### Features

* **config:** transcription.diarization.* block in config.example.json ([3db009a](https://github.com/Nowhitestar/Yulu/commit/3db009a738d292fe00a948192ecbda38814d2948))
* **diarize:** calendar-attendee prior resolution in transcribe.py ([a0c9cd9](https://github.com/Nowhitestar/Yulu/commit/a0c9cd98125e324b880afc3c8a82e0c16636adb2))
* **diarize:** config-selected diarize backend construction held off the ASR dict ([d2f3dd5](https://github.com/Nowhitestar/Yulu/commit/d2f3dd5aafc52f11943996f976686d8e29a73f73))
* **diarize:** daemon DIARIZE RPC + request_diarize client ([7c31b3e](https://github.com/Nowhitestar/Yulu/commit/7c31b3eda16b8cbaa6f71187973c04fa571ff4d8))
* **diarize:** pure N-speaker merge core + .speakers.json sidecar ([3c0f067](https://github.com/Nowhitestar/Yulu/commit/3c0f06770594487cdb7f4f32b7a8e8a4d90c7383))
* **diarize:** SherpaDiarizeBackend + DiarizeBackend protocol + model resolution ([681c48c](https://github.com/Nowhitestar/Yulu/commit/681c48c5459c388cd7b8bf6b18cebe9ffd0c5a40))
* **diarize:** speaker-count strategy -- calendar prior + reconcile (over-split fix) ([73a91ab](https://github.com/Nowhitestar/Yulu/commit/73a91ab5f364172604ac180f53633dc8f5e41006))
* **diarize:** tri-state yulu-managed probe_diarization() folded into doctor ([33f5f6e](https://github.com/Nowhitestar/Yulu/commit/33f5f6e0b563dd7799c751782b1037baa38a8d3b))
* **diarize:** wire ASR->diarize->merge into transcribe.py pipeline ([1347e1d](https://github.com/Nowhitestar/Yulu/commit/1347e1daef7b3d903e266d17ea132952ff98021a))
* **eval:** torch-free DER/WDER/SER harness + constructed-corpus + RTTM + UI-copy ([92b9049](https://github.com/Nowhitestar/Yulu/commit/92b9049de22fdad4598fd8bf8c0d93ae4bd0fac8))
* **prompts:** {{speaker_transcript}}/{{speaker_list}} summary prompt vars ([7ee94d5](https://github.com/Nowhitestar/Yulu/commit/7ee94d56c1c8a689b9d8dd7df9806c581ed95384))
* **provision:** co-locate sherpa-onnx on the daemon interpreter (cp314 verified) + engine-aware models check ([44c04d4](https://github.com/Nowhitestar/Yulu/commit/44c04d4bc0c37aa0ce2e946e09850b91846c30b6))
* **provision:** idempotent diarization ONNX model provisioning in the models step ([b1d1032](https://github.com/Nowhitestar/Yulu/commit/b1d10320f88828b994d3531e1109a4afce3ba5b6))
* **settings:** add resource provisioning actions ([886d2b1](https://github.com/Nowhitestar/Yulu/commit/886d2b1d9f83354363cb2c492319dd23bd0765e3))
* **settings:** auto-detect gog accounts ([0930499](https://github.com/Nowhitestar/Yulu/commit/0930499959987b260f034a8f6b555f57fd78a5f8))
* **settings:** explain missing capabilities ([38da715](https://github.com/Nowhitestar/Yulu/commit/38da7153147e6edbfa8fb805e07a6a847da1c22c))
* **settings:** select watched calendars from gog ([a81d924](https://github.com/Nowhitestar/Yulu/commit/a81d924ac32c7d54c074d00fbf58da983a3660bc))
* harden phase14 settings and diarization readiness ([950b22c](https://github.com/Nowhitestar/Yulu/commit/950b22c24add42b02bcb0703f4cdbacca1abd7f6))


### Bug Fixes

* **audio:** keep dual-track capture on a continuous timeline ([73be113](https://github.com/Nowhitestar/Yulu/commit/73be113e4f87b95fc5a8f63ee701be484b5bdb50))
* **audio:** restore meeting half-duplex playback mix ([dba4723](https://github.com/Nowhitestar/Yulu/commit/dba47235a57b536b3fb605110e4b4730c4136e76))
* **diarize:** count-keyed pipeline cache so per-call override can't bleed into auto ([d2a6214](https://github.com/Nowhitestar/Yulu/commit/d2a6214e89ab94e7932a740b9aa6ccc68018293c))
* **diarize:** install soundfile with sherpa runtime ([5abfced](https://github.com/Nowhitestar/Yulu/commit/5abfced7e7337b8a8c70f53ff5a202efb59e6008))
* **recording:** resume interrupted captures and clean playback ([501d12f](https://github.com/Nowhitestar/Yulu/commit/501d12f365b47449586a10c1ec8820ff556098a0))
* **release:** grant tag publish workflow attestation permissions
* **ui:** improve mobile responsive layouts ([c7286f5](https://github.com/Nowhitestar/Yulu/commit/c7286f55e5b9356a7a4dc1fd70721376a1c42e23))

## [0.9.0](https://github.com/Nowhitestar/Yulu/compare/v0.8.0...v0.9.0) (2026-06-07)


### Features

* **settings:** 3-column MasterDetail settings UI + full section editing + app-wide i18n (P1–P4) ([#50](https://github.com/Nowhitestar/Yulu/issues/50)) ([98c6e31](https://github.com/Nowhitestar/Yulu/commit/98c6e312855a179eca0a153afa437d86bd305d91))
* **settings:** declarative registry + config-write correctness (P0) ([#49](https://github.com/Nowhitestar/Yulu/issues/49)) ([f1b53c9](https://github.com/Nowhitestar/Yulu/commit/f1b53c9333833168dbbc88fd5dbc516c9bf3b165))

## [0.8.0](https://github.com/Nowhitestar/Yulu/compare/v0.7.0...v0.8.0) (2026-06-05)


### ⚠ BREAKING CHANGES

* voicemail is removed; every recording is a meeting. The Cmd+Shift+V mic-only hotkey, the voicemail-todos prompt, and the voicemails/ directory no longer exist. Existing voicemail_* recordings are renamed voicemail_* → Memo_* by an automatic migration on upgrade.

### Features

* remove voicemail entirely, unify into meeting ([#46](https://github.com/Nowhitestar/Yulu/issues/46)) ([5030f4c](https://github.com/Nowhitestar/Yulu/commit/5030f4c75b7cdfa05f9ec8b87ce05c716b14236e))

## [0.7.0](https://github.com/Nowhitestar/Yulu/compare/v0.6.0...v0.7.0) (2026-06-05)


### Features

* **ui:** recordings reader — markdown summary, transcript dedup, rename/tags/delete, real status ([#44](https://github.com/Nowhitestar/Yulu/issues/44)) ([8aace30](https://github.com/Nowhitestar/Yulu/commit/8aace308188569a43054234ea6380348d51e366c))


### Bug Fixes

* **audio:** self-heal stuck sys-tap so meetings start after a voicemail ([#43](https://github.com/Nowhitestar/Yulu/issues/43)) ([9aff28f](https://github.com/Nowhitestar/Yulu/commit/9aff28f20b0c4d247a587c23a7e2c86859486adc))
* make realtime transcription robust for arbitrarily-long recordings ([#42](https://github.com/Nowhitestar/Yulu/issues/42)) ([f05e641](https://github.com/Nowhitestar/Yulu/commit/f05e6418c4c963c526e6e494166eab49c126a4d1))
* repair 10 fresh-user-facing bugs in the v0.6.0 release ([#41](https://github.com/Nowhitestar/Yulu/issues/41)) ([53fa35c](https://github.com/Nowhitestar/Yulu/commit/53fa35cbf725cbd68805ab196379f6b3ead27e5a))

## [0.6.0](https://github.com/Nowhitestar/Yulu/compare/v0.5.2...v0.6.0) (2026-06-01)


### Features

* agent-native provisioning & cross-platform foundation (v0.5 milestone) ([#37](https://github.com/Nowhitestar/Yulu/issues/37)) ([b18164d](https://github.com/Nowhitestar/Yulu/commit/b18164d99ba1b323b826277cb42202497aebb972))

## [0.5.2](https://github.com/Nowhitestar/Yulu/compare/v0.5.1...v0.5.2) (2026-05-29)


### Bug Fixes

* stabilize meeting-detector signature; persistent record dialog ([#35](https://github.com/Nowhitestar/Yulu/issues/35)) ([61ed4a9](https://github.com/Nowhitestar/Yulu/commit/61ed4a93891b45e005c107bf3b432d2d6eae4882))

## [0.5.1](https://github.com/Nowhitestar/Yulu/compare/v0.5.0...v0.5.1) (2026-05-29)


### Bug Fixes

* restore exec bits on release extract; harden setup & packaging ([#31](https://github.com/Nowhitestar/Yulu/issues/31)) ([82b0ab2](https://github.com/Nowhitestar/Yulu/commit/82b0ab26ed4c893dd0e8578bd254f8ef918b4c25))

## [Unreleased]

### Fixed
- **Release installs lost Unix executable bits.** `release_installer.py` used `ZipFile.extractall()`, which does not restore the mode stored in each entry's `external_attr` — every file (including the `Yulu.app` / `StatusAgent.app` Mach-O binaries launchd spawns directly) landed as `0644`, so the menu-bar agent and audio daemon failed with "Launchd job spawn failed" on a fresh install. The installer now re-applies each entry's recorded permission bits after extraction.
- **`setup.sh` aborted under non-interactive stdin.** The optional agent-skill registration `read` returned non-zero at EOF and, under `set -e`, failed the whole run — which triggered an install rollback. The `read`s now tolerate EOF.
- **`setup.sh` self-heals `.app` exec bits.** `chmod +x` is re-asserted on the bundled binaries before launch, so existing installs recover on `yulu update` even when extracted by an older installer.

### Changed
- **Packaging hardening.** `package.sh` re-asserts `+x` on git-executable files in the staged tree before zipping, so release archives carry correct modes even if the source checkout's permission bits drift.

## [0.5.0] - 2026-05-29

### Added
- **Yulu web UI** — a unified localhost interface at `http://127.0.0.1:7777`: recordings inbox + reader (audio player, transcript, summary, re-transcribe/re-generate), single Settings page (Audio / Transcription / LLM / Hotkey & UI / Integrations / Storage), Knowledge (Prompts + Glossary), Health (daemons + logs), and a ⌘K global search. Served by a Node + Hono + tRPC server (`com.yulu.ui` LaunchAgent); `yulu logs ui` tails it.
- **Voicemail realtime transcription** with a global Settings toggle (`transcription.realtime_enabled`, default on). On stop the live transcript is promoted to the final transcript; an empty/missing realtime transcript falls back to whole-file transcription.
- Central version management via the root `VERSION` file and `yulu/scripts/version.py`; `yulu version` now prints the installed version plus git metadata for support/debugging.
- Release-asset based installer/updater (`yulu update [--latest|--version vX.Y.Z|--dev]`) with sha256-verified packages.
- Packaging scripts and a tag-triggered GitHub Actions workflow for `yulu-macos-arm64-<version>.zip`, `install.sh`, and `checksums.txt`.
- MLX transcription `final_model` and `preprocess_audio` options.

### Changed
- Default MLX model is now `mlx-community/whisper-large-v3-turbo`.
- Rewrote the meeting summary template to a concise, action-oriented format (一句话结论 / 重点 / 下步动作).
- Default install/update path from main checkout to stable release assets.
- Upgraded build/test tooling — vite 6, vitest 3, esbuild 0.25 — clearing dev-tooling security advisories (production serves a prebuilt static bundle and is unaffected).

### Fixed
- `read_realtime_transcript` now ignores agent-event JSON payloads (treats them as "no transcript" and falls back to whole-file transcription).
- Removed the vestigial `audio.realtime_transcribe` config default; `transcription.realtime_enabled` is the single source of truth (legacy key still honored as a fallback).

## [0.4.0] - 2026-05-08

### Fixed
- `install.sh`: `[[ -e /dev/tty ]]` could be true while the device wasn't actually openable (CI runners, sandboxed agents, certain SSH sessions), causing the install to bail with `/dev/tty: Device not configured` before `setup.sh` ever ran. Now we cascade through `[[ -t 0 ]]` (stdin already a tty) → `(exec 3</dev/tty) 2>/dev/null` (try to open it for real) → `< /dev/null` (truly non-interactive, fall back to defaults). First shipped as a hotfix to `v0.3.0`.
- **`Yulu.app` no longer triggers the macOS "screen recording in progress" indicator while idle.** Previously the daemon opened an `SCStream` 1 second after launch and kept it alive forever (writing samples only while `recording=true`, but the stream itself counts as "in use" to macOS). The menu-bar purple dot stayed on permanently. Now the daemon only probes the TCC permission at startup (open → immediately stop), and re-opens the `SCStream` only when a recording actually begins. Same change for the microphone engine — the orange dot also clears when idle. Recording-start latency goes from <100 ms to roughly 4 s on cold start (the first `SCShareableContent.current` + `SCStream` init are slow); subsequent starts within the same daemon process are faster. The user-visible "Recording started" message now appears only when the stream is actually ready to receive samples.
- `AudioCapture.startCapture()` and `stopCapture()` are now synchronous (block on a `DispatchSemaphore` until the underlying `SCStream` Task transitions). Without this, a fast stop after start could see `stream==nil` and no-op, then the start Task would finish AFTER the stop and leave the stream alive — the macOS recording indicator stayed on after the user clicked stop.
- `SocketServer` `stop` action no longer fires `onRecordingStop` when the recorder wasn't actually running. Previously a spurious `stop` (e.g. client retry after `start_failed`) logged fake "Sys capture idle" / "Mic idle" lines.
- `setup.sh --upgrade` fast-path (when `sysReady=true` is already cached) now `pkill -9` the daemon and lets `launchd` `KeepAlive` respawn the freshly built binary. Previously `launchctl unload` of an `open -W Yulu.app` job killed only the `open` wrapper, not the LSUIElement child process — so `yulu update` shipped code changes that never actually ran until the user rebooted. TCC state is preserved (no `tccutil reset` in the fast-path).

### Changed
- `setup.sh` now runs `tccutil reset ScreenCapture com.yulu.audiodaemon` and `tccutil reset Microphone com.yulu.audiodaemon` before relaunching `Yulu.app` on the first-grant path (after stopping the running daemon). This guarantees macOS shows the permission dialog instead of silently honoring a previously-denied state. If you'd accidentally clicked "Don't Allow" the first time around, you no longer have to dig into System Settings to recover — re-running setup is enough. Already-granted users on the upgrade fast-path don't see a re-prompt.

## [0.3.0] - 2026-05-08

### Added
- **One-line installer**: `curl -fsSL https://raw.githubusercontent.com/Nowhitestar/Yulu/main/install.sh | bash`. The installer pre-flights macOS / Xcode CLI / git, clones to `~/.yulu/` (a stable path), then hands off to `setup.sh`. If a previous installation is detected (any `com.yulu.*` LaunchAgent in `~/Library/LaunchAgents/`), it runs in `--upgrade` mode automatically.
- **`yulu` CLI** (`yulu/scripts/yulu`, symlinked to `~/.local/bin/yulu` by setup): single command surface for `setup`, `update`, `uninstall`, `start`, `stop`, `restart`, `status`, `logs`, `record start/stop`, `where`. Symlink-resolved so the CLI keeps working even if the repo path changes.
- **`setup.sh --upgrade` mode**: idempotent re-run. Skips already-granted TCC, already-authed Google OAuth, already-downloaded whisper model, already-existing config. Used by `yulu update` and the installer's auto-detect.
- **`yulu/scripts/uninstall.sh`** (`yulu uninstall`): stops services, removes LaunchAgents and the CLI; prompts before deleting recordings, config, or registered agent skills; prints the manual-cleanup pointers for TCC and Homebrew packages.
- **whisper.cpp model download in setup**: a new step lets the user pick `base` / `small` / `medium` / `large-v3-q5_0` / `large-v3` (default `large-v3-q5_0`, ~1.1 GB), downloads to `~/.config/yulu/models/`, and writes the explicit `whisper-cli -m …` command into `config.json` so transcription works on first use. Previously users hit a missing-model failure on their first meeting.
- **Yulu now ships as an [open agent skill](https://github.com/vercel-labs/skills)**. `skills/yulu/SKILL.md` documents the verbs Yulu exposes (start / stop / status / fulfill `summary_request` / find a past meeting) so any agent in the `vercel-labs/skills` ecosystem (Claude Code, OpenClaw, Codex, Cursor, and 50+ others) can drive Yulu from natural language. Install with `npx skills add Nowhitestar/Yulu -g -a claude-code -a openclaw -y`; `setup.sh` offers to do it for you. The skill is a thin contract — `setup.sh` is still required for the macOS app, launchd services, and whisper.cpp install.

### Changed
- **Default recording directory is now `~/Movies/Yulu/`** instead of `<repo>/meeting-recordings/`. New installs get `~/Movies/Yulu`; existing installs honor whatever `audio.output_dir` was already set to in `config.json`. This decouples the recordings from the repo clone — moving or deleting `~/.yulu/` no longer takes your meeting history with it.
- **`setup.sh` no longer clears the terminal** on launch — the user's `cd` history and pre-install context are preserved for debugging.
- **`Yulu.app` quarantine attribute is stripped after build** (`xattr -dr com.apple.quarantine`) so the ad-hoc-signed bundle launches without the silent Gatekeeper block that LSUIElement apps swallow.
- Test step labels in `run_tests` are now consistent (`1/4` … `4/4`).
- The "Python 3.14" suggestion in `check_system` is now just `brew install python` (3.14 was a moving target).

### Removed
- The legacy `git clone … && cd Yulu && bash yulu/scripts/setup.sh` instruction in both READMEs is replaced by the one-line installer. Manual setup is still documented for hackers, but the headline path is now `curl … | bash`.

## [0.2.0] - 2026-05-08

### Changed
- Renamed the audio daemon bundle path from `yulu/scripts/AudioDaemon.app` to `yulu/scripts/Yulu.app` so that System Settings, Activity Monitor, the Dock, and TCC prompts identify the app as **Yulu** end-to-end. The `audio_daemon` executable name, `com.yulu.audiodaemon` bundle id, `com.yulu.audiodaemon` LaunchAgent label, and `~/.config/yulu/audio_daemon.sock` socket path are unchanged — TCC permissions granted in 0.1.0 are preserved.
- User-facing log messages, setup prompts, and documentation now refer to "Yulu" instead of "AudioDaemon" wherever the user is the audience. Internal identifiers (`audio_daemon` binary, `com.yulu.audiodaemon` bundle id, socket name) are deliberately kept.

### Removed
- `yulu/scripts/migrate_to_yulu.sh` and the "Upgrading from `meeting-assistant`" section of both READMEs. The pre-rename `meeting-assistant` codename never had a public release, so there are no installs in the wild that need migrating off it. The `setup.sh` legacy-install detector that prompted users to run the migration script is also gone.
- `assets/demos/README.md` placeholder — the four demo screenshots it described were committed in 0.1.0, so the placeholder is no longer needed.

## [0.1.0] - 2026-05-07

### Added
- Initial public release as **Yulu** (语录).
- Native macOS recording via `ScreenCaptureKit` (system audio) + `AVFoundation` (microphone), no BlackHole required.
- Signed `Yulu.app` Unix-socket controller.
- Half-duplex mixing: prioritize system audio, fade to microphone during system silence.
- Floating recording status window with a manual stop button.
- Local transcription via `whisper.cpp` (`whisper-cli`).
- Agent-queue-based summarization: any agent (Claude Code, Codex, OpenClaw…) can consume `agent-queue.json` and write back `summary.md` from `summary_template.md`.
- Optional bring-your-own-LLM external command path in `transcribe.py`.
- Google Calendar integration via `gog` with refresh tokens stored in macOS Keychain.
- Window-based meeting detection for Zoom, Tencent Meeting, Google Meet, Feishu/Lark, WeChat calls, and browser meetings.
- LaunchAgent definitions for scheduler, detector, calendar, and audio daemons.

### Changed (breaking)
- Project renamed from `meeting-assistant` to **Yulu** for the public release.
  - Repository directory: `meeting-assistant/` → `yulu/`
  - User config dir: `~/.config/meeting-assistant/` → `~/.config/yulu/`
  - LaunchAgent labels: `com.meetingassistant.*` → `com.yulu.*`
  - AudioDaemon bundle id: `com.meetingassistant.audiodaemon` → `com.yulu.audiodaemon`
  - Skill package: `meeting-assistant.skill` → `yulu.skill`
  - Code-signing env var: `MEETING_ASSISTANT_CODESIGN_IDENTITY` → `YULU_CODESIGN_IDENTITY`
- Existing users: run `bash yulu/scripts/migrate_to_yulu.sh` once before re-running `setup.sh`. The bundle-id change means macOS will prompt for Microphone and Screen & System Audio Recording permissions again — that is expected.

### Removed
- Hardcoded personal Apple Developer email in `build_audio_daemon.sh`. Code-signing now defaults to "Developer ID Application" → "Apple Development" → ad-hoc, all auto-detected.

### Security
- Removed all hardcoded Google OAuth secrets from the repository history.
- `.gitignore` blocks `config.json`, `client_secret*.json`, `credentials*.json`, `token*.json`, and local recordings by default.

[Unreleased]: https://github.com/Nowhitestar/Yulu/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/Nowhitestar/Yulu/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Nowhitestar/Yulu/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Nowhitestar/Yulu/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Nowhitestar/Yulu/releases/tag/v0.1.0
