# Changelog

All notable changes to Yulu are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.19.0](https://github.com/Nowhitestar/Yulu/compare/v0.18.1...v0.19.0) (2026-07-11)


### ⚠ BREAKING CHANGES

* voicemail is removed; every recording is a meeting. The Cmd+Shift+V mic-only hotkey, the voicemail-todos prompt, and the voicemails/ directory no longer exist. Existing voicemail_* recordings are renamed voicemail_* → Memo_* by an automatic migration on upgrade.
* rename AudioDaemon.app bundle to Yulu.app
* bundle id, config path, LaunchAgent labels, and skill package name all changed. Existing users must run the bundled migration script before re-installing.

### Features

* add AI connector integrations ([f200a37](https://github.com/Nowhitestar/Yulu/commit/f200a37e59d09b22f1c91d205ad53baa94f6144d))
* add configurable transcription and versioning ([a2f0715](https://github.com/Nowhitestar/Yulu/commit/a2f071593803cc7eda173bc5129a94bcdeb73e4a))
* add local agent queue worker ([ee17160](https://github.com/Nowhitestar/Yulu/commit/ee171601cd9e756361460ddc40c5b4e31c257ac6))
* add local meeting detection trigger ([ccc3cf2](https://github.com/Nowhitestar/Yulu/commit/ccc3cf2644d0a67a891cd265f4af6956d84c20d5))
* add voice input workflow and streamline agent console ([f20c585](https://github.com/Nowhitestar/Yulu/commit/f20c585d31d32b8365f4b504e8afa09f3f14f46a))
* add Yulu HTTP MCP server ([2e6f450](https://github.com/Nowhitestar/Yulu/commit/2e6f450cdfb6947f940952738a68027243b969b1))
* **agent_queue_worker:** fire voicemail completion notification (voicemail-todos only) ([4071aac](https://github.com/Nowhitestar/Yulu/commit/4071aacd4da174954a556b26d242bf17e94897b4))
* **agent_queue_worker:** single LLM dispatcher with PromptsCache + SummariesRepo ([1d3761e](https://github.com/Nowhitestar/Yulu/commit/1d3761e9a42ca14925278dde5ffc75d66c3557ca))
* **agent_queue_worker:** write pid file at startup for SIGHUP routing ([a5b24ed](https://github.com/Nowhitestar/Yulu/commit/a5b24edf23ea58b9fe62062f1c8055c765e633e4))
* **agent-console:** ship agent-native workspace ([0420ef3](https://github.com/Nowhitestar/Yulu/commit/0420ef328707f56435ca433b84835e22da35665b))
* agent-native provisioning & cross-platform foundation (v0.5 milestone) ([#37](https://github.com/Nowhitestar/Yulu/issues/37)) ([b18164d](https://github.com/Nowhitestar/Yulu/commit/b18164d99ba1b323b826277cb42202497aebb972))
* **agent:** delegate recording pipeline to Hermes ([#87](https://github.com/Nowhitestar/Yulu/issues/87)) ([62e6411](https://github.com/Nowhitestar/Yulu/commit/62e64114ec48e8471c70df1c4e616b8a7e3b17b1))
* **audio_daemon:** accept silence_seconds in start action (resets to default when omitted) ([fb4d508](https://github.com/Nowhitestar/Yulu/commit/fb4d50803cc2e2480fee8f782fd70cb15533ec1c))
* **audio_daemon:** emit 'Yulu DualTrack v1' RIFF INFO marker in WAV header ([70071f9](https://github.com/Nowhitestar/Yulu/commit/70071f988d3257dfd03ff2cfd26819f8ef9bb541))
* **audio_daemon:** per-channel silence detection + drop orphaned mixing constants ([5a029e0](https://github.com/Nowhitestar/Yulu/commit/5a029e0b23061b65cb9be0447ba608b6f4336cb0))
* **audio_daemon:** replace halfDuplexMix with source-separated channelInterleave ([bde993f](https://github.com/Nowhitestar/Yulu/commit/bde993fd66e584e07cb81d382e3f1f6433d731f4))
* **audio_daemon:** SYS_DISABLED knob for mic-only recording mode ([77bd419](https://github.com/Nowhitestar/Yulu/commit/77bd4194ecda2fd26be0e8e5b8ceaca5667981b0))
* brand AudioDaemon as Yulu — icon, display name, notification sender ([8c8b69c](https://github.com/Nowhitestar/Yulu/commit/8c8b69cae717f5f95ae51cfd06915edccb09d18a))
* calendar sync + cloudflared tunnel + Google Calendar push notifications ([40ade64](https://github.com/Nowhitestar/Yulu/commit/40ade64dfb54f1e4a95ea7e73de7eaa606b796cd))
* carry over fixes and realtime transcription from main into yulu/ ([1e23119](https://github.com/Nowhitestar/Yulu/commit/1e23119e8e0023a9d2473997e495c92fb6ac0ce5))
* **config:** add transcription.realtime_enabled (no daemon restart) ([5a18900](https://github.com/Nowhitestar/Yulu/commit/5a18900f78b3c7390c126675b65457ac65022e62))
* **config:** transcription.diarization.* block in config.example.json ([3db009a](https://github.com/Nowhitestar/Yulu/commit/3db009a738d292fe00a948192ecbda38814d2948))
* **diarize:** calendar-attendee prior resolution in transcribe.py ([a0c9cd9](https://github.com/Nowhitestar/Yulu/commit/a0c9cd98125e324b880afc3c8a82e0c16636adb2))
* **diarize:** config-selected diarize backend construction held off the ASR dict ([d2f3dd5](https://github.com/Nowhitestar/Yulu/commit/d2f3dd5aafc52f11943996f976686d8e29a73f73))
* **diarize:** daemon DIARIZE RPC + request_diarize client ([7c31b3e](https://github.com/Nowhitestar/Yulu/commit/7c31b3eda16b8cbaa6f71187973c04fa571ff4d8))
* **diarize:** pure N-speaker merge core + .speakers.json sidecar ([3c0f067](https://github.com/Nowhitestar/Yulu/commit/3c0f06770594487cdb7f4f32b7a8e8a4d90c7383))
* **diarize:** SherpaDiarizeBackend + DiarizeBackend protocol + model resolution ([681c48c](https://github.com/Nowhitestar/Yulu/commit/681c48c5459c388cd7b8bf6b18cebe9ffd0c5a40))
* **diarize:** speaker-count strategy — calendar prior + reconcile (over-split fix) ([73a91ab](https://github.com/Nowhitestar/Yulu/commit/73a91ab5f364172604ac180f53633dc8f5e41006))
* **diarize:** tri-state yulu-managed probe_diarization() folded into doctor ([33f5f6e](https://github.com/Nowhitestar/Yulu/commit/33f5f6e0b563dd7799c751782b1037baa38a8d3b))
* **diarize:** wire ASR-&gt;diarize-&gt;merge into transcribe.py pipeline ([1347e1d](https://github.com/Nowhitestar/Yulu/commit/1347e1daef7b3d903e266d17ea132952ff98021a))
* **doctor:** add stt_daemon health checks (socket, pid, vocab, model) ([8886d72](https://github.com/Nowhitestar/Yulu/commit/8886d72582426a6040a029467260fb609fbfd727))
* **doctor:** check_yulu_ui — dist artifacts + plist + /healthz + log ([a3872fa](https://github.com/Nowhitestar/Yulu/commit/a3872fabb5723818e906e71167ba3ccb08dae992))
* **eval:** torch-free DER/WDER/SER harness + constructed-corpus + RTTM + UI-copy ([92b9049](https://github.com/Nowhitestar/Yulu/commit/92b9049de22fdad4598fd8bf8c0d93ae4bd0fac8))
* harden phase14 settings and diarization readiness ([950b22c](https://github.com/Nowhitestar/Yulu/commit/950b22c24add42b02bcb0703f4cdbacca1abd7f6))
* interactive setup script (setup.sh) ([7749c8f](https://github.com/Nowhitestar/Yulu/commit/7749c8fdb89cb5320c8cf0589b1c3f6288ce8c75))
* **live_session:** stride extraction params for single-WAV dual tail ([81c2deb](https://github.com/Nowhitestar/Yulu/commit/81c2deb3139ffc449d03d700a56f4b33b85bf2c8))
* **live_session:** tail loop reads alternating samples from single stereo WAV ([fcb8230](https://github.com/Nowhitestar/Yulu/commit/fcb82305dc322f7a14f37752ec1863638af9816b))
* LMS 自适应回声消除 (echo_cancel.py) ([86241e1](https://github.com/Nowhitestar/Yulu/commit/86241e137d7affadb710d4dfbd2e78ce743bb265))
* **meeting_daemon:** acquire recording lock before scheduled/detector start ([78eb12f](https://github.com/Nowhitestar/Yulu/commit/78eb12ff4941340f59445a11861b661b00c79b57))
* one-line install + yulu CLI + idempotent upgrade ([f5ff0c0](https://github.com/Nowhitestar/Yulu/commit/f5ff0c013e09ead443670a1f38cd055c3dddaf76))
* one-line install + yulu CLI + idempotent upgrade ([9be99b0](https://github.com/Nowhitestar/Yulu/commit/9be99b00e9546ed812a36bbe2f0f0a30b9928b4d))
* package Yulu as an open agent skill (npx skills add) ([00c1e0f](https://github.com/Nowhitestar/Yulu/commit/00c1e0f1f76697758fd8706f1dc2ccac3c5f7d50))
* package Yulu as an open agent skill (npx skills add) ([4b616ff](https://github.com/Nowhitestar/Yulu/commit/4b616ffdef06e37fe066f6652c75ae211551c96a))
* **prompts:** {{speaker_transcript}}/{{speaker_list}} summary prompt vars ([7ee94d5](https://github.com/Nowhitestar/Yulu/commit/7ee94d56c1c8a689b9d8dd7df9806c581ed95384))
* **prompts:** add {{my_transcript}} / {{their_transcript}} template vars ([38d5961](https://github.com/Nowhitestar/Yulu/commit/38d5961b023ef65e378716374e9b55a960dac2c6))
* **prompts:** add Category.VOICEMAIL + lazy CHECK migration ([272f266](https://github.com/Nowhitestar/Yulu/commit/272f2662de387f1081ce90ff63aeb9b1d5b2d0f9))
* **prompts:** add frozen seed snapshots + idempotent seeder ([4f394d4](https://github.com/Nowhitestar/Yulu/commit/4f394d4bbcca14729f8d0dce8ece1aedb750bda3))
* **prompts:** add PromptsCache + resolve_meeting_date helper ([fabd1a1](https://github.com/Nowhitestar/Yulu/commit/fabd1a184f58df5f17967c2d152f8e4f4b0001ee))
* **prompts:** add PromptsRepo + SummariesRepo with sqlite schema ([53907df](https://github.com/Nowhitestar/Yulu/commit/53907df72ea335abb4189a8f135e7df7de116038))
* **prompts:** add yulu prompts CLI ([f9c5083](https://github.com/Nowhitestar/Yulu/commit/f9c5083cefb4332c5ad3106db1dae3ad087b9e4b))
* **prompts:** add yulu summaries reader CLI ([7e24f77](https://github.com/Nowhitestar/Yulu/commit/7e24f77b19b5654a8d37892bc8201f821d786dd9))
* **prompts:** seed action-items-by-speaker (opt-in, uses speaker vars) ([751c7b0](https://github.com/Nowhitestar/Yulu/commit/751c7b0a11778307a3862ea73967c3e7a7e76d05))
* **prompts:** seed voicemail-todos + voicemail-clean prompts ([8c72bde](https://github.com/Nowhitestar/Yulu/commit/8c72bdebee08e2744058620d1d0e2074a0ea7538))
* **provision:** co-locate sherpa-onnx on the daemon interpreter (cp314 verified) + engine-aware models check ([44c04d4](https://github.com/Nowhitestar/Yulu/commit/44c04d4bc0c37aa0ce2e946e09850b91846c30b6))
* **provision:** idempotent diarization ONNX model provisioning in the models step ([b1d1032](https://github.com/Nowhitestar/Yulu/commit/b1d10320f88828b994d3531e1109a4afce3ba5b6))
* **record_audio:** acquire recording lock before manual start ([73e0a62](https://github.com/Nowhitestar/Yulu/commit/73e0a62d3b764a93b5d9b93610a5fa91802fc8cf))
* **recording_lock:** add flock-based recording-start mutex ([b57e6f8](https://github.com/Nowhitestar/Yulu/commit/b57e6f83225fcc75e90760de590ddcd9f66971e5))
* remove voicemail entirely, unify into meeting ([#46](https://github.com/Nowhitestar/Yulu/issues/46)) ([5030f4c](https://github.com/Nowhitestar/Yulu/commit/5030f4c75b7cdfa05f9ec8b87ce05c716b14236e))
* resident stt_daemon + vocab SQLite (Yulu architecture refresh) ([d2a4703](https://github.com/Nowhitestar/Yulu/commit/d2a47032837617c9804872a25b69b0e2cb305f05))
* ScreenCaptureKit audio daemon (replaces BlackHole + SoX) ([85962ef](https://github.com/Nowhitestar/Yulu/commit/85962ef3201f8a2ed41a6b7541c3a596e6fea33b))
* ScreenCaptureKit audio daemon with mic capture + half-duplex mixing ([8243af3](https://github.com/Nowhitestar/Yulu/commit/8243af39d3ad40564a3b75e68534e0e973269669))
* **search:** scaffolding + parse_stem + init_db ([931e13c](https://github.com/Nowhitestar/Yulu/commit/931e13c321ee515386e41e99ba28027592041151))
* **search:** setup.sh bootstrap + yulu doctor integration ([ef25cd2](https://github.com/Nowhitestar/Yulu/commit/ef25cd2be97bb6825f899977dfdeea6249322854))
* **search:** sweep + FTS5/LIKE search() + reindex/doctor ([25ebcdf](https://github.com/Nowhitestar/Yulu/commit/25ebcdfa3dbb739a4095d95988378ca3cb180f35))
* **search:** writer hooks for transcripts + summaries ([3951a1a](https://github.com/Nowhitestar/Yulu/commit/3951a1a9e562db2c0d3aa827afdec67202ca0e23))
* **search:** yulu search CLI with IPC + in-process fallback ([7258be7](https://github.com/Nowhitestar/Yulu/commit/7258be7171c554ba5eeae486ee81f1ccead472c0))
* **settings:** 3-column MasterDetail settings UI + full section editing + app-wide i18n (P1–P4) ([#50](https://github.com/Nowhitestar/Yulu/issues/50)) ([98c6e31](https://github.com/Nowhitestar/Yulu/commit/98c6e312855a179eca0a153afa437d86bd305d91))
* **settings:** add resource provisioning actions ([886d2b1](https://github.com/Nowhitestar/Yulu/commit/886d2b1d9f83354363cb2c492319dd23bd0765e3))
* **settings:** auto-detect gog accounts ([0930499](https://github.com/Nowhitestar/Yulu/commit/0930499959987b260f034a8f6b555f57fd78a5f8))
* **settings:** declarative registry + config-write correctness (P0) ([#49](https://github.com/Nowhitestar/Yulu/issues/49)) ([f1b53c9](https://github.com/Nowhitestar/Yulu/commit/f1b53c9333833168dbbc88fd5dbc516c9bf3b165))
* **settings:** explain missing capabilities ([38da715](https://github.com/Nowhitestar/Yulu/commit/38da7153147e6edbfa8fb805e07a6a847da1c22c))
* **settings:** realtime transcription toggle in Transcription section ([ca12535](https://github.com/Nowhitestar/Yulu/commit/ca12535f6788e70d757a7ed4c10253810ae0c9ea))
* **settings:** select watched calendars from gog ([a81d924](https://github.com/Nowhitestar/Yulu/commit/a81d924ac32c7d54c074d00fbf58da983a3660bc))
* **setup:** build + install yulu_ui (Node 20+ guard, idempotent npm ci, healthz verify) ([b0c0c4b](https://github.com/Nowhitestar/Yulu/commit/b0c0c4b2003edb093774b4d23389e12ee8ba3799))
* **setup:** seed transcription.realtime_enabled=true in default config ([b98aa45](https://github.com/Nowhitestar/Yulu/commit/b98aa45fba88e1400e6e69a8cd6d6c73630cdc72))
* **status_agent:** add config block + hotkey parser + Carbon keycode tables ([aa862d1](https://github.com/Nowhitestar/Yulu/commit/aa862d12c67a5f049ee578231f4c1a7080d2dec5))
* **status_agent:** add launchd plist template ([b4e7e24](https://github.com/Nowhitestar/Yulu/commit/b4e7e247f498f4aad729811eb21c83d2452ab997))
* **status_agent:** add yulu status-agent CLI (install/enable/disable/status/set-hotkey) ([9cbeaa0](https://github.com/Nowhitestar/Yulu/commit/9cbeaa0cc56186a69add1f2a5a7d4da32e26ca66))
* **status_agent:** build script + skeleton Cocoa app (NSStatusItem placeholder) ([670b387](https://github.com/Nowhitestar/Yulu/commit/670b3871ee7caf154c89ff7f3759cafddf5cb225))
* **status_agent:** Carbon RegisterEventHotKey + SIGHUP re-registration ([21c72fe](https://github.com/Nowhitestar/Yulu/commit/21c72fe2a7cc27fdfaddafd8cf7ff6ad19c14691))
* **status_agent:** daemon poller + 5-state machine (idle/recording/processing/meeting_busy/daemon_down) ([e5436b8](https://github.com/Nowhitestar/Yulu/commit/e5436b86cdedec0e624210d2743fa24df6c59f3d))
* **status_agent:** IPC search action + python helper ([eb5ef6f](https://github.com/Nowhitestar/Yulu/commit/eb5ef6f0f1eb0e5886ec66c54b519360339fd37b))
* **status_agent:** NSMenu with Recent Voicemails submenu + Open Inbox handler ([d840c02](https://github.com/Nowhitestar/Yulu/commit/d840c02042bb5b623b1ebc373c7ba35866c6ff11))
* **status_agent:** socket IPC + main-thread fixes ([566cc7b](https://github.com/Nowhitestar/Yulu/commit/566cc7b2deb4be7039d864c722885946c3a1930f))
* **status_agent:** template-mode PNG icons + NSImage state rendering ([330ec85](https://github.com/Nowhitestar/Yulu/commit/330ec85744d3ffa1113953d04cc3cc205259703c))
* **status_agent:** VoicemailLauncher + real toggle behavior (idle→recording→processing→idle) ([7348642](https://github.com/Nowhitestar/Yulu/commit/734864274620d82a60a7998a37e67958d47f70ab))
* **statusagent:** menu sync to recordings + open web inbox + CI compile ([07bdc88](https://github.com/Nowhitestar/Yulu/commit/07bdc88c33d5cb1617401b9ebc5b41ea85096edf))
* **stt_daemon:** add channel_split field to TranscribeRequest ([1a10d5b](https://github.com/Nowhitestar/Yulu/commit/1a10d5b31a7c92e290199789ea8ded2e039acc82))
* **stt_daemon:** add launchd plist + dev_install + setup.sh integration ([5eda6ad](https://github.com/Nowhitestar/Yulu/commit/5eda6add1caf45e49ccd0663329b26e4c4236dba))
* **stt_daemon:** add LiveSessionManager with tail loop + persistence + crash-recovery hook ([551a81d](https://github.com/Nowhitestar/Yulu/commit/551a81d4cf2bec6d95fb6c6dc8e01da8b5e84aee))
* **stt_daemon:** add mlx-whisper backend with lazy load + resident model ([f0df3ba](https://github.com/Nowhitestar/Yulu/commit/f0df3ba646620e2b23ae8cefa87e772852fb60fc))
* **stt_daemon:** add package scaffold, protocol codec, json logger, pytest markers ([b0a9e09](https://github.com/Nowhitestar/Yulu/commit/b0a9e0905ea264c96853c9cbdee39ccc0d300d0d))
* **stt_daemon:** add STTBackend Protocol, MockSTTBackend, STTRuntime with self-reset ([09529a9](https://github.com/Nowhitestar/Yulu/commit/09529a9e3e9e49820719a2e94475a90a9f53b112))
* **stt_daemon:** add STTScheduler with two-slot priority queue + cancellation + live_chunk cap ([04866d6](https://github.com/Nowhitestar/Yulu/commit/04866d686caefe3c019b7da263c46efd34151ddc))
* **stt_daemon:** add transcript_merge for speaker-tagged ordered merge ([c9315ce](https://github.com/Nowhitestar/Yulu/commit/c9315cea7adb111c24abfaa0c321f542bf51eae6))
* **stt_daemon:** add VocabCache with prompt injection + replacement pass ([19cc5d9](https://github.com/Nowhitestar/Yulu/commit/19cc5d9a71919ff09d019748420ab43714937554))
* **stt_daemon:** add WavLayout classifier for dual-track detection ([2adcccd](https://github.com/Nowhitestar/Yulu/commit/2adcccd87f9e94aad6d8c29277e4f7b8db4f541d))
* **stt_daemon:** add whisper-cli subprocess backend ([04fa08b](https://github.com/Nowhitestar/Yulu/commit/04fa08bf822f93a12a2374aaabe6315c3a738475))
* **stt_daemon:** add yulu stt CLI (status/warm-up/logs/restart) + wrapper dispatch ([3faab03](https://github.com/Nowhitestar/Yulu/commit/3faab039324e91dd20034a64359f4d74bd4e7146))
* **stt_daemon:** channel-aware dispatch via WavLayout classification ([6d6028c](https://github.com/Nowhitestar/Yulu/commit/6d6028c0bffd445a2a255371170805434e6514fd))
* **stt_daemon:** per-channel RMS pre-check skips silent channel ([1d774b0](https://github.com/Nowhitestar/Yulu/commit/1d774b0b59c7f4d038a1208fd5b1c1b9d0d41580))
* **stt_daemon:** wire control server + app composition root + entry point ([5b45c52](https://github.com/Nowhitestar/Yulu/commit/5b45c52e978bcae0b1d2a62c6473e7d369acf928))
* **stt_daemon:** wire real backends in entry point + opt-in e2e suite ([9c4d022](https://github.com/Nowhitestar/Yulu/commit/9c4d022f8bae73346e7b3c8c7c23b5aaba4f8c75))
* **stt_daemon:** wire subscribe/unsubscribe handlers + partial broadcast + final emit ([bf5779d](https://github.com/Nowhitestar/Yulu/commit/bf5779dffd30bc4d9b2fce6a13f840c1066603fc))
* **stt:** support Hermes transcription provider ([a3c7c32](https://github.com/Nowhitestar/Yulu/commit/a3c7c32210efb3f1c371e7396dd172ae6d98691e))
* **transcribe:** add synchronous RPC client with retry-on-EOF ([7022ab2](https://github.com/Nowhitestar/Yulu/commit/7022ab24af13a9f29e0fd375ec66deb8da9ab58d))
* **transcribe:** channel-aware orchestrator writes mic/sys/merged transcripts ([4af84dc](https://github.com/Nowhitestar/Yulu/commit/4af84dc8bd13cd54d54feca5e5aab2535e85c3d0))
* **ui:** add liquid glass redesign ([ca9bb04](https://github.com/Nowhitestar/Yulu/commit/ca9bb0444ec0615b65ac4a872e4768cd5cbe7908))
* **ui:** apply Yulu brand system and streamline workflows ([#85](https://github.com/Nowhitestar/Yulu/issues/85)) ([5a07539](https://github.com/Nowhitestar/Yulu/commit/5a07539a83506beb2e1f91f0f23bd904b3f0b23e))
* **ui:** recordings reader — markdown summary, transcript dedup, rename/tags/delete, real status ([#44](https://github.com/Nowhitestar/Yulu/issues/44)) ([8aace30](https://github.com/Nowhitestar/Yulu/commit/8aace308188569a43054234ea6380348d51e366c))
* **uninstall:** pkill yulu_ui/dist/server.js leftover Node process ([6b397f8](https://github.com/Nowhitestar/Yulu/commit/6b397f818b75fb3f889e49488839a83a9739944c))
* use claude cli as summary fallback ([a7acd8c](https://github.com/Nowhitestar/Yulu/commit/a7acd8c823fb7d66dd69d416555c81c76cf2f121))
* **vocab:** add frozen seed snapshots + seeder ([19ee9da](https://github.com/Nowhitestar/Yulu/commit/19ee9dacf722d6a0ce2cf05b6321c23266d85a39))
* **vocab:** add VocabRepo with sqlite schema + CRUD ([da91e16](https://github.com/Nowhitestar/Yulu/commit/da91e1627fc3aa53bc596435cd3c5d45178cdbf0))
* **vocab:** add yulu vocab CLI (list/add/edit/remove/seed/export/import/reload) ([abe43a7](https://github.com/Nowhitestar/Yulu/commit/abe43a79b56faa31ee48f20864d3ee4cdbc3f224))
* **voicemail:** add get_voicemail (prefix match) + delete_voicemail ([7fb6cdb](https://github.com/Nowhitestar/Yulu/commit/7fb6cdbe024a615c6307c96af2c8a96e548ce554))
* **voicemail:** add post-stop _transcribe_and_enqueue pipeline ([9ff5482](https://github.com/Nowhitestar/Yulu/commit/9ff5482bca96fa79bcd51fd637763824b8387d6b))
* **voicemail:** add VoicemailRecord + list_voicemails (FS-as-DB) ([8e64e30](https://github.com/Nowhitestar/Yulu/commit/8e64e30a5875519c5843486db18f165d39edea04))
* **voicemail:** add yulu memo CLI (new/stop/list/show/delete/send) ([c9e6bd3](https://github.com/Nowhitestar/Yulu/commit/c9e6bd3cb50b063e5ca1a01e4827c1a5091f51f4))
* **voicemail:** cmd_new (blocking) + cmd_stop + audio_daemon output_dir field ([a6d3072](https://github.com/Nowhitestar/Yulu/commit/a6d307219807b1f90bb43309e43a5f33db816b25))
* **voicemail:** cmd_new starts realtime transcriber + promotes on stop ([c56ad35](https://github.com/Nowhitestar/Yulu/commit/c56ad353f067859c9dde5a67f3d485bcb4bc52ba))
* **voicemail:** promote realtime transcript with speaker-tag stripping ([17b258e](https://github.com/Nowhitestar/Yulu/commit/17b258ee2437707eebdc5648272d546090625465))
* **yulu cli:** logs ui (tail ui.log) + status block (curl healthz) ([0cf437e](https://github.com/Nowhitestar/Yulu/commit/0cf437ed48f6d32370bb0f9693e7677d7e023d73))
* **yulu_ui/backend:** JobRegistry + jobs pubsub channel + paths.scriptDir ([9989155](https://github.com/Nowhitestar/Yulu/commit/998915569b3595d1999172601b12a3f6f8250b9e))
* **yulu_ui/backend:** jobRunner — transcribe spawn, summarize queue/direct ([ff86c17](https://github.com/Nowhitestar/Yulu/commit/ff86c17650821abf001a27627e9b31531e17fe1f))
* **yulu_ui/routers:** unified recordings router (merge dirs + dispatch by stem) ([616c852](https://github.com/Nowhitestar/Yulu/commit/616c8520bc372a8c25383b350b343da5649e9930))
* **yulu_ui/routers:** voicemails+meetings transcribe/summarize mutations ([9988eb8](https://github.com/Nowhitestar/Yulu/commit/9988eb88c53202f009edf1933c149644da006928))
* **yulu_ui/tokens:** adopt canonical Ayu Light + Dark palette ([324ef73](https://github.com/Nowhitestar/Yulu/commit/324ef73cbb4ee0d3e7dc695fed84f82f5a546819))
* **yulu_ui/web:** App + RootLayout + providers tree (router child routes deferred to B.11) ([747cf9f](https://github.com/Nowhitestar/Yulu/commit/747cf9fdea578cb63bc3911bbe5d0d0ff5100e39))
* **yulu_ui/web:** AudioPlayer wavesurfer.js wrapper ([2dc6141](https://github.com/Nowhitestar/Yulu/commit/2dc614179e6b83922e6ee5c141097764326493a5))
* **yulu_ui/web:** CategoryChip (summary/cleanup/voicemail) ([9c8d0ef](https://github.com/Nowhitestar/Yulu/commit/9c8d0efd17895e3177c7bc3b3ea44914b8e7175e))
* **yulu_ui/web:** CommandEditor (string[] with drag-reorder + add/remove) ([12da2fc](https://github.com/Nowhitestar/Yulu/commit/12da2fcab84aafaa1bcdb235607aa69b53c3a786))
* **yulu_ui/web:** consolidated /health page (summary + Daemons/Logs tabs) ([758d9d3](https://github.com/Nowhitestar/Yulu/commit/758d9d3f94d26bdf12dce6c468cfc86fd202f58a))
* **yulu_ui/web:** consolidated /settings page (6 sections + anchor redirects) ([7d8a5a9](https://github.com/Nowhitestar/Yulu/commit/7d8a5a9211fbcbbc94801913fcc1d46c66bcbcf8))
* **yulu_ui/web:** converge routing to /inbox + /inbox/:stem; single Recordings sidebar entry ([3ad3c30](https://github.com/Nowhitestar/Yulu/commit/3ad3c307619c6550b0dfae98dd52614a14307633))
* **yulu_ui/web:** DaemonCard (status pill + meta + actions) ([65a746e](https://github.com/Nowhitestar/Yulu/commit/65a746ebc9fa5da951241b827e09d22401ca3875))
* **yulu_ui/web:** DbStatsRow with size/rows + optional action button ([3d16d90](https://github.com/Nowhitestar/Yulu/commit/3d16d9033ce45a4bdb8f854c10d5d7f37fab6d9d))
* **yulu_ui/web:** drag-resize sidebar + master-list columns ([867bae7](https://github.com/Nowhitestar/Yulu/commit/867bae7e3729e54f6df01e453523512468fd7129))
* **yulu_ui/web:** EditableTable base (click-to-edit cells) ([0ef0312](https://github.com/Nowhitestar/Yulu/commit/0ef03125c14c4a9c5ef137fa0e895ae8edd3695b))
* **yulu_ui/web:** EditableTable bulk select + delete with confirm ([798624c](https://github.com/Nowhitestar/Yulu/commit/798624c42411879ef03179584f59fac639fa2d76))
* **yulu_ui/web:** EmptyState component ([581e5c0](https://github.com/Nowhitestar/Yulu/commit/581e5c0a2ff58f3ec60b6121e5301d635dd29611))
* **yulu_ui/web:** FilterChips multi-select chip group ([ae2f71b](https://github.com/Nowhitestar/Yulu/commit/ae2f71b7fcf7c4d44c8b46d0dd9f4cfbbb2d06b9))
* **yulu_ui/web:** GlobalSearch popover (keyword only, ⌘K, ↑↓↵esc) ([388b83c](https://github.com/Nowhitestar/Yulu/commit/388b83c4a43218468defe6308025acbfc42f9132))
* **yulu_ui/web:** Glossary page (EditableTable + add + bulk delete) ([8c83b78](https://github.com/Nowhitestar/Yulu/commit/8c83b787f5046cdc53871c66ab31aaa737613693))
* **yulu_ui/web:** Health/Daemons page (grid of 8 cards + 5s polling) ([c2114fd](https://github.com/Nowhitestar/Yulu/commit/c2114fdbca97f1d5c7aa430a1089df5fa6b46b4f))
* **yulu_ui/web:** Health/Logs page (dropdown + LogTail + pause/clear) ([2e4c180](https://github.com/Nowhitestar/Yulu/commit/2e4c1805461d8560dcb61ad532177ca4c8207166))
* **yulu_ui/web:** HotkeyCapture component ([66bbea2](https://github.com/Nowhitestar/Yulu/commit/66bbea23b7269ed79e3ece09ffdc1eed12305b20))
* **yulu_ui/web:** InboxLayout with j/k keyboard nav across list ([7b1993c](https://github.com/Nowhitestar/Yulu/commit/7b1993c9bae882def85437255f65f3890fee5c98))
* **yulu_ui/web:** InlineEditRow (6 variants: text/number/select/toggle/path/readonly) ([b257767](https://github.com/Nowhitestar/Yulu/commit/b257767bacb745502a4eb68724fca59429646327))
* **yulu_ui/web:** integrate ReprocessButtons in Voicemail + Meeting readers ([3b1712d](https://github.com/Nowhitestar/Yulu/commit/3b1712dcff96d20ed6afb8f89d543f39752b586c))
* **yulu_ui/web:** Logo component (inline SVG matching assets/logo.svg) ([6837bb5](https://github.com/Nowhitestar/Yulu/commit/6837bb51b2a12d066be7a4fc3f27d56561a4d42a))
* **yulu_ui/web:** LogTail (auto-scroll + WS-driven append + 2000-line cap) ([db0ec00](https://github.com/Nowhitestar/Yulu/commit/db0ec00d7527850a3e907f8ad33a3a7529c332d1))
* **yulu_ui/web:** MasterDetail (220px list + outlet, inline skeleton) ([7bc78df](https://github.com/Nowhitestar/Yulu/commit/7bc78dfbe5dfd69aacd3cacabf7cb72de1653528))
* **yulu_ui/web:** MeetingReader with Realtime tab ([9836f9f](https://github.com/Nowhitestar/Yulu/commit/9836f9f310481232c611936cb1bc1baa853af70f))
* **yulu_ui/web:** Meetings filters (All/Summarized/Last 30d/Has realtime) ([e6558ce](https://github.com/Nowhitestar/Yulu/commit/e6558ce3b835449b65bf1f70ad9acc6411d46b6f))
* **yulu_ui/web:** Meetings list view with WS auto-refresh + index empty ([b4ac438](https://github.com/Nowhitestar/Yulu/commit/b4ac4384d2e5f00c8d04160443878260f3c92c68))
* **yulu_ui/web:** migrate emoji to lucide-react icons ([3bb2ee5](https://github.com/Nowhitestar/Yulu/commit/3bb2ee5804181db30c1202502c68cad41f59bf57))
* **yulu_ui/web:** Pill component (5-state machine, WS-driven) ([7d2ae36](https://github.com/Nowhitestar/Yulu/commit/7d2ae36f219145de987f4be49ee4dd9acdcb3bd1))
* **yulu_ui/web:** Placeholder component for phase route stubs ([0fea2c8](https://github.com/Nowhitestar/Yulu/commit/0fea2c84925593711c7882274a06990d2c50a425))
* **yulu_ui/web:** PromptReader (form with dirty tracking + Save/Delete) ([91d3040](https://github.com/Nowhitestar/Yulu/commit/91d304020c625887907488329e23ea23d7c6e4b1))
* **yulu_ui/web:** Prompts :id reader route (edit + create mode + delete) ([6824a62](https://github.com/Nowhitestar/Yulu/commit/6824a622fff52bc35df3308da942117e4cf8f2dc))
* **yulu_ui/web:** Prompts list with filters + new prompt button + index empty ([15fd8ae](https://github.com/Nowhitestar/Yulu/commit/15fd8ae5c804c123de0520a18456353e037cddcb))
* **yulu_ui/web:** RecordingReader — merged voicemail+meeting reader ([cc29b45](https://github.com/Nowhitestar/Yulu/commit/cc29b45add732b6f99310843f75ef7b38ff5c49a))
* **yulu_ui/web:** RecordingsList — unified /inbox list ([0645db8](https://github.com/Nowhitestar/Yulu/commit/0645db8fedbb001598e53002eca249644ff3619b))
* **yulu_ui/web:** ReprocessButton (4 visual states) ([b210a41](https://github.com/Nowhitestar/Yulu/commit/b210a4175c503f2a0c231ce1f2fccab1a67f27ea))
* **yulu_ui/web:** RestartBanner with per-daemon + restart-all actions ([7ddfbdc](https://github.com/Nowhitestar/Yulu/commit/7ddfbdc107deb8e977dc9af93ba03c42fa496453))
* **yulu_ui/web:** scaffold all 13 placeholder routes + child route registration ([0a3db7f](https://github.com/Nowhitestar/Yulu/commit/0a3db7f7c69538a596d15c3862fa37911d384a84))
* **yulu_ui/web:** Search filters (type/in dropdowns + since chips) ([fb4648e](https://github.com/Nowhitestar/Yulu/commit/fb4648e3f5c4fd7037d26b1fca096178d188dc99))
* **yulu_ui/web:** Search input + URL state + debounced query ([a67caf5](https://github.com/Nowhitestar/Yulu/commit/a67caf518d5e6a0077bbe88996eae32ed7d5aab4))
* **yulu_ui/web:** Search result row → /inbox/&lt;kind&gt;/:stem cross-nav ([15015c2](https://github.com/Nowhitestar/Yulu/commit/15015c2b3be21ecdf2f3c21c9f90d8b8d2fc8448))
* **yulu_ui/web:** Search results column with [hit] snippet rendering ([9a3662f](https://github.com/Nowhitestar/Yulu/commit/9a3662f457d4b2d9a6b10e87d8ef825347790f22))
* **yulu_ui/web:** Settings/Audio page with restart banner ([a2852a0](https://github.com/Nowhitestar/Yulu/commit/a2852a08da378304b80d1cd13ea65c07a0b9fbd9))
* **yulu_ui/web:** Settings/Hotkey & UI page (HotkeyCapture + ThemeToggle) ([3433d49](https://github.com/Nowhitestar/Yulu/commit/3433d49669c47f332debd991505006fc8b98965e))
* **yulu_ui/web:** Settings/Integrations page (calendar cards + Test connection) ([edbd351](https://github.com/Nowhitestar/Yulu/commit/edbd3510ff7cc9482525c9ee36d8ebc3ab8cbc6c))
* **yulu_ui/web:** Settings/LLM page (CommandEditor + Test popover) ([9578a89](https://github.com/Nowhitestar/Yulu/commit/9578a89e8eadcd58f348da34cc8c85a4918fa0c5))
* **yulu_ui/web:** Settings/Storage page (DbStatsRow + log paths) ([a703bd4](https://github.com/Nowhitestar/Yulu/commit/a703bd4be90af594efc0a312af5c2e1cbffebbbe))
* **yulu_ui/web:** Settings/Transcription page ([eb4e574](https://github.com/Nowhitestar/Yulu/commit/eb4e5744cb17d9013b142c9d8c8b5aac62a0ac71))
* **yulu_ui/web:** SettingsPage wrapper (banner + body) ([5480caf](https://github.com/Nowhitestar/Yulu/commit/5480cafe103b291ffc1289905524656731ffdae6))
* **yulu_ui/web:** Sidebar restructure — Logo + Inbox/Knowledge + bottom Settings/Health ([f4354e8](https://github.com/Nowhitestar/Yulu/commit/f4354e85830d908caacd20ec36b6692031838f33))
* **yulu_ui/web:** Sidebar with nav + count badges + ThemeToggle ([f830c5a](https://github.com/Nowhitestar/Yulu/commit/f830c5a4c9f5d93e225acd9c9ec6a140413237c1))
* **yulu_ui/web:** TestPopover for test command/connection output ([f6122a7](https://github.com/Nowhitestar/Yulu/commit/f6122a7992dcf6585f971c5a63bdcdb9f588e536))
* **yulu_ui/web:** ThemeProvider + useTheme + localStorage persist ([dde3b85](https://github.com/Nowhitestar/Yulu/commit/dde3b85089d6a18db19024d402f10317ae3389e9))
* **yulu_ui/web:** ThemeToggle segmented control ([31318a1](https://github.com/Nowhitestar/Yulu/commit/31318a1ab932196358feadec7b7cb3e96fcf64eb))
* **yulu_ui/web:** TopBar (breadcrumb + filters slot via route handle) ([bbc66cb](https://github.com/Nowhitestar/Yulu/commit/bbc66cb3ef693f21d088522707f7187bcf2ff61a))
* **yulu_ui/web:** TopBar multi-segment breadcrumb + GlobalSearch slot + ThemeToggle ([a7b017c](https://github.com/Nowhitestar/Yulu/commit/a7b017ce1ea7829e137f82d3ba7d0b04e7213972))
* **yulu_ui/web:** TranscriptView with vocab + speaker highlight ([0c30eb4](https://github.com/Nowhitestar/Yulu/commit/0c30eb437e48241d2b3acccf11efcbd67529598c))
* **yulu_ui/web:** tRPC client with shared AppRouter type ([ff9e6f6](https://github.com/Nowhitestar/Yulu/commit/ff9e6f6454ef6edc57817e74eb5c3d42c9324a02))
* **yulu_ui/web:** useConfirm hook (window.confirm wrapper) ([b1338a9](https://github.com/Nowhitestar/Yulu/commit/b1338a9e1e386411d2eb9fdc2c393532e4f9c478))
* **yulu_ui/web:** useDaemonHealthState aggregation hook ([9cea011](https://github.com/Nowhitestar/Yulu/commit/9cea011a23c691922e2acbfaded957c353226f6b))
* **yulu_ui/web:** useDebounced hook ([4d808c2](https://github.com/Nowhitestar/Yulu/commit/4d808c211952d82c1a1dd52e2567ac0e0b69df09))
* **yulu_ui/web:** useHotkeys hook (skips editable elements) ([b3f2199](https://github.com/Nowhitestar/Yulu/commit/b3f2199a3648f89bf068cc2070c5e67a9e89e3d2))
* **yulu_ui/web:** usePersistedSize + ResizableSplit ([2774959](https://github.com/Nowhitestar/Yulu/commit/27749599a65655e607d07b03c9cd30160bf89e6f))
* **yulu_ui/web:** useSettingsRestartTracker (daemons by key, reducer-based) ([887c8c4](https://github.com/Nowhitestar/Yulu/commit/887c8c45769fb5ce90c9dc24fa565fb86729cf0c))
* **yulu_ui/web:** VoicemailReader (:stem nested route + tabs + AudioPlayer) ([ca1a85a](https://github.com/Nowhitestar/Yulu/commit/ca1a85a26bf189a99f6ae80de9619761090a8a40))
* **yulu_ui/web:** Voicemails filters (All/Summarized/Last 7d) in list column ([308f0df](https://github.com/Nowhitestar/Yulu/commit/308f0dfb43740bdb5bdaf64140424f181c3c59ad))
* **yulu_ui/web:** Voicemails list view with WS auto-refresh + index empty ([f248cad](https://github.com/Nowhitestar/Yulu/commit/f248cad1630d1c82c74f59dc4fd368ddba324796))
* **yulu_ui/web:** voicemails URL state (?seek init + ?snippet scroll-to-match) ([11d5b59](https://github.com/Nowhitestar/Yulu/commit/11d5b59588f1f34b8fada0c577b8ab694ad25f7f))
* **yulu_ui/web:** WsProvider + useWsChannel + nextBackoff ([d0f6bd0](https://github.com/Nowhitestar/Yulu/commit/d0f6bd0e1d55fb8518956ff22d37b80731ae2f4e))
* **yulu_ui:** canonical paths module ([ec08306](https://github.com/Nowhitestar/Yulu/commit/ec08306809f9363bbf7a8879f467fd5255b2a016))
* **yulu_ui:** config router (get/update) ([d88eb1f](https://github.com/Nowhitestar/Yulu/commit/d88eb1f28db5b5ebd07cb83670928f3db7f5bd94))
* **yulu_ui:** ConfigManager with diff to daemon restart classification ([f17125c](https://github.com/Nowhitestar/Yulu/commit/f17125c8843da3de45bd69527957b7ca2782c3b8))
* **yulu_ui:** daemons router (health/restart/stop/start) ([8b18409](https://github.com/Nowhitestar/Yulu/commit/8b1840921b928ecd43a2331f0d5b7dacdfccb545))
* **yulu_ui:** esbuild single-file ESM bundle (with inlined version) ([2cc8fca](https://github.com/Nowhitestar/Yulu/commit/2cc8fca9cf65268dcd20a2842eae61442b9ecf3a))
* **yulu_ui:** glossary router (CRUD + auto-SIGHUP sttdaemon) ([6f1fbd7](https://github.com/Nowhitestar/Yulu/commit/6f1fbd75dc704f29160d094b6851e70ff6e2ee85))
* **yulu_ui:** inboxWatcher emits sidebar-counts on fs events ([337546c](https://github.com/Nowhitestar/Yulu/commit/337546c9c15e7adfa5e5d2cf258949fad931d223))
* **yulu_ui:** integrations.test router (Python detector probe) ([4656b70](https://github.com/Nowhitestar/Yulu/commit/4656b70cc9a8ccddd7f4815507e355743d888858))
* **yulu_ui:** ipcSend SHUT_WR client for unix sockets ([1bb7a87](https://github.com/Nowhitestar/Yulu/commit/1bb7a87677a39bbcaf78c55dd3079f1161a40442))
* **yulu_ui:** LaunchctlClient (restart/stop/start/status/sighup) ([f1e2f98](https://github.com/Nowhitestar/Yulu/commit/f1e2f9854c9ed1bd7c0cbdb9d9d9cda4af9bb9d0))
* **yulu_ui:** launchd plist template (com.yulu.ui) ([fe23d23](https://github.com/Nowhitestar/Yulu/commit/fe23d237533ab1eed73c7b3e963a466b2ccd5021))
* **yulu_ui:** llm.test router (spawn config.llm.command with stdin) ([a896b79](https://github.com/Nowhitestar/Yulu/commit/a896b79b11271c53769490783a5fbb48aab9815a))
* **yulu_ui:** logs router (tail-N) ([e9ef917](https://github.com/Nowhitestar/Yulu/commit/e9ef917ed6245a8d4ac65d2bc3dfbdaf5979ca9d))
* **yulu_ui:** logTailer publishes new log lines on logs WS channel ([5d85427](https://github.com/Nowhitestar/Yulu/commit/5d8542778d6a9a785143c3d873a6c4fccff4621c))
* **yulu_ui:** meetings router (excludes voicemails dir) ([2bd103e](https://github.com/Nowhitestar/Yulu/commit/2bd103e1f949c8ff7a0050dcbb2e932d548bb5f4))
* **yulu_ui:** merge 11 routers into appRouter ([d250759](https://github.com/Nowhitestar/Yulu/commit/d2507594afdceb2ce9a96d97961d3a793abad72b))
* **yulu_ui:** openDb factory (WAL, read-write) ([35a1a28](https://github.com/Nowhitestar/Yulu/commit/35a1a288429c21d15df5457731ac2d0609f1e902))
* **yulu_ui:** prompts router (CRUD + auto-SIGHUP agentqueue) ([7f6e92e](https://github.com/Nowhitestar/Yulu/commit/7f6e92ef15d40e0f9a43dcd26db1051d9122a03b))
* **yulu_ui:** recording router (state/toggle/open_inbox via status_agent.sock) ([a8b78ca](https://github.com/Nowhitestar/Yulu/commit/a8b78ca5efe86e25806ed9d69d538c0853ef1fb1))
* **yulu_ui:** search router shells out to python search.cli ([7a715f9](https://github.com/Nowhitestar/Yulu/commit/7a715f932a37fedf174ae2600ef7abe569fb9bd1))
* **yulu_ui:** server entry (Hono + tRPC + WS + audio file Range) ([4f64d8b](https://github.com/Nowhitestar/Yulu/commit/4f64d8bc38ae19a36a9facc4edfd45b0b77833eb))
* **yulu_ui:** serveStaticFile + SPA fallback + /assets/* on Node server ([97f072a](https://github.com/Nowhitestar/Yulu/commit/97f072a9936e49d34fabfe737cfe70bc80069202))
* **yulu_ui:** sidebar.counts (voicemails/meetings/prompts/glossary) ([0f36f41](https://github.com/Nowhitestar/Yulu/commit/0f36f4133f2d7e2691f7ba443c65d2e547f7b37a))
* **yulu_ui:** system router (version + uptime) ([2e1c549](https://github.com/Nowhitestar/Yulu/commit/2e1c54958135bef9762324e1b6e1e2900f4fbca3))
* **yulu_ui:** system.audioDevices via system_profiler JSON ([6dbd634](https://github.com/Nowhitestar/Yulu/commit/6dbd6346491d469eb148a7fdbc9dde8d649999be))
* **yulu_ui:** system.dbStats + system.logPaths ([b0e3592](https://github.com/Nowhitestar/Yulu/commit/b0e3592dfcaefe9920a21e3f03541747bb781533))
* **yulu_ui:** system.pickFile + system.openInFinder via osascript/open ([1bd5c61](https://github.com/Nowhitestar/Yulu/commit/1bd5c6117b9d9164d2a973138f37bc330b3703f8))
* **yulu_ui:** tRPC init with AppContext ([fbc37c4](https://github.com/Nowhitestar/Yulu/commit/fbc37c42ce2da50a36192063a1a2cab61d4812be))
* **yulu_ui:** typed PubSub for cross-cutting events ([a911e5b](https://github.com/Nowhitestar/Yulu/commit/a911e5ba1b970bc269ef3daade3f0c5ecc0017d1))
* **yulu_ui:** voicemails router (list/get/audioUrl/delete) ([6be2277](https://github.com/Nowhitestar/Yulu/commit/6be22771561f18d677336856dddcc35e9926817e))
* **yulu_ui:** voicemails.list/meetings.list return firstWords ([9b4c1ba](https://github.com/Nowhitestar/Yulu/commit/9b4c1ba84fb4448257c7223125495ea3400d0f7b))
* **yulu_ui:** WS multiplexer (single /ws + channel subscribe) ([f117505](https://github.com/Nowhitestar/Yulu/commit/f11750568f001eba0e3e88fb6a9b23121b659553))
* **yulu+setup:** dispatch 'status-agent' subcommand + install plist in setup.sh ([cf4897b](https://github.com/Nowhitestar/Yulu/commit/cf4897b09af48337ea72e164ca3b3616587e8854))
* **yulu:** dispatch 'memo' subcommand to voicemail.cli ([941c703](https://github.com/Nowhitestar/Yulu/commit/941c7039e0ad5d9667a9342f493154ddd759c5b4))
* **yulu:** dispatch 'prompts' and 'summaries' subcommands ([239039f](https://github.com/Nowhitestar/Yulu/commit/239039fa83d35757ec8f2ede82c92d3959b9d051))
* **yulu:** dispatch 'vocab' subcommand to python -m vocab.cli ([b40e051](https://github.com/Nowhitestar/Yulu/commit/b40e051af3f77bee73975de52c03951c301699ee))
* 切换点 0.5s 线性渐入/渐出防突兀 ([a92669b](https://github.com/Nowhitestar/Yulu/commit/a92669b60b76b6b5e59b60eb3ef002a91ab40e1a))
* 添加总结模板(summary_template.md)，已按格式生成验收测试纪要 ([caf02fa](https://github.com/Nowhitestar/Yulu/commit/caf02fa8bd522070373dc1ef34a1f91c499db0c0))


### Bug Fixes

* AEC 互相关对齐时间 + fallback summary 用模板结构 ([3967c47](https://github.com/Nowhitestar/Yulu/commit/3967c47797382440730b2116fdffeabb8714e2ae))
* **audio_daemon:** make start/stop synchronous; restart daemon on upgrade ([b826b3c](https://github.com/Nowhitestar/Yulu/commit/b826b3cf951f575f06ed80b2284193bbf5fdc891))
* **audio_daemon:** only hold SCStream while recording; tccutil reset on setup ([d459b39](https://github.com/Nowhitestar/Yulu/commit/d459b39e5a9969ff69be20b91ec4702ad0aa7fb4))
* **audio_daemon:** only hold SCStream while recording; tccutil reset on setup ([84022e9](https://github.com/Nowhitestar/Yulu/commit/84022e9b8620805b7b421b6fa76b05f2b5ce8a88))
* **audio_daemon:** re-arm silence monitor on every audio event ([5997a1e](https://github.com/Nowhitestar/Yulu/commit/5997a1e50daba4bb4876c68d139b766c44de0874))
* **audio_daemon:** rebuild binary with DualTrack marker ([a17b6cd](https://github.com/Nowhitestar/Yulu/commit/a17b6cdfe43ab0c02655009a1554f0d6c6ed9fe9))
* **audio_daemon:** rebuild binary with Phase 4 output_dir + silence_seconds ([7bc7e1a](https://github.com/Nowhitestar/Yulu/commit/7bc7e1a95f5bb1518e2d5afd8fe5c8679206012e))
* **audio_daemon:** synchronous start/stop + restart on upgrade fast-path ([52cc101](https://github.com/Nowhitestar/Yulu/commit/52cc1011cf5203e8d1dbadb153a70051b513c19f))
* **audio:** keep dual-track capture on a continuous timeline ([73be113](https://github.com/Nowhitestar/Yulu/commit/73be113e4f87b95fc5a8f63ee701be484b5bdb50))
* **audio:** restore meeting half-duplex playback mix ([dba4723](https://github.com/Nowhitestar/Yulu/commit/dba47235a57b536b3fb605110e4b4730c4136e76))
* **audio:** self-heal stuck sys-tap so meetings start after a voicemail ([#43](https://github.com/Nowhitestar/Yulu/issues/43)) ([9aff28f](https://github.com/Nowhitestar/Yulu/commit/9aff28f20b0c4d247a587c23a7e2c86859486adc))
* **audio:** serialize recorder state ([edda3c0](https://github.com/Nowhitestar/Yulu/commit/edda3c061042eadce568f56c372d72baab2cca16))
* AVFoundation 数据率问题 - 添加 aresample=async=1000 ([73628b3](https://github.com/Nowhitestar/Yulu/commit/73628b396157ed83a583ca3f8570db380b987dee))
* avoid false detector validation warning ([96618bc](https://github.com/Nowhitestar/Yulu/commit/96618bcccf5edd9325ef36adee685336acd7f9c9))
* config keywords missing, audio devices swapped, log duplication ([ee5d99b](https://github.com/Nowhitestar/Yulu/commit/ee5d99bc20ba2e0c722a6cd11c645d75aa3e1485))
* **diarize:** count-keyed pipeline cache so per-call override can't bleed into auto ([d2a6214](https://github.com/Nowhitestar/Yulu/commit/d2a6214e89ab94e7932a740b9aa6ccc68018293c))
* **diarize:** install soundfile with sherpa runtime ([5abfced](https://github.com/Nowhitestar/Yulu/commit/5abfced7e7337b8a8c70f53ff5a202efb59e6008))
* **diarize:** tighten calendar speaker priors ([9635113](https://github.com/Nowhitestar/Yulu/commit/96351132a90286d6fba6709f019721d840db9e98))
* generate usable summary without agent placeholder ([ad22b1f](https://github.com/Nowhitestar/Yulu/commit/ad22b1fb8dd11a15a1e5e727d49e991e92b98890))
* harden dual-track post processing ([6df4d62](https://github.com/Nowhitestar/Yulu/commit/6df4d628e65e7b1c73d61ea7f1e7303a75d59ae3))
* harden recording and release status fixes ([5365dbe](https://github.com/Nowhitestar/Yulu/commit/5365dbe425d96f803699ec23e9b5abd2bb296292))
* improve echo cleanup and settings refresh ([11ee3b7](https://github.com/Nowhitestar/Yulu/commit/11ee3b7e6e8feaab548e1e4058e464e72f822a40))
* **install.sh:** handle "/dev/tty: Device not configured" ([b5351f9](https://github.com/Nowhitestar/Yulu/commit/b5351f9faadef8110ffe82254f0e59e5364569e1))
* **install.sh:** handle /dev/tty: Device not configured ([75eac7b](https://github.com/Nowhitestar/Yulu/commit/75eac7b9872bf3ad3f6c5975ec0a43831adefd2a))
* **install:** add agent-native install and uninstall plans ([#61](https://github.com/Nowhitestar/Yulu/issues/61)) ([c4fb18a](https://github.com/Nowhitestar/Yulu/commit/c4fb18a64e95212a2366cdf6c4cae199daed22c5))
* **installer:** align runtime dependency checks ([#91](https://github.com/Nowhitestar/Yulu/issues/91)) ([a8a7a7d](https://github.com/Nowhitestar/Yulu/commit/a8a7a7db04d6dc427ad5575051f301c306c2f4bc))
* keep calendar schedule resilient ([264bde4](https://github.com/Nowhitestar/Yulu/commit/264bde47c94c74ecb63feda1be6601ee1103a22d))
* keep realtime chunks out of recordings ([33f1ce5](https://github.com/Nowhitestar/Yulu/commit/33f1ce5c3a5f30247c81d07ac0515be8026760b4))
* make meeting recording crash-resilient ([085d6a8](https://github.com/Nowhitestar/Yulu/commit/085d6a8f76370b2aaa5a9cadece58a69554af2b1))
* make realtime transcription robust for arbitrarily-long recordings ([#42](https://github.com/Nowhitestar/Yulu/issues/42)) ([f05e641](https://github.com/Nowhitestar/Yulu/commit/f05e6418c4c963c526e6e494166eab49c126a4d1))
* meeting_daemon.py ask_record with daemon backend ([825923a](https://github.com/Nowhitestar/Yulu/commit/825923a17cd77ae6fe6efca300ec53dc2894f156))
* play original recording audio by default ([d549fd8](https://github.com/Nowhitestar/Yulu/commit/d549fd8be221085ea22efd0e1547a34f369b5c1d))
* preserve recording permissions on upgrade ([88e46f9](https://github.com/Nowhitestar/Yulu/commit/88e46f93e5e7c53e059df653ba1c7c607f702cfd))
* prevent pkg installer postinstall hangs ([990fb14](https://github.com/Nowhitestar/Yulu/commit/990fb14acc96a3be74f3d370b80e9450df994001))
* recognize release installs in doctor ([2bd3173](https://github.com/Nowhitestar/Yulu/commit/2bd31730252cee48737d398d36f29428dd098cff))
* **recording_lock:** defer to daemon for recording-lifetime exclusion ([a8650ee](https://github.com/Nowhitestar/Yulu/commit/a8650eeb2f82128fb515a8c32f92af2831a855a5))
* **recording:** resume interrupted captures and clean playback ([501d12f](https://github.com/Nowhitestar/Yulu/commit/501d12f365b47449586a10c1ec8820ff556098a0))
* recover recording reprocess flows ([dcad5d4](https://github.com/Nowhitestar/Yulu/commit/dcad5d42d44e243a403ca128b0e0c4f02f582437))
* reinstall incomplete ui dependencies ([fe0fbcd](https://github.com/Nowhitestar/Yulu/commit/fe0fbcd4c2fd75c9fe889f14e3d76be9508ef006))
* **release:** grant tag publish attestation permissions ([0ade731](https://github.com/Nowhitestar/Yulu/commit/0ade7314d0406dc89be49722c1ed711ee6430b5b))
* repair 10 fresh-user-facing bugs in the v0.6.0 release ([#41](https://github.com/Nowhitestar/Yulu/issues/41)) ([53fa35c](https://github.com/Nowhitestar/Yulu/commit/53fa35cbf725cbd68805ab196379f6b3ead27e5a))
* replace osascript with compiled window_scanner for window detection ([4b98a1b](https://github.com/Nowhitestar/Yulu/commit/4b98a1b0e8332400633d258015e96f081db643af))
* restore exec bits on release extract; harden setup & packaging ([#31](https://github.com/Nowhitestar/Yulu/issues/31)) ([82b0ab2](https://github.com/Nowhitestar/Yulu/commit/82b0ab26ed4c893dd0e8578bd254f8ef918b4c25))
* revert unstable AudioBufferList capture path ([c58991a](https://github.com/Nowhitestar/Yulu/commit/c58991ae2c121aa1af30a1daae843d70bffcf0fb))
* route final summaries through OpenClaw agent ([dd6c606](https://github.com/Nowhitestar/Yulu/commit/dd6c606e263888d1ecca83e57f47e5fddeace121))
* ScreenCaptureKit audio capture working on macOS 26 ([4604b6a](https://github.com/Nowhitestar/Yulu/commit/4604b6a146b8f1d54a398448f81c3651f172b3b5))
* SCStream Float32 audio + streaming buffer mixing ([b60ab98](https://github.com/Nowhitestar/Yulu/commit/b60ab98fbadda1eab403b0d8e9dd9bce02704624))
* **search:** IPC helper honors YULU_SCRIPT_DIR for PR-branch installs ([7f737d2](https://github.com/Nowhitestar/Yulu/commit/7f737d2e121f4b7485f4f0a88ff04368b105e1fb))
* ship realtime recording and installer updates ([76b4b6a](https://github.com/Nowhitestar/Yulu/commit/76b4b6a77b5f66663838368c75a2e67a4cf9b379))
* sign AudioDaemon with fixed codesign identity ([feedf92](https://github.com/Nowhitestar/Yulu/commit/feedf9284d5063bad256a7c86b11f54271d15b82))
* stabilize meeting-detector signature; persistent record dialog ([#35](https://github.com/Nowhitestar/Yulu/issues/35)) ([61ed4a9](https://github.com/Nowhitestar/Yulu/commit/61ed4a93891b45e005c107bf3b432d2d6eae4882))
* stabilize recording and summaries ([acda808](https://github.com/Nowhitestar/Yulu/commit/acda80821c9ae0fe591e1624bce152d2d3177aa0))
* stabilize recording workflow ([0468e95](https://github.com/Nowhitestar/Yulu/commit/0468e9541b28373bddd151b71a67074daddbcd0b))
* **status_agent:** add CFBundleExecutable + retain SIGHUP DispatchSource ([d2ef61c](https://github.com/Nowhitestar/Yulu/commit/d2ef61ce00190168f4fc0c30c7e6b5d29408519e))
* **status_agent:** SHUT_WR framing + voicemail wav stem classifier ([9e4b4ce](https://github.com/Nowhitestar/Yulu/commit/9e4b4cec2d3ef0676b5259fb36168957f37ea421))
* **status_agent:** unwrap Data? cleanly (drop dead ?? Data() coalesce) ([85acacb](https://github.com/Nowhitestar/Yulu/commit/85acacb6355392b848261de4bf776feec0348923))
* **stt_daemon:** auto-stride dual-track WAVs in live_session ([399fd82](https://github.com/Nowhitestar/Yulu/commit/399fd8267831419d6ffa3519b73e936bfbc71d51))
* **stt_daemon:** clean SIGTERM exit via stopped_event ([6dcee12](https://github.com/Nowhitestar/Yulu/commit/6dcee12e1edcdfc5e1570ab0f1b8b7a1e17d1648))
* **stt_daemon:** dual-track cancel fanout + classify error path + temp-file leak ([4419dec](https://github.com/Nowhitestar/Yulu/commit/4419decf21f5726948277861a94bf656d6ca5c1c))
* **stt_daemon:** make VocabCache._mtime track max(main, wal) to avoid reload thrash ([b46fe67](https://github.com/Nowhitestar/Yulu/commit/b46fe67f7c7bfebd014893d512eff80f152f0089))
* **stt:** use calendar attendees for speaker names ([51d095e](https://github.com/Nowhitestar/Yulu/commit/51d095ed7adb4947925b060c5370c878e6e6ce14))
* suppress delayed dual-track playback echo ([5747b3c](https://github.com/Nowhitestar/Yulu/commit/5747b3ca5e7e0f7974d351b06a3ab4847409f80e))
* **test:** correct test_list_filters scope assertions ([4466a52](https://github.com/Nowhitestar/Yulu/commit/4466a52a50ef1105dc4f846e871438132a346e66))
* **transcription:** reuse live transcripts and glossary for summaries ([c7e7738](https://github.com/Nowhitestar/Yulu/commit/c7e7738bede80fa13290bb124ac2db78305f83f7))
* **ui:** improve mobile responsive layouts ([c7286f5](https://github.com/Nowhitestar/Yulu/commit/c7286f55e5b9356a7a4dc1fd70721376a1c42e23))
* **ui:** keep recorder window in saving state after stop ([a98ed47](https://github.com/Nowhitestar/Yulu/commit/a98ed47f86220769a2446064015e16d8090826d9))
* **ui:** preserve settings array drafts ([f4823c9](https://github.com/Nowhitestar/Yulu/commit/f4823c9eefb3f43ac9a83e23f86383e9ddd918ff))
* **voicemail:** clean filename + properly catch RecordingBusy at __enter__ ([9a4a14b](https://github.com/Nowhitestar/Yulu/commit/9a4a14b64908df09de02123dd069a3dedade3a26))
* **wav_inspect:** guard truncated LIST + tighten truncated-file test + document writer contract ([acf7a24](https://github.com/Nowhitestar/Yulu/commit/acf7a248181d863385d64dfd24f9e86bff963afd))
* **yulu_ui/logTailer:** survive logrotate rotation (reopen on inode change) ([fa90c6c](https://github.com/Nowhitestar/Yulu/commit/fa90c6c4191c52c70483708de974688564cc7d98))
* **yulu_ui/web:** AudioPlayer A→B→A playback regression ([4a8e79c](https://github.com/Nowhitestar/Yulu/commit/4a8e79c89e40ceee68fa1676a3e5771aaa6e5405))
* **yulu_ui/web:** clear pending reconnect timer in ensureOpen + type cleanup ([595865b](https://github.com/Nowhitestar/Yulu/commit/595865bc2a4ecd64897b035b6dfcc2b69e96f898))
* **yulu_ui:** use app.notFound for SPA fallback (matches multi-segment paths) ([83e48aa](https://github.com/Nowhitestar/Yulu/commit/83e48aab1f7cac73cdf6cc006cf910f181706716))
* 半双工交叉混合（渐入逻辑正确版） ([b1befc6](https://github.com/Nowhitestar/Yulu/commit/b1befc63afd3bd70c5c2d9ef6b2a744f45f5709d))
* 半双工变量名残留导致脚本崩溃（文件写不出来） ([f08f2b8](https://github.com/Nowhitestar/Yulu/commit/f08f2b82f13e8e3cc86eaded4e9be07eea4193b7))
* 双路 SoX + SwitchAudioSource 分别录 BlackHole 和麦克风 ([57f0d51](https://github.com/Nowhitestar/Yulu/commit/57f0d51fd87a430d80d82b6faffdc46359e122d0))
* 双路 SoX 通过 SwitchAudioSource 切换设备输入 ([8a4e80a](https://github.com/Nowhitestar/Yulu/commit/8a4e80aa662b27f28d7d5cb96fb2e0b414068bd3))
* 合并时 mic 通道加高通向(200Hz)去回声 + 权重调整 ([6fdb6d1](https://github.com/Nowhitestar/Yulu/commit/6fdb6d12db63f779a5cb889c70693b2b2c528e0a))
* 录音加速问题 - 分两个 ffmpeg 进程分别录制再合并 ([f1747be](https://github.com/Nowhitestar/Yulu/commit/f1747be1971fb2665ecab0e00a52fb748fbf7ed0))
* 改用 NLMS 回声消除 + filter_len=1024 + 最小延迟阈值 ([de4773f](https://github.com/Nowhitestar/Yulu/commit/de4773f288d95c525ba9e7f453a90ad85f3dc41d))
* 用 SoX (CoreAudio) 替换 ffmpeg AVFoundation 录制 ([d5ce056](https://github.com/Nowhitestar/Yulu/commit/d5ce056378bc56328147e0653ebf1ab688361b0d))
* 简化双 SoX 方案+合并时 dynaudnorm 音量归一化 ([15dcc90](https://github.com/Nowhitestar/Yulu/commit/15dcc9073cd352129c5e2c5c1bf1d93b4142cd9b))


### Code Refactoring

* rename AudioDaemon.app bundle to Yulu.app ([a9d6ba1](https://github.com/Nowhitestar/Yulu/commit/a9d6ba1fd064ec6a8ece249a7cc1c161bbb85058))
* rename project meeting-assistant → Yulu ([a570bb1](https://github.com/Nowhitestar/Yulu/commit/a570bb169578197b77cd7495b8e5ae58b59721ad))

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
